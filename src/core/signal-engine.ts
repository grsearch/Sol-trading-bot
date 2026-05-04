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
  
  // 缓存每个币的最新评估结果(用于Dashboard显示)
  private latestEvaluations = new Map<string, {
    timestamp: number;
    score: number;
    breakdown: { volumeBurst: number; walletStructure: number; priceStructure: number; safety: number };
    reasons: string[];
    triggered: boolean;       // 是否达到75分门槛
    rejectedReason?: string;  // 如果有,说明为什么没评估出信号
  }>();
  
  /**
   * 查询某币最近一次的买入信号评估结果
   * 用于Dashboard显示"为什么这个币没有触发买入"
   */
  getLatestEvaluation(tokenAddress: string) {
    return this.latestEvaluations.get(tokenAddress) ?? null;
  }
  
  /**
   * 获取所有评估结果(用于Dashboard列表)
   */
  getAllEvaluations() {
    return Object.fromEntries(this.latestEvaluations);
  }
  
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
      // 记录跳过原因(用于Dashboard显示)
      let skipReason: string | null = null;
      
      if (token.status === 'protected') skipReason = 'in_protection_period';
      else if (token.hasPosition) skipReason = 'has_position';
      else if (token.status === 'exiting') skipReason = 'exiting';
      else {
        const last = this.lastSignalTime.get(token.address) ?? 0;
        if (Date.now() - last < SIGNAL_COOLDOWN_MS) {
          skipReason = `signal_cooldown (${Math.ceil((SIGNAL_COOLDOWN_MS - (Date.now() - last)) / 1000)}s left)`;
        }
      }
      
      if (skipReason) {
        // 跳过的币也记录(让Dashboard能显示"为什么没评估")
        const existing = this.latestEvaluations.get(token.address);
        if (!existing || Date.now() - existing.timestamp > 60_000) {
          this.latestEvaluations.set(token.address, {
            timestamp: Date.now(),
            score: 0,
            breakdown: { volumeBurst: 0, walletStructure: 0, priceStructure: 0, safety: 0 },
            reasons: [],
            triggered: false,
            rejectedReason: skipReason,
          });
        }
        continue;
      }
      
      try {
        const signal = await this.evaluateBuyForToken(token);
        if (signal) {
          this.lastSignalTime.set(token.address, Date.now());
          
          // 缓存评估结果
          const triggered = signal.score.total >= config.minBuySignalScore;
          this.latestEvaluations.set(token.address, {
            timestamp: signal.timestamp,
            score: signal.score.total,
            breakdown: signal.score.breakdown,
            reasons: signal.score.reasons,
            triggered,
            rejectedReason: triggered ? undefined : `score ${signal.score.total} < ${config.minBuySignalScore}`,
          });
          
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
          
          if (triggered) {
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
        } else {
          // evaluateBuyForToken 返回 null = 数据不足 或 硬条件否决
          this.latestEvaluations.set(token.address, {
            timestamp: Date.now(),
            score: 0,
            breakdown: { volumeBurst: 0, walletStructure: 0, priceStructure: 0, safety: 0 },
            reasons: [],
            triggered: false,
            rejectedReason: 'insufficient_data_or_hard_reject',
          });
        }
      } catch (err: any) {
        log.error('evaluateBuyForToken error', { symbol: token.symbol, error: err.message });
      }
    }
    
    // 清理超过30分钟未更新的评估缓存
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [addr, evalResult] of this.latestEvaluations.entries()) {
      if (evalResult.timestamp < cutoff) {
        this.latestEvaluations.delete(addr);
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
    
    // === 1. 量能维度 (40%) - 改造为"健康区间评分" ===
    
    // 1.1 量能爆发倍数 - 分级评分,过热反向扣分
    // 思路: 5-15x 是"温和的猛"(健康); 15x+ 是"过热"(顶部FOMO);
    //      30x+ 是"极致过热"(几乎确定是顶部派发)
    const expectedNetBuy5m = baseline.netBuyPerMinute * 5;
    const burstRatio = expectedNetBuy5m > 0 
      ? fiveMin.netBuyVolumeSol / expectedNetBuy5m
      : (fiveMin.netBuyVolumeSol > 0 ? 10 : 0);
    
    if (burstRatio >= 30) {
      // 极致过热 - 强扣分
      breakdown.volumeBurst -= 25;
      reasons.push(`⚠️ Extreme FOMO ${burstRatio.toFixed(1)}x (top warning)`);
    } else if (burstRatio >= 15) {
      // 过热区间 - 不加分
      breakdown.volumeBurst += 0;
      reasons.push(`High burst ${burstRatio.toFixed(1)}x (neutral)`);
    } else if (burstRatio >= config.volumeBurstMultiplier) {
      // 健康爆发(5-15x)
      breakdown.volumeBurst += 40;
      reasons.push(`Volume burst ${burstRatio.toFixed(1)}x`);
    } else if (burstRatio >= config.volumeBurstMultiplier * 0.6) {
      // 温和爆发(3-5x)
      breakdown.volumeBurst += 25;
      reasons.push(`Mild burst ${burstRatio.toFixed(1)}x`);
    }
    
    // 1.2 买卖笔数比 - 同样分级
    // 2.5-6: 健康买盘占优
    // 6-10: 过强,要警惕
    // 10+: 几乎没人卖 = 不可持续(顶部特征)
    const buySellRatio = fiveMin.sellCount > 0 
      ? fiveMin.buyCount / fiveMin.sellCount
      : (fiveMin.buyCount > 0 ? 10 : 0);
    
    if (buySellRatio >= 10) {
      breakdown.volumeBurst -= 15;
      reasons.push(`⚠️ No selling ${buySellRatio.toFixed(1)}:1 (unsustainable)`);
    } else if (buySellRatio >= 6) {
      breakdown.volumeBurst += 5;
    } else if (buySellRatio >= config.buySellRatioThreshold) {
      breakdown.volumeBurst += 30;
      reasons.push(`Buy/Sell ratio ${buySellRatio.toFixed(2)}`);
    } else if (buySellRatio >= 1.5) {
      breakdown.volumeBurst += 15;
    }
    
    // 1.3 净买入趋势 - 不再硬否决5分钟净买入
    // 允许场景: 砸盘后刚转正,5分钟可能仍微负,但最近1-2分钟已转正
    const oneMin = volumeAggregator.getOneMinSnapshot(token.address);
    const isVeryRecentBuyPositive = oneMin && oneMin.netBuyVolumeSol > 0;
    
    if (fiveMin.netBuyVolumeSol > 0) {
      breakdown.volumeBurst += 30;
    } else if (isVeryRecentBuyPositive) {
      // 5分钟还是负,但最近1分钟已转正 → 可能是反弹起点,谨慎给分
      breakdown.volumeBurst += 10;
      reasons.push('Recent 1m turned positive');
    } else {
      // 5分钟和1分钟都净流出 → 硬否决
      return null;
    }
    
    // === 2. 钱包结构维度 (35%) - 同样反向过热保护 ===
    
    const uniqueBuyers = fiveMin.uniqueBuyers.size;
    const expectedBuyers = baseline.uniqueBuyersPer5m;
    const buyerBurst = expectedBuyers > 0 
      ? uniqueBuyers / expectedBuyers 
      : (uniqueBuyers > 5 ? 5 : 0);
    
    // 买家暴增: 3-8x 健康, 8-15x 警戒, 15x+ 过热
    if (buyerBurst >= 15) {
      breakdown.walletStructure -= 10;
      reasons.push(`⚠️ Buyer mania ${buyerBurst.toFixed(1)}x`);
    } else if (buyerBurst >= 8) {
      breakdown.walletStructure += 15;
    } else if (buyerBurst >= config.uniqueBuyersMultiplier) {
      breakdown.walletStructure += 40;
      reasons.push(`Buyers burst ${buyerBurst.toFixed(1)}x (${uniqueBuyers})`);
    } else if (buyerBurst >= 1.5) {
      breakdown.walletStructure += 20;
    }
    
    // 新钱包占比: 30-70% 健康, 70-90% 警戒, 90%+ 纯FOMO
    // 90%+ 意味着老钱包都跑了,只剩散户接盘
    const newWalletRatio = uniqueBuyers > 0 ? fiveMin.newWallets.size / uniqueBuyers : 0;
    if (newWalletRatio >= 0.95) {
      breakdown.walletStructure -= 20;
      reasons.push(`⚠️ Pure FOMO ${(newWalletRatio * 100).toFixed(0)}% new (no diamond hands)`);
    } else if (newWalletRatio >= 0.85) {
      breakdown.walletStructure += 5;
      reasons.push(`Mostly new ${(newWalletRatio * 100).toFixed(0)}%`);
    } else if (newWalletRatio >= config.newWalletRatioThreshold) {
      breakdown.walletStructure += 30;
      reasons.push(`New wallet ${(newWalletRatio * 100).toFixed(0)}%`);
    } else if (newWalletRatio >= 0.3) {
      breakdown.walletStructure += 20;
    } else if (newWalletRatio >= 0.15) {
      // 老钱包主导也不一定不好(说明有持续买盘)
      breakdown.walletStructure += 25;
      reasons.push(`Old wallets active ${(newWalletRatio * 100).toFixed(0)}% new`);
    }
    
    // 平均买单大小健康度 (保持原逻辑)
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
      breakdown.walletStructure += 20;
    }
    
    // === 3. 价格结构维度 (25%) - 关键创新维度 ===
    // 包含: 大单健康度 + 二次启动 + 投降反弹 + 多次启动
    
    if (token.lastPrice > 0) {
      breakdown.priceStructure = 30;  // 基础分降低,留空间给信号加分
      
      // 大单分布
      const largeBuyThreshold = this.getLargeSwapThresholdSol(token);
      if (fiveMin.largeBuys > 0 && fiveMin.largeBuys < fiveMin.buyCount * 0.5) {
        breakdown.priceStructure += 15;
        reasons.push(`Healthy large buys ${fiveMin.largeBuys}`);
      }
      void largeBuyThreshold;
      
      // ⭐⭐ 投降式反弹 (Capitulation Bounce) - 最高质量信号
      // 砸盘 → 衰竭 → 量能转正 = 低吸反弹机会
      const capitulation = this.detectCapitulationBounce(token);
      if (capitulation.detected) {
        // 分级加分: 高质量 +60, 中质量 +45, 低质量 +30
        const bonus = capitulation.quality === 'high' ? 60 
                    : capitulation.quality === 'medium' ? 45 
                    : 30;
        breakdown.priceStructure += bonus;
        reasons.push(`⭐⭐ ${capitulation.reason}`);
      }
      
      // ⭐ 二次启动信号 (Re-launch)  
      // 启动 → 冷却 → 再启动 = 真共识形成
      const relaunchSignal = this.detectRelaunch(token);
      if (relaunchSignal.detected) {
        breakdown.priceStructure += 40;
        reasons.push(`⭐ Re-launch pattern (${relaunchSignal.reason})`);
      }
      
      // 多次启动加分: 该币近期(最多3小时内)出现过多次"启动-回落"循环
      // 这种"波动型"币天然有反弹基因
      const surgeCount = this.countRecentVolumeSurges(token, 3);
      if (surgeCount >= 4) {
        breakdown.priceStructure += 20;
        reasons.push(`Volatile token (${surgeCount} surges in 3h)`);
      } else if (surgeCount >= 2) {
        breakdown.priceStructure += 12;
        reasons.push(`Multi-surge pattern (${surgeCount} in 3h)`);
      }
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
    // 权重调整: priceStructure(模式识别)从15%升到25%, volumeBurst从40%降到30%
    // 因为模式识别(投降反弹/二次启动)的预测力比纯量能爆发更可靠
    const total = Math.round(
      Math.max(0, Math.min(100, breakdown.volumeBurst)) * 0.30 +
      Math.max(0, Math.min(100, breakdown.walletStructure)) * 0.35 +
      Math.max(0, Math.min(100, breakdown.priceStructure)) * 0.25 +
      Math.max(0, Math.min(100, breakdown.safety)) * 0.10
    );
    
    const score: SignalScore = {
      total,
      breakdown: {
        volumeBurst: Math.max(0, Math.min(100, breakdown.volumeBurst)),
        walletStructure: Math.max(0, Math.min(100, breakdown.walletStructure)),
        priceStructure: Math.max(0, Math.min(100, breakdown.priceStructure)),
        safety: Math.max(0, Math.min(100, breakdown.safety)),
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
   * 
   * Warning状态(FDV/LP接近退出线): 仓位减半,降低风险
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
      const fallbackSolReserve = token.lastLiquidity / 2 / 100;
      maxByLp = fallbackSolReserve * 0.005;
    }
    
    let finalSize = Math.min(size, maxByLp, config.maxPositionSol);
    
    // Warning状态: 仓位减半 (风险币降低敞口)
    if (token.status === 'warning') {
      finalSize = finalSize * 0.5;
    }
    
    return finalSize;
  }
  
  /**
  /**
   * ⭐ 检测"二次启动"信号: 启动 → 冷却 → 再启动
   * 
   * 时间窗口压缩到40分钟内 (Memecoin节奏快,启动-冷却-启动通常15-40min完成)
   * 
   * 检测逻辑:
   * - 段A (20-40min前): 第一次启动 - 显著净买入
   * - 段B (8-20min前):  冷却期 - 净买入显著小于段A
   * - 段C (1-8min前):   二次启动 - 净买入恢复
   */
  private detectRelaunch(token: MonitoredToken): { detected: boolean; reason: string } {
    const NOT_DETECTED = { detected: false, reason: '' };
    
    // 拿过去40分钟的每分钟净买入序列
    const series = volumeAggregator.getNetBuyTimeSeries(token.address, 40);
    if (series.length < 30) return NOT_DETECTED;
    
    // 三段切分
    const segA = series.filter(s => s.minAgo >= 20 && s.minAgo < 40);   // 20分钟窗口
    const segB = series.filter(s => s.minAgo >= 8 && s.minAgo < 20);    // 12分钟窗口
    const segC = series.filter(s => s.minAgo >= 1 && s.minAgo < 8);     // 7分钟窗口
    
    if (segA.length < 12 || segB.length < 8 || segC.length < 5) return NOT_DETECTED;
    
    const sumA = segA.reduce((s, x) => s + x.netBuy, 0);
    const sumB = segB.reduce((s, x) => s + x.netBuy, 0);
    const sumC = segC.reduce((s, x) => s + x.netBuy, 0);
    
    const activityA = segA.reduce((s, x) => s + x.count, 0);
    const activityC = segC.reduce((s, x) => s + x.count, 0);
    
    // 条件1: 段A有显著净买入(第一次启动)
    if (sumA <= 0 || activityA < 10) return NOT_DETECTED;
    
    // 条件2: 段B是冷却期 (净流入 < 段A的40% 或为负)
    if (sumB > sumA * 0.4) return NOT_DETECTED;
    
    // 条件3: 段C出现二次启动 (>= 段A的50%, 因为窗口比例7/20)
    // 段C只有7分钟,段A有20分钟,折算后段C每分钟净买入应 >= 段A每分钟的 50%
    const sumA_perMin = sumA / segA.length;
    const sumC_perMin = sumC / segC.length;
    if (sumC_perMin < sumA_perMin * 0.5) return NOT_DETECTED;
    
    // 条件4: 段C活跃度足够
    if (activityC < 6) return NOT_DETECTED;
    
    return {
      detected: true,
      reason: `1st burst ${sumA.toFixed(1)} SOL → cooldown ${sumB.toFixed(1)} → 2nd ${sumC.toFixed(1)}`,
    };
  }
  
  /**
   * ⭐⭐ 检测"投降式反弹" (Capitulation Bounce)
   * 
   * 时间窗口大幅压缩到17分钟内,贴合Memecoin的快速V型反转节奏。
   * 
   * 检测逻辑(全部满足):
   * 1. 砸盘期 (5-15min前):  强抛压(卖>买×2),量能放大,可选价格下跌
   * 2. 衰竭期 (2-5min前):   卖压明显萎缩(<砸盘期×60%),仍有底部活跃度
   * 3. 反转期 (2min内):     净买入转正,买盘强势(买>卖×1.5),活跃度足够
   * 4. 价格判定 (可选):     1h价格变动 ≤ -15% (有真实跌幅),当前价格相对最低点回升 ≥ 2%
   * 5. 流动性安全:          LP > $25K
   */
  private detectCapitulationBounce(token: MonitoredToken): { 
    detected: boolean; 
    reason: string;
    quality: 'high' | 'medium' | 'low';
  } {
    const NOT_DETECTED = { detected: false, reason: '', quality: 'low' as const };
    
    // 流动性安全检查
    if (token.lastLiquidity < 25000) return NOT_DETECTED;
    
    // 拿过去17分钟的每分钟数据
    const series = volumeAggregator.getNetBuyTimeSeries(token.address, 17);
    if (series.length < 12) return NOT_DETECTED;
    
    // 三段切分 - 短时间尺度
    const segDump = series.filter(s => s.minAgo >= 5 && s.minAgo < 15);    // 10分钟窗口
    const segDecay = series.filter(s => s.minAgo >= 2 && s.minAgo < 5);    // 3分钟窗口
    const segBounce = series.filter(s => s.minAgo < 2);                    // 2分钟窗口
    
    if (segDump.length < 8 || segDecay.length < 2 || segBounce.length < 2) {
      return NOT_DETECTED;
    }
    
    // 各段统计
    const dumpNetBuy = segDump.reduce((s, x) => s + x.netBuy, 0);
    const dumpSellVol = segDump.reduce((s, x) => s + x.sellVol, 0);
    const dumpBuyVol = segDump.reduce((s, x) => s + x.buyVol, 0);
    const dumpActivity = segDump.reduce((s, x) => s + x.count, 0);
    
    const decaySellVol = segDecay.reduce((s, x) => s + x.sellVol, 0);
    const decayActivity = segDecay.reduce((s, x) => s + x.count, 0);
    
    const bounceNetBuy = segBounce.reduce((s, x) => s + x.netBuy, 0);
    const bounceSellVol = segBounce.reduce((s, x) => s + x.sellVol, 0);
    const bounceBuyVol = segBounce.reduce((s, x) => s + x.buyVol, 0);
    const bounceActivity = segBounce.reduce((s, x) => s + x.count, 0);
    
    // 量能基线: 用1h每5min平均卖出量作为参考
    const baseline = volumeAggregator.getHourlyBaseline(token.address);
    const baselineSellPer5m = baseline?.avgBuyVolume5m ?? 0;
    
    // === 量能维度判定 ===
    
    // 条件1: 砸盘期必须确实在砸 (卖压>买盘×2 + 净流出 + 量能放大)
    if (dumpNetBuy >= 0) return NOT_DETECTED;
    if (dumpSellVol < dumpBuyVol * 2.0) return NOT_DETECTED;
    if (dumpActivity < 15) return NOT_DETECTED;
    
    // 砸盘强度: 砸盘期卖出量应明显高于该币正常量能
    // 10分钟卖出量应 >= 该币基线5min卖出 × 3 (即放大3倍)
    if (baselineSellPer5m > 0) {
      const dumpSellRelativeBase = dumpSellVol / (baselineSellPer5m * 2);  // 10min vs 5min基线
      if (dumpSellRelativeBase < 3) return NOT_DETECTED;
    }
    
    // 条件2: 衰竭期卖压萎缩
    const dumpAvgSellPerMin = dumpSellVol / segDump.length;
    const decayAvgSellPerMin = decaySellVol / segDecay.length;
    if (decayAvgSellPerMin >= dumpAvgSellPerMin * 0.6) return NOT_DETECTED;
    if (decayActivity < 3) return NOT_DETECTED;
    
    // 条件3: 反转期净买入转正
    if (bounceNetBuy <= 0) return NOT_DETECTED;
    if (bounceActivity < 3) return NOT_DETECTED;
    
    // 条件4: 反转期买盘强度
    if (bounceBuyVol < bounceSellVol * 1.5) return NOT_DETECTED;
    
    // === 价格维度判定 (基于价格历史) ===
    
    let priceCondMet = false;        // 是否满足价格判定
    let priceDropPct = 0;            // 近期价格跌幅
    let bounceFromLowPct = 0;        // 当前价格相对最低点回升幅度
    
    if (token.priceHistory && token.priceHistory.length >= 5) {
      const now = Date.now();
      const recentPrices = token.priceHistory.filter(p => now - p.ts <= 30 * 60 * 1000);
      
      if (recentPrices.length >= 3) {
        const earliest = recentPrices[0].price;
        const lowest = Math.min(...recentPrices.map(p => p.price));
        const current = token.lastPrice;
        
        if (earliest > 0 && lowest > 0) {
          priceDropPct = ((earliest - lowest) / earliest) * 100;
          bounceFromLowPct = ((current - lowest) / lowest) * 100;
          
          // 价格条件: 跌幅 ≥ 15% 且 当前已从底部回升 ≥ 2%
          // 注意: 这是辅助条件,如果价格历史不足不强制要求
          if (priceDropPct >= 15 && bounceFromLowPct >= 2) {
            priceCondMet = true;
          }
        }
      }
    }
    
    // === 命中! 评估质量分级 ===
    
    const dumpDepth = -dumpNetBuy;
    const decayRatio = decayAvgSellPerMin / dumpAvgSellPerMin;
    const bounceStrength = bounceBuyVol / bounceSellVol;
    
    let quality: 'high' | 'medium' | 'low' = 'low';
    
    // 高质量: 砸盘≥3SOL + 衰竭≥60% + 反转≥2.5x + 价格条件满足(下跌≥20%)
    if (dumpDepth >= 3 && decayRatio <= 0.4 && bounceStrength >= 2.5 
        && priceCondMet && priceDropPct >= 20) {
      quality = 'high';
    }
    // 中质量: 砸盘≥2SOL + 反转≥2.0x + (价格条件满足 或 衰竭≥50%)
    else if (dumpDepth >= 2 && bounceStrength >= 2.0 
             && (priceCondMet || decayRatio <= 0.5)) {
      quality = 'medium';
    }
    
    const priceInfo = priceCondMet 
      ? ` | price -${priceDropPct.toFixed(0)}% +${bounceFromLowPct.toFixed(0)}% from low`
      : '';
    
    return {
      detected: true,
      quality,
      reason: `Capitulation: dump ${dumpDepth.toFixed(1)} SOL → decay ${(decayRatio * 100).toFixed(0)}% → bounce ${bounceStrength.toFixed(1)}x${priceInfo} (${quality})`,
    };
  }
  
  /**
   * 统计该币最近N小时内的"启动次数"
   * 启动定义: 任意1分钟内净买入 > 阈值,且后续3-10分钟出现冷却(净买入下降50%+)
   * 
   * 多次启动的"波动型"币,反弹机会更多
   */
  private countRecentVolumeSurges(token: MonitoredToken, hoursBack: number = 24): number {
    // 由于我们的1m桶只保留3小时,这里实际能查到的最多3小时
    // 不影响功能,反映"近期活跃度"足够
    const minutesBack = Math.min(hoursBack * 60, 180);
    const series = volumeAggregator.getNetBuyTimeSeries(token.address, minutesBack);
    
    if (series.length < 30) return 0;
    
    // 启动阈值: 净买入 > 该币的小时基线 × 5
    const baseline = volumeAggregator.getHourlyBaseline(token.address);
    if (!baseline) return 0;
    const surgeThreshold = Math.max(0.5, baseline.netBuyPerMinute * 5);
    
    let surgeCount = 0;
    let inSurge = false;
    let surgeEndedMinAgo = -Infinity;
    
    // 从最早到最近遍历(降序,所以反过来)
    const ordered = [...series].reverse();
    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i];
      
      if (cur.netBuy >= surgeThreshold) {
        if (!inSurge) {
          // 距上次启动结束至少5分钟才算新启动(避免连续大单算多次)
          const minAgoCur = cur.minAgo;
          if (Math.abs(surgeEndedMinAgo - minAgoCur) >= 5) {
            surgeCount++;
            inSurge = true;
          }
        }
      } else if (inSurge && cur.netBuy < surgeThreshold * 0.3) {
        // 启动结束(净买入回落到阈值30%以下)
        inSurge = false;
        surgeEndedMinAgo = cur.minAgo;
      }
    }
    
    return surgeCount;
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
