/**
 * 监控池管理器 (TokenMonitor)
 * 
 * 职责:
 * - 接收新代币(手动/webhook)
 * - 入池前过滤
 * - 容量管理 + 多因子淘汰
 * - 状态监控(FDV/LP预警与强制退出)
 * - 与 Helius 订阅协同
 */
import { EventEmitter } from 'events';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { db } from '../db';
import { birdeyeService } from '../services/birdeye';
import { heliusService } from '../services/helius';
import { volumeAggregator } from './volume-aggregator';
import { MonitoredToken, AddSource, TokenStatus, WebhookPayload } from '../types';

const log = getLogger('TokenMonitor');

interface AddTokenInput {
  address: string;
  symbol?: string;
  via: AddSource;
  sourceDetail?: string;
}

interface AddTokenResult {
  success: boolean;
  reason?: string;
  token?: MonitoredToken;
}

export class TokenMonitor extends EventEmitter {
  private tokens = new Map<string, MonitoredToken>();
  private updateInterval: NodeJS.Timeout | null = null;
  
  async start(): Promise<void> {
    // 从 DB 加载现有监控池
    const stored = db.getAllMonitoredTokens();
    for (const t of stored) {
      this.tokens.set(t.address, t);
      volumeAggregator.trackToken(t.address);
      
      // 重新订阅池子
      if (t.pool?.address) {
        try {
          await heliusService.subscribePool(t.pool.address, t.address);
        } catch (err: any) {
          log.warn('Failed to resubscribe pool on startup', { 
            address: t.address, error: err.message,
          });
        }
      }
    }
    
    log.info('TokenMonitor started', { loadedTokens: this.tokens.size });
    
    // 每60秒更新所有代币状态
    this.updateInterval = setInterval(() => this.updateAllTokens(), 60 * 1000);
    
    // 立即跑一次
    setTimeout(() => this.updateAllTokens(), 5000);
  }
  
  stop(): void {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }
  
  /**
   * 解析代币的symbol和name (多源fallback)
   * 优先级: Birdeye Overview > Birdeye Metadata > 链上Metaplex > Webhook payload > 占位
   * 
   * @param address 代币地址
   * @param marketData Birdeye Overview返回的市场数据(可选)
   * @param hintSymbol Webhook/手动提供的symbol(作为参考,但不优先采用)
   */
  private async resolveTokenIdentity(
    address: string,
    marketData: { symbol?: string } | null,
    hintSymbol?: string,
  ): Promise<{ symbol: string; name: string; decimals: number; source: string }> {
    // 1. Birdeye overview 已返回的 symbol (最常见情况)
    if (marketData?.symbol && this.isValidSymbol(marketData.symbol)) {
      // overview不返回decimals, 这里decimals保持默认,后续会从链上更新
      return { 
        symbol: marketData.symbol.trim(), 
        name: '',
        decimals: 9,
        source: 'birdeye_overview',
      };
    }
    
    // 2. Birdeye metadata 接口 (overview失败时)
    try {
      const meta = await birdeyeService.getTokenMetadata(address);
      if (meta && this.isValidSymbol(meta.symbol)) {
        return {
          symbol: meta.symbol.trim(),
          name: meta.name,
          decimals: meta.decimals,
          source: 'birdeye_metadata',
        };
      }
    } catch (err: any) {
      log.debug('Birdeye metadata fallback failed', { address, error: err.message });
    }
    
    // 3. 链上 Metaplex metadata (最权威但慢)
    try {
      const onchain = await heliusService.getTokenMetadataOnChain(address);
      if (onchain && this.isValidSymbol(onchain.symbol)) {
        return {
          symbol: onchain.symbol.trim(),
          name: onchain.name,
          decimals: onchain.decimals,
          source: 'onchain',
        };
      }
      // 即使symbol拿不到,decimals通常能拿到
      if (onchain?.decimals) {
        return {
          symbol: hintSymbol && this.isValidSymbol(hintSymbol) 
            ? hintSymbol 
            : `TOKEN_${address.slice(0, 6)}`,
          name: onchain.name || '',
          decimals: onchain.decimals,
          source: hintSymbol ? 'webhook_hint' : 'placeholder',
        };
      }
    } catch (err: any) {
      log.debug('Onchain metadata fallback failed', { address, error: err.message });
    }
    
    // 4. Webhook 提供的 hint (作为最后手段)
    if (hintSymbol && this.isValidSymbol(hintSymbol)) {
      return {
        symbol: hintSymbol.trim(),
        name: '',
        decimals: 9,
        source: 'webhook_hint',
      };
    }
    
    // 5. 占位符 (最坏情况)
    return {
      symbol: `TOKEN_${address.slice(0, 6)}`,
      name: '',
      decimals: 9,
      source: 'placeholder',
    };
  }
  
  /**
   * 判断symbol是否有效(过滤"UNKNOWN"等无意义值)
   */
  private isValidSymbol(symbol: string | undefined | null): boolean {
    if (!symbol) return false;
    const s = symbol.trim().toUpperCase();
    if (s.length === 0 || s.length > 20) return false;
    
    // 黑名单: 明显的占位符
    const invalidValues = ['UNKNOWN', 'UNDEFINED', 'NULL', 'NONE', 'N/A', '?', '-'];
    if (invalidValues.includes(s)) return false;
    
    return true;
  }
  
  /**
   * 添加代币(主入口)
   */
  async addToken(input: AddTokenInput): Promise<AddTokenResult> {
    const { address, via, sourceDetail } = input;
    let { symbol } = input;
    
    log.info('Attempting to add token', { address, hintSymbol: symbol, via });
    
    // 1. 检查是否已在监控池
    if (this.tokens.has(address)) {
      return { success: false, reason: 'already_monitored' };
    }
    
    // 2. 检查冷却期
    if (db.isInCooldown(address)) {
      return { success: false, reason: 'in_cooldown' };
    }
    
    // 3. 入池前快速验证(调 Birdeye)
    const fullInfo = await birdeyeService.getTokenFullInfo(address);
    if (!fullInfo.market) {
      return { success: false, reason: 'token_data_unavailable' };
    }
    
    const market = fullInfo.market;
    const security = fullInfo.security;
    
    // 验证条件
    if (market.liquidity < config.minLpUsd) {
      return { success: false, reason: `LP too low: $${market.liquidity.toFixed(0)}` };
    }
    if (market.volume24h < config.minVolume24hUsd) {
      return { success: false, reason: `Volume too low: $${market.volume24h.toFixed(0)}` };
    }
    if (market.holders < config.minHolders) {
      return { success: false, reason: `Holders too few: ${market.holders}` };
    }
    
    // 集中度判定: 用 top10UserPercent (仅真实用户,排除LP池子和合约)
    // 这样不会误伤"LP占比高的健康币"
    // 同时记录 top10HolderPercent (含一切持有者) 作为参考日志
    const top10UserPct = security?.top10UserPercent !== undefined 
      ? security.top10UserPercent * 100 
      : null;
    const top10HolderPct = security?.top10HolderPercent !== undefined
      ? security.top10HolderPercent * 100
      : null;
    
    if (top10UserPct !== null && top10UserPct > config.maxTop10Percent) {
      return { 
        success: false, 
        reason: `Top10 users too concentrated: ${top10UserPct.toFixed(1)}% (holders incl LP: ${top10HolderPct?.toFixed(1) ?? 'N/A'}%)`,
      };
    }
    
    // 如果 top10UserPercent 数据缺失, fallback 到 top10HolderPercent + 宽松一些的阈值
    // (因为 holder 含LP, 阈值需要相应放宽)
    if (top10UserPct === null && top10HolderPct !== null) {
      const fallbackThreshold = config.maxTop10Percent + 20;  // +20% 缓冲
      if (top10HolderPct > fallbackThreshold) {
        return {
          success: false,
          reason: `Top10 holders too concentrated: ${top10HolderPct.toFixed(1)}% (no user data, fallback threshold ${fallbackThreshold}%)`,
        };
      }
    }
    
    if (security?.freezeable) {
      return { success: false, reason: 'token_freezable' };
    }
    
    // 4. 容量检查与淘汰
    if (this.tokens.size >= config.maxMonitoredTokens) {
      const evicted = await this.evictLowestScore();
      if (!evicted) {
        return { success: false, reason: 'pool_full_no_evictable' };
      }
    }
    
    // 5. 解析代币身份(symbol/name/decimals,多源fallback)
    const identity = await this.resolveTokenIdentity(address, market, symbol);
    log.info('Token identity resolved', {
      address: address.slice(0, 8) + '...',
      symbol: identity.symbol,
      source: identity.source,
    });
    
    // 6. 构造监控对象
    const now = Date.now();
    const token: MonitoredToken = {
      address: market.address,
      symbol: identity.symbol,
      name: identity.name || undefined,
      decimals: identity.decimals,
      pool: fullInfo.pools[0],
      addedAt: now,
      addedVia: via,
      sourceDetail,
      protectionUntil: now + config.protectionPeriodMinutes * 60 * 1000,
      status: 'protected',
      hasPosition: false,
      lastFdv: market.fdv,
      lastLiquidity: market.liquidity,
      lastVolume24h: market.volume24h,
      lastHolders: market.holders,
      lastPrice: market.price,
      lastUpdated: now,
      holderTrend: [market.holders],
      scoreHistory: [],
      currentScore: 50,
      listedAt: market.createdAt || now,
    };
    
    // 6. 保存到 DB 和内存
    db.upsertMonitoredToken(token);
    db.addLifecycleEntry(token);
    this.tokens.set(address, token);
    
    // 7. 注册量能聚合器
    volumeAggregator.trackToken(address);
    
    // 8. 订阅池子
    if (token.pool?.address) {
      try {
        await heliusService.subscribePool(token.pool.address, address);
      } catch (err: any) {
        log.error('Failed to subscribe pool', { address, error: err.message });
      }
    }
    
    log.info('Token added to monitoring', {
      address: address.slice(0, 8) + '...',
      symbol: token.symbol,
      via,
      poolType: token.pool?.type,
      fdv: market.fdv,
      lp: market.liquidity,
    });
    
    this.emit('token_added', token);
    return { success: true, token };
  }
  
  /**
   * 处理 webhook payload
   */
  async handleWebhook(payload: WebhookPayload): Promise<AddTokenResult> {
    if (payload.network !== 'solana') {
      return { success: false, reason: 'unsupported_network' };
    }
    
    return this.addToken({
      address: payload.address,
      symbol: payload.symbol,
      via: 'webhook',
      sourceDetail: payload.source ?? payload.context ?? 'webhook',
    });
  }
  
  /**
   * 移除代币
   */
  async removeToken(address: string, reason: string): Promise<boolean> {
    const token = this.tokens.get(address);
    if (!token) return false;
    
    // 如果有持仓,先发出退出信号(由TradingEngine处理)
    if (token.hasPosition) {
      log.warn('Token has position, emitting force_exit signal', { address, symbol: token.symbol });
      this.emit('force_exit', { token, reason });
      // 等待持仓清算完成,这里先标记 exiting
      token.status = 'exiting';
      db.upsertMonitoredToken(token);
      return false;  // 实际移除由 TradingEngine 完成卖出后调用
    }
    
    // 取消订阅
    if (token.pool?.address) {
      await heliusService.unsubscribePool(token.pool.address);
    }
    
    // 取消量能追踪
    volumeAggregator.untrackToken(address);
    
    // 加入冷却期
    const cooldownUntil = Date.now() + config.cooldownPeriodHours * 3600 * 1000;
    db.addCooldown(address, cooldownUntil, reason);
    
    // 从 DB 移除
    db.removeMonitoredToken(address, reason);
    this.tokens.delete(address);
    
    log.info('Token removed', { address, symbol: token.symbol, reason });
    this.emit('token_removed', { token, reason });
    return true;
  }
  
  /**
   * 更新所有代币状态
   */
  private async updateAllTokens(): Promise<void> {
    const tokenList = Array.from(this.tokens.values());
    log.debug('Updating all tokens', { count: tokenList.length });
    
    // 分批处理,避免突发大量API调用
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 1000;
    
    for (let i = 0; i < tokenList.length; i += BATCH_SIZE) {
      const batch = tokenList.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(t => this.updateOneToken(t).catch(err => {
        log.error('updateOneToken failed', { address: t.address, error: err.message });
      })));
      
      if (i + BATCH_SIZE < tokenList.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }
  }
  
  private async updateOneToken(token: MonitoredToken): Promise<void> {
    const market = await birdeyeService.getTokenOverview(token.address);
    if (!market) return;
    
    // 修复无效的symbol(已存在的"UNKNOWN"等占位符也能被修复)
    if (!this.isValidSymbol(token.symbol) || token.symbol.startsWith('TOKEN_')) {
      // 如果Birdeye返回了有效symbol,优先用
      if (this.isValidSymbol(market.symbol)) {
        log.info('Token symbol updated', {
          address: token.address.slice(0, 8) + '...',
          oldSymbol: token.symbol,
          newSymbol: market.symbol,
        });
        token.symbol = market.symbol.trim();
      } else {
        // 否则尝试链上fallback
        try {
          const onchain = await heliusService.getTokenMetadataOnChain(token.address);
          if (onchain && this.isValidSymbol(onchain.symbol)) {
            log.info('Token symbol updated from on-chain', {
              address: token.address.slice(0, 8) + '...',
              oldSymbol: token.symbol,
              newSymbol: onchain.symbol,
            });
            token.symbol = onchain.symbol.trim();
            if (onchain.name) token.name = onchain.name;
            if (onchain.decimals) token.decimals = onchain.decimals;
          }
        } catch (err: any) {
          // 静默失败,下次更新再试
          log.debug('On-chain symbol fix failed', { error: err.message });
        }
      }
    }
    
    // 更新数据
    token.lastFdv = market.fdv;
    token.lastLiquidity = market.liquidity;
    token.lastVolume24h = market.volume24h;
    token.lastHolders = market.holders;
    token.lastPrice = market.price;
    token.lastUpdated = Date.now();
    
    // 更新holder趋势(保留最近24个数据点)
    token.holderTrend.push(market.holders);
    if (token.holderTrend.length > 24) token.holderTrend.shift();
    
    // 解除保护期
    if (token.status === 'protected' && Date.now() > token.protectionUntil) {
      token.status = 'active';
      log.debug('Token exited protection period', { 
        address: token.address.slice(0, 8), symbol: token.symbol,
      });
    }
    
    // 检查强制退出
    if (market.fdv < config.forceExitFdvUsd || market.liquidity < config.forceExitLpUsd) {
      log.warn('Token hit force exit threshold', {
        symbol: token.symbol,
        fdv: market.fdv,
        liquidity: market.liquidity,
      });
      const reason = market.fdv < config.forceExitFdvUsd ? 'force_exit_fdv' : 'force_exit_lp';
      await this.removeToken(token.address, reason);
      return;
    }
    
    // 检查预警
    if (market.fdv < config.warningFdvUsd || market.liquidity < config.warningLpUsd) {
      if (token.status !== 'warning' && token.status !== 'exiting') {
        token.status = 'warning';
        log.warn('Token entered warning state', {
          symbol: token.symbol,
          fdv: market.fdv,
          liquidity: market.liquidity,
        });
        this.emit('token_warning', token);
      }
    } else if (token.status === 'warning') {
      // 恢复正常
      token.status = 'active';
    }
    
    // 计算综合评分
    token.currentScore = this.calculateScore(token);
    token.scoreHistory.push(token.currentScore);
    if (token.scoreHistory.length > 24) token.scoreHistory.shift();
    
    // 持久化
    db.upsertMonitoredToken(token);
  }
  
  /**
   * 多因子综合评分(用于淘汰排序)
   * 评分越高 = 越值得保留
   */
  private calculateScore(token: MonitoredToken): number {
    // Volume 维度 (40%)
    const volumeScore = Math.min(100, (token.lastVolume24h / 500000) * 100);
    
    // Holder 趋势 (25%)
    let holderTrendScore = 50;
    if (token.holderTrend.length >= 3) {
      const recent = token.holderTrend.slice(-3);
      const earlier = token.holderTrend.slice(-6, -3);
      if (earlier.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
        const growth = (recentAvg - earlierAvg) / earlierAvg;
        holderTrendScore = 50 + Math.min(50, Math.max(-50, growth * 200));
      }
    }
    
    // 距上线时间 (15%) - 越接近30天越倾向淘汰
    const ageDays = (Date.now() - token.listedAt) / (24 * 3600 * 1000);
    const ageScore = Math.max(0, 100 - (ageDays / 30) * 100);
    
    // 最近活跃度 (20%)
    const stats = volumeAggregator.getRecentSnapshot(token.address, 30);
    const activityScore = stats 
      ? Math.min(100, (stats.buyCount + stats.sellCount) * 2) 
      : 30;
    
    return Math.round(
      volumeScore * 0.4 +
      holderTrendScore * 0.25 +
      ageScore * 0.15 +
      activityScore * 0.2
    );
  }
  
  /**
   * 淘汰评分最低的代币(为新币腾位置)
   */
  private async evictLowestScore(): Promise<MonitoredToken | null> {
    const eligible = db.getEligibleForRemoval();
    if (eligible.length === 0) {
      log.warn('No tokens eligible for eviction');
      return null;
    }
    
    const lowest = eligible[0];
    log.info('Evicting lowest score token', {
      symbol: lowest.symbol,
      score: lowest.currentScore,
    });
    
    await this.removeToken(lowest.address, 'evicted_for_capacity');
    return lowest;
  }
  
  // ========== 查询接口 ==========
  
  getAllTokens(): MonitoredToken[] {
    return Array.from(this.tokens.values());
  }
  
  getToken(address: string): MonitoredToken | null {
    return this.tokens.get(address) ?? null;
  }
  
  getActiveTokens(): MonitoredToken[] {
    return Array.from(this.tokens.values()).filter(t => 
      t.status === 'active' || t.status === 'protected'
    );
  }
  
  size(): number {
    return this.tokens.size;
  }
  
  /**
   * 标记代币为 has_position
   */
  markHasPosition(address: string, hasPosition: boolean): void {
    const token = this.tokens.get(address);
    if (!token) return;
    token.hasPosition = hasPosition;
    db.upsertMonitoredToken(token);
  }
  
  getStats() {
    const all = Array.from(this.tokens.values());
    return {
      total: all.length,
      active: all.filter(t => t.status === 'active').length,
      protected: all.filter(t => t.status === 'protected').length,
      warning: all.filter(t => t.status === 'warning').length,
      exiting: all.filter(t => t.status === 'exiting').length,
      withPosition: all.filter(t => t.hasPosition).length,
      capacityUsed: all.length / config.maxMonitoredTokens,
    };
  }
}

export const tokenMonitor = new TokenMonitor();
