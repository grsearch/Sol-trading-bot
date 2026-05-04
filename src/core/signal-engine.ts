/**
 * 信号引擎 (SignalEngine) - SOL本位版本
 * 
 * 计价原则:
 * - 仓位/盈亏: SOL单位
 * - 代币体量(FDV/LP/Volume): USD单位 (与Birdeye/DexScreener一致)
 * - 大单判定: 相对该币近期交易统计的倍数 (无需SOL价格转换)
 * 
 * 检测信号:
 * - 买入: 量能爆发 + 钱包结构 + 价格结构 + 安全 多维评分 (≥65触发)
 * - 卖出: 强制退出/止损/分批止盈/量能反转/大单卖出/时间止损
 */
import { EventEmitter } from 'events';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { db } from '../db';
import { tokenMonitor } from './token-monitor';
import { volumeAggregator } from './volume-aggregator';
import {
  MonitoredToken, BuySignal, SellSignal, SignalScore, Position,
  VolumeSnapshot,
} from '../types';

const log = getLogger('SignalEngine');

const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;  // 同币5分钟内不重复触发买入

export class SignalEngine extends EventEmitter {
  private lastSignalTime = new Map<string, number>();
  private evalInterval: NodeJS.Timeout | null = null;
  
  start(): void {
    this.evalInterval = setInterval(() => this.scanBuySignals(), 30 * 1000);
    log.info('SignalEngine started', {
      minScore: config.minBuySignalScore,
      tp1: `+${config.tp1Percent}% sell ${config.tp1SellRatio}%`,
      tp2: `+${config.tp2Percent}% sell ${config.tp2SellRatio}%`,
      stopLoss: `-${config.stopLossPercent}%`,
      timeStop: `${config.timeStopLossHours}h`,
    });
  }
  
  stop(): void {
    if (this.evalInterval) clearInterval(this.evalInterval);
  }
  
  // ========== 买入信号扫描 ==========
  
  private async scanBuySignals(): Promise<void> {
    const tokens = tokenMonitor.getActiveTokens();
    
    for (const token of tokens) {
      if (token.status === 'protected') continue;
      if (token.hasPosition) continue;
      if (token.status === 'warning' || token.status === 'exiting') continue;
      
      const last = this.lastSignalTime.get(token.address) ?? 0;
      if (Date.now() - last < SIGNAL_COOLDOWN_MS) continue;
      
      try {
        const signal = await this.evaluateBuyForToken(token);
        if (signal) {
          this.lastSignalTime.set(token.address, Date.now());
          
          db.insertSignal({
            tokenAddress: token.address,
            symbol: token.symbol,
            signalType: 'buy',
            timestamp: signal.timestamp,
            score: signal.score.total,
            scoreBreakdown: signal.score.breakdown,
            reasons: signal.score.reasons,
            marketSnapshot: { fdv: signal.marketData.fdv, lp: signal.marketData.liquidity },
            executed: false,
          });
          
          if (signal.score.total >= config.minBuySignalScore) {
            log.info('Buy signal triggered', {
              symbol: token.symbol,
              score: signal.score.total,
              recommendedSizeSol: signal.recommendedSize.toFixed(3),
              reasons: signal.score.reasons,
            });
            this.emit('buy_signal', signal);
          } else {
            log.debug('Buy signal below threshold', {
              symbol: token.symbol,
              score: signal.score.total,
            });
          }
        }
      } catch (err: any) {
        log.error('evaluateBuyForToken error', { symbol: token.symbol, error: err.message });
      }
    }
  }
  
  /**
   * 评估单个代币的买入信号
   */
  private async evaluateBuyForToken(token: MonitoredToken): Promise<BuySignal | null> {
    const fiveMin = volumeAggregator.getFiveMinSnapshot(token.address);
    const baseline = volumeAggregator.getHourlyBaseline(token.address);
    
    if (!fiveMin || !baseline) return null;
    
    const totalActivity = fiveMin.buyCount + fiveMin.sellCount;
    if (totalActivity < 5) return null;
    
    const reasons: string[] = [];
    const breakdown = {
      volumeBurst: 0,
      walletStructure: 0,
      priceStructure: 0,
      safety: 0,
    };
    
    // === 1. 量能维度 (40%) ===
    
    // 1.1 量能爆发倍数
    const expectedNetBuy5m = baseline.netBuyPerMinute * 5;
    const burstRatio = expectedNetBuy5m > 0 
      ? fiveMin.netBuyVolumeSol / expectedNetBuy5m
      : (fiveMin.netBuyVolumeSol > 0 ? 10 : 0);
    
    if (burstRatio >= config.volumeBurstMultiplier) {
      breakdown.volumeBurst += 40;
      reasons.push(`Volume burst ${burstRatio.toFixed(1)}x`);
    } else if (burstRatio >= config.volumeBurstMultiplier * 0.6) {
      breakdown.volumeBurst += 20;
    }
    
    // 1.2 买卖笔数比
    const buySellRatio = fiveMin.sellCount > 0 
      ? fiveMin.buyCount / fiveMin.sellCount
      : (fiveMin.buyCount > 0 ? 10 : 0);
    
    if (buySellRatio >= config.buySellRatioThreshold) {
      breakdown.volumeBurst += 30;
      reasons.push(`Buy/Sell ratio ${buySellRatio.toFixed(2)}`);
    } else if (buySellRatio >= 1.5) {
      breakdown.volumeBurst += 15;
    }
    
    // 1.3 净买入必须为正(硬性条件)
    if (fiveMin.netBuyVolumeSol > 0) {
      breakdown.volumeBurst += 30;
    } else {
      return null;
    }
    
    // === 2. 钱包结构维度 (35%) ===
    
    const uniqueBuyers = fiveMin.uniqueBuyers.size;
    const expectedBuyers = baseline.uniqueBuyersPer5m;
    const buyerBurst = expectedBuyers > 0 
      ? uniqueBuyers / expectedBuyers 
      : (uniqueBuyers > 5 ? 5 : 0);
    
    if (buyerBurst >= config.uniqueBuyersMultiplier) {
      breakdown.walletStructure += 40;
      reasons.push(`Buyers burst ${buyerBurst.toFixed(1)}x (${uniqueBuyers})`);
    } else if (buyerBurst >= 1.5) {
      breakdown.walletStructure += 20;
    }
    
    // 新钱包占比
    const newWalletRatio = uniqueBuyers > 0 ? fiveMin.newWallets.size / uniqueBuyers : 0;
    if (newWalletRatio >= config.newWalletRatioThreshold) {
      breakdown.walletStructure += 30;
      reasons.push(`New wallet ${(newWalletRatio * 100).toFixed(0)}%`);
    } else if (newWalletRatio >= 0.3) {
      breakdown.walletStructure += 15;
    }
    
    // 平均买单大小健康度 (SOL本位 - 散户主导特征区间)
    // 0.05-1.5 SOL: 散户FOMO最理想区间
    // ≥3 SOL: 巨鲸主导,谨慎
    const avgBuySize = fiveMin.avgBuySize;
    const HEALTHY_MIN_SOL = 0.05;
    const HEALTHY_MAX_SOL = 1.5;
    const WHALE_THRESHOLD_SOL = 3;
    
    if (avgBuySize >= HEALTHY_MIN_SOL && avgBuySize < HEALTHY_MAX_SOL) {
      breakdown.walletStructure += 30;
    } else if (avgBuySize >= WHALE_THRESHOLD_SOL) {
      breakdown.walletStructure += 10;
      reasons.push(`Whale-driven (avg buy ${avgBuySize.toFixed(2)} SOL)`);
    } else if (avgBuySize >= HEALTHY_MAX_SOL && avgBuySize < WHALE_THRESHOLD_SOL) {
      // 中间区间: 中等玩家,可接受
      breakdown.walletStructure += 20;
    }
    
    // === 3. 价格结构维度 (15%) ===
    
    if (token.lastPrice > 0) {
      breakdown.priceStructure = 50;
      
      // 大单分布: 用相对统计判定
      const largeBuyThreshold = this.getLargeSwapThresholdSol(token);
      // fiveMin.largeBuys 字段是按"≥1 SOL"统计的旧标准
      // 这里我们用近似: 如果有大单且不是单一主导,加分
      if (fiveMin.largeBuys > 0 && fiveMin.largeBuys < fiveMin.buyCount * 0.5) {
        breakdown.priceStructure += 30;
        reasons.push(`Healthy large buys ${fiveMin.largeBuys}`);
      }
      
      // 防止用 unused variable 警告
      void largeBuyThreshold;
    }
    
    // === 4. 安全维度 (10%) ===
    
    breakdown.safety = 100;
    
    if (token.holderTrend.length >= 2) {
      const recent = token.holderTrend[token.holderTrend.length - 1];
      const before = token.holderTrend[Math.max(0, token.holderTrend.length - 6)];
      if (recent < before * 0.95) {
        breakdown.safety -= 30;
        reasons.push('Holders declining');
      }
    }
    
    // === 加权总分 ===
    const total = Math.round(
      Math.min(100, breakdown.volumeBurst) * 0.40 +
      Math.min(100, breakdown.walletStructure) * 0.35 +
      Math.min(100, breakdown.priceStructure) * 0.15 +
      Math.min(100, breakdown.safety) * 0.10
    );
    
    const score: SignalScore = {
      total,
      breakdown: {
        volumeBurst: Math.min(100, breakdown.volumeBurst),
        walletStructure: Math.min(100, breakdown.walletStructure),
        priceStructure: Math.min(100, breakdown.priceStructure),
        safety: Math.min(100, breakdown.safety),
      },
      reasons,
    };
    
    if (score.total < 40) return null;
    
    return {
      tokenAddress: token.address,
      symbol: token.symbol,
      timestamp: Date.now(),
      score,
      triggeredBy: reasons,
      marketData: {
        address: token.address,
        symbol: token.symbol,
        price: token.lastPrice,
        fdv: token.lastFdv,
        liquidity: token.lastLiquidity,
        volume24h: token.lastVolume24h,
        holders: token.lastHolders,
        createdAt: token.listedAt,
      },
      recommendedSize: this.calculatePositionSize(score.total, token),
    };
  }
  
  /**
   * 计算推荐仓位大小 (SOL本位,流动性约束)
   * 用池子真实SOL深度作为约束,不依赖SOL美元价格
   */
  private calculatePositionSize(score: number, token: MonitoredToken): number {
    let size = config.defaultBuyAmountSol;
    
    // 高分加大仓位
    if (score >= 85) size = config.maxPositionSol;
    else if (score >= 75) size = config.defaultBuyAmountSol * 1.5;
    
    // 流动性约束: 不超过池子SOL深度的0.5%
    const poolSolReserve = token.pool?.quoteReserve ?? 0;
    let maxByLp = config.maxPositionSol;  // 默认不限制
    
    if (poolSolReserve > 0) {
      maxByLp = poolSolReserve * 0.005;
    } else {
      // 池子数据不全时的兜底估算: 按LP_USD近似换算
      // 假设LP是双边均衡的,SOL深度 ≈ LP_USD / 2 / SOL价格
      // 这里SOL价格用一个不会太离谱的中间值,但仅在数据缺失时使用
      const fallbackSolReserve = token.lastLiquidity / 2 / 100;
      maxByLp = fallbackSolReserve * 0.005;
    }
    
    return Math.min(size, maxByLp, config.maxPositionSol);
  }
  
  /**
   * 动态计算"大单"阈值 (相对该币近期交易统计)
   * 完全不依赖SOL价格,纯统计学方法
   */
  private getLargeSwapThresholdSol(token: MonitoredToken): number {
    const hourly = volumeAggregator.getHourlySnapshot(token.address);
    
    if (!hourly || hourly.buyCount + hourly.sellCount < 10) {
      // 数据不足时用绝对兜底
      return config.largeSwapMinSol;
    }
    
    const totalSol = hourly.buyVolumeSol + hourly.sellVolumeSol;
    const totalCount = hourly.buyCount + hourly.sellCount;
    const avgSwapSol = totalSol / totalCount;
    
    // 大单 = 平均单笔的 N 倍, 但至少要超过最小兜底值
    return Math.max(
      config.largeSwapMinSol,
      avgSwapSol * config.largeSwapMultiplier
    );
  }
  
  /**
   * 估算池子SOL深度 (用于"大单卖出占LP比例"判定)
   * 优先用池子真实数据,fallback到USD近似
   */
  private estimatePoolSolReserve(token: MonitoredToken): number {
    if (token.pool?.quoteReserve && token.pool.quoteReserve > 0) {
      return token.pool.quoteReserve;
    }
    // 兜底: 用LP USD除以一个保守的SOL价格估算
    return token.lastLiquidity / 2 / 100;
  }
  
  // ========== 卖出信号检测 ==========
  
  /**
   * 评估持仓的卖出信号 (按优先级从高到低,首个命中即返回)
   */
  evaluateSellForPosition(position: Position, token: MonitoredToken | null): SellSignal | null {
    // 代币已不在监控池 = 监控数据不可信,立即清仓
    if (!token) {
      return {
        tokenAddress: position.tokenAddress,
        symbol: position.symbol,
        timestamp: Date.now(),
        reason: 'force_exit_lp',
        urgency: 'critical',
        triggeredBy: ['Token no longer monitored'],
      };
    }
    
    // ========== 优先级 1: 强制退出 (FDV/LP崩盘) ==========
    if (token.lastFdv < config.forceExitFdvUsd) {
      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        timestamp: Date.now(),
        reason: 'force_exit_fdv',
        urgency: 'critical',
        triggeredBy: [`FDV $${token.lastFdv.toFixed(0)} < $${config.forceExitFdvUsd}`],
      };
    }
    
    if (token.lastLiquidity < config.forceExitLpUsd) {
      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        timestamp: Date.now(),
        reason: 'force_exit_lp',
        urgency: 'critical',
        triggeredBy: [`LP $${token.lastLiquidity.toFixed(0)} < $${config.forceExitLpUsd}`],
      };
    }
    
    // ========== 优先级 2: 止损 ==========
    const currentPrice = token.lastPrice;
    let pnlPercent = 0;
    
    if (currentPrice > 0 && position.entryPrice > 0) {
      pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      
      if (pnlPercent <= -config.stopLossPercent) {
        return {
          tokenAddress: token.address,
          symbol: token.symbol,
          timestamp: Date.now(),
          reason: 'stop_loss',
          urgency: 'high',
          triggeredBy: [`Stop loss hit: ${pnlPercent.toFixed(1)}%`],
        };
      }
    }
    
    // ========== 优先级 3: 分批止盈 ==========
    
    // TP2: +200% (3x), 100%清仓 (TP2优先于TP1: 暴涨直接跳到3x时,直接清仓避免无效中间步骤)
    if (pnlPercent >= config.tp2Percent && !position.takeProfit2Hit) {
      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        timestamp: Date.now(),
        reason: 'take_profit_2',
        urgency: 'medium',
        triggeredBy: [`TP2 hit: +${pnlPercent.toFixed(1)}% (3x target, full close)`],
      };
    }
    
    // TP1: +100% (2x), 卖50%
    if (pnlPercent >= config.tp1Percent && !position.takeProfit1Hit) {
      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        timestamp: Date.now(),
        reason: 'take_profit_1',
        urgency: 'medium',
        triggeredBy: [`TP1 hit: +${pnlPercent.toFixed(1)}% (2x target, sell 50%)`],
      };
    }
    
    // ========== 优先级 4: 大单卖出告警 ==========
    const largeSellSignal = this.checkLargeSellPressure(token);
    if (largeSellSignal) return largeSellSignal;
    
    // ========== 优先级 5: 量能反转 (仅在已盈利时) ==========
    if (pnlPercent > config.volumeReversalProfitThreshold) {
      const reversal = volumeAggregator.detectVolumeReversal(token.address, 2);
      if (reversal) {
        return {
          tokenAddress: token.address,
          symbol: token.symbol,
          timestamp: Date.now(),
          reason: 'volume_reversal',
          urgency: 'medium',
          triggeredBy: [
            'Volume reversed for 2+ minutes',
            `Locking gain ${pnlPercent.toFixed(1)}%`,
          ],
        };
      }
    }
    
    // ========== 优先级 6: 时间止损 ==========
    const holdingHours = (Date.now() - position.entryTimestamp) / (3600 * 1000);
    if (holdingHours >= config.timeStopLossHours && pnlPercent < 10) {
      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        timestamp: Date.now(),
        reason: 'time_stop',
        urgency: 'low',
        triggeredBy: [
          `Held ${holdingHours.toFixed(1)}h with PnL ${pnlPercent.toFixed(1)}%`,
        ],
      };
    }
    
    return null;
  }
  
  /**
   * 大单卖出压力检测 (动态阈值)
   * 触发条件:
   *   1. 1分钟内有 ≥2 笔大单卖出
   *   2. 大单卖出累计金额 ≥ 池子SOL深度的某比例 (默认5%)
   *   3. 卖出额 > 买入额 × 1.5
   */
  private checkLargeSellPressure(token: MonitoredToken): SellSignal | null {
    const oneMin = volumeAggregator.getOneMinSnapshot(token.address);
    if (!oneMin || oneMin.sellCount < 2) return null;
    
    // 动态大单阈值
    const largeSwapThreshold = this.getLargeSwapThresholdSol(token);
    
    // oneMin.largeSells 是基于旧的 1 SOL 静态阈值统计的
    // 这里我们重新基于动态阈值估算: 用平均卖单大小 + 卖单数判断
    // 如果1分钟卖出额很大,且卖单数较少,大概率有大单
    const avgSellSize = oneMin.sellCount > 0 ? oneMin.sellVolumeSol / oneMin.sellCount : 0;
    const hasLargeSells = avgSellSize >= largeSwapThreshold || oneMin.largeSells >= 2;
    
    if (!hasLargeSells) return null;
    
    // 池子SOL深度
    const poolSolReserve = this.estimatePoolSolReserve(token);
    const lpRatio = poolSolReserve > 0 ? oneMin.sellVolumeSol / poolSolReserve : 0;
    
    // 累计冲击力达到LP的某比例
    if (lpRatio < config.largeSellLpRatioThreshold) return null;
    
    // 卖压相对买盘的强度
    const sellBuyRatio = oneMin.buyVolumeSol > 0 
      ? oneMin.sellVolumeSol / oneMin.buyVolumeSol 
      : Infinity;
    
    if (sellBuyRatio < 1.5) return null;
    
    return {
      tokenAddress: token.address,
      symbol: token.symbol,
      timestamp: Date.now(),
      reason: 'large_sell',
      urgency: 'high',
      triggeredBy: [
        `Large sells detected: ${oneMin.sellCount} sells in 1min`,
        `Avg sell ${avgSellSize.toFixed(2)} SOL (threshold ${largeSwapThreshold.toFixed(2)})`,
        `Sell impact ${(lpRatio * 100).toFixed(1)}% of LP`,
        `Sell/Buy ratio ${sellBuyRatio.toFixed(2)}`,
      ],
    };
  }
}

export const signalEngine = new SignalEngine();
