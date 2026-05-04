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
   * 添加代币(主入口)
   */
  async addToken(input: AddTokenInput): Promise<AddTokenResult> {
    const { address, via, sourceDetail } = input;
    let { symbol } = input;
    
    log.info('Attempting to add token', { address, symbol, via });
    
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
    
    const top10Pct = security?.top10HolderPercent ? security.top10HolderPercent * 100 : 0;
    if (top10Pct > config.maxTop10Percent) {
      return { success: false, reason: `Top10 too concentrated: ${top10Pct.toFixed(1)}%` };
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
    
    // 5. 构造监控对象
    const now = Date.now();
    const token: MonitoredToken = {
      address: market.address,
      symbol: symbol || market.symbol,
      name: undefined,
      decimals: 9,  // 默认,实际从链上获取
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
      currentScore: 50,  // 初始评分
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
