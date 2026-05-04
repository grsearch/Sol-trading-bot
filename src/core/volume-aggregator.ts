/**
 * 量能聚合器 (VolumeAggregator)
 * 
 * 核心功能:
 * - 接收实时 Swap 事件
 * - 维护多周期滚动桶: 1分钟 / 5分钟 / 1小时
 * - 计算: 净买入、买卖笔数、独立买家、新钱包占比、大单数等
 * - 提供给信号引擎查询
 */
import { SwapEvent, VolumeSnapshot } from '../types';
import { getLogger } from '../utils/logger';

const log = getLogger('VolumeAggregator');

const BUCKET_SIZE_1M = 60 * 1000;
const BUCKET_SIZE_5M = 5 * 60 * 1000;
const BUCKET_SIZE_1H = 60 * 60 * 1000;

const RETENTION_1M = 3 * 60 * 60 * 1000;   // 保留3小时(支持砸盘反弹检测的历史数据)
const RETENTION_5M = 6 * 60 * 60 * 1000;   // 6小时
const RETENTION_1H = 48 * 60 * 60 * 1000;  // 48小时

const LARGE_BUY_SOL_THRESHOLD = 1;  // 大于1 SOL算大单

interface InternalBucket {
  start: number;
  end: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  newWallets: Set<string>;
  largeBuys: number;
  largeSells: number;
}

class TokenVolumeData {
  buckets1m: Map<number, InternalBucket> = new Map();
  buckets5m: Map<number, InternalBucket> = new Map();
  buckets1h: Map<number, InternalBucket> = new Map();
  totalSwaps: number = 0;
  firstSeenAt: number = 0;
  lastSwapAt: number = 0;
  
  // 1h 平均量(每5分钟更新一次缓存)
  cachedHourlyAvg: {
    netBuyPerMinute: number;
    uniqueBuyersPer5m: number;
    updatedAt: number;
  } | null = null;
}

export class VolumeAggregator {
  private data = new Map<string, TokenVolumeData>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  start(): void {
    // 每5分钟清理过期桶
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    log.info('VolumeAggregator started');
  }
  
  stop(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }
  
  /**
   * 注册一个代币(开始追踪)
   */
  trackToken(tokenAddress: string): void {
    if (!this.data.has(tokenAddress)) {
      const td = new TokenVolumeData();
      td.firstSeenAt = Date.now();
      this.data.set(tokenAddress, td);
    }
  }
  
  untrackToken(tokenAddress: string): void {
    this.data.delete(tokenAddress);
  }
  
  /**
   * 接收 swap 事件
   */
  ingestSwap(event: SwapEvent): void {
    let td = this.data.get(event.tokenAddress);
    if (!td) {
      this.trackToken(event.tokenAddress);
      td = this.data.get(event.tokenAddress)!;
    }
    
    td.totalSwaps++;
    td.lastSwapAt = event.timestamp;
    
    this.addToBucket(td.buckets1m, event, BUCKET_SIZE_1M);
    this.addToBucket(td.buckets5m, event, BUCKET_SIZE_5M);
    this.addToBucket(td.buckets1h, event, BUCKET_SIZE_1H);
  }
  
  private addToBucket(
    bucketMap: Map<number, InternalBucket>,
    event: SwapEvent,
    bucketSize: number
  ): void {
    const start = Math.floor(event.timestamp / bucketSize) * bucketSize;
    let bucket = bucketMap.get(start);
    
    if (!bucket) {
      bucket = {
        start,
        end: start + bucketSize,
        buyVolumeSol: 0,
        sellVolumeSol: 0,
        buyCount: 0,
        sellCount: 0,
        uniqueBuyers: new Set(),
        uniqueSellers: new Set(),
        newWallets: new Set(),
        largeBuys: 0,
        largeSells: 0,
      };
      bucketMap.set(start, bucket);
    }
    
    if (event.type === 'buy') {
      bucket.buyVolumeSol += event.solAmount;
      bucket.buyCount++;
      bucket.uniqueBuyers.add(event.walletAddress);
      if (event.solAmount >= LARGE_BUY_SOL_THRESHOLD) bucket.largeBuys++;
    } else {
      bucket.sellVolumeSol += event.solAmount;
      bucket.sellCount++;
      bucket.uniqueSellers.add(event.walletAddress);
      if (event.solAmount >= LARGE_BUY_SOL_THRESHOLD) bucket.largeSells++;
    }
    
    if (event.isNewWallet) {
      bucket.newWallets.add(event.walletAddress);
    }
  }
  
  /**
   * 获取最近 N 分钟的聚合数据(从 1m 桶聚合)
   */
  getRecentSnapshot(tokenAddress: string, minutes: number): VolumeSnapshot | null {
    const td = this.data.get(tokenAddress);
    if (!td) return null;
    
    const now = Date.now();
    const cutoff = now - minutes * 60 * 1000;
    
    return this.aggregateBuckets(td.buckets1m, cutoff, now, BUCKET_SIZE_1M);
  }
  
  /**
   * 获取指定分钟区间的聚合数据
   * @param tokenAddress 代币地址
   * @param fromMinAgo 起始时间(N分钟前)
   * @param toMinAgo 结束时间(N分钟前,必须小于fromMinAgo)
   * 例: getSnapshotInRange(addr, 60, 30) 返回 60-30分钟前的数据
   */
  getSnapshotInRange(
    tokenAddress: string, 
    fromMinAgo: number, 
    toMinAgo: number
  ): VolumeSnapshot | null {
    const td = this.data.get(tokenAddress);
    if (!td) return null;
    if (toMinAgo >= fromMinAgo) return null;
    
    const now = Date.now();
    const fromTs = now - fromMinAgo * 60 * 1000;
    const toTs = now - toMinAgo * 60 * 1000;
    
    return this.aggregateBuckets(td.buckets1m, fromTs, toTs, BUCKET_SIZE_1M);
  }
  
  /**
   * 获取最近1小时数据(从 5m 桶聚合,更精确)
   */
  getHourlySnapshot(tokenAddress: string): VolumeSnapshot | null {
    const td = this.data.get(tokenAddress);
    if (!td) return null;
    
    const now = Date.now();
    const cutoff = now - BUCKET_SIZE_1H;
    return this.aggregateBuckets(td.buckets5m, cutoff, now, BUCKET_SIZE_5M);
  }
  
  /**
   * 获取最近5分钟数据
   */
  getFiveMinSnapshot(tokenAddress: string): VolumeSnapshot | null {
    return this.getRecentSnapshot(tokenAddress, 5);
  }
  
  /**
   * 获取最近1分钟数据
   */
  getOneMinSnapshot(tokenAddress: string): VolumeSnapshot | null {
    return this.getRecentSnapshot(tokenAddress, 1);
  }
  
  /**
   * 获取近期净买入序列(每分钟一个值,从最近到最早)
   * 用于检测趋势变化(如砸盘后转正)
   * @param minutesBack 回溯多少分钟
   * @returns Array<{minAgo, netBuy, sellVol, buyVol, count}>, 按分钟降序(最近的在前)
   */
  getNetBuyTimeSeries(
    tokenAddress: string,
    minutesBack: number = 60
  ): Array<{ minAgo: number; netBuy: number; sellVol: number; buyVol: number; count: number }> {
    const td = this.data.get(tokenAddress);
    if (!td) return [];
    
    const result: Array<{ minAgo: number; netBuy: number; sellVol: number; buyVol: number; count: number }> = [];
    const now = Date.now();
    
    for (let minAgo = 0; minAgo < minutesBack; minAgo++) {
      const fromTs = now - (minAgo + 1) * 60 * 1000;
      const toTs = now - minAgo * 60 * 1000;
      const snap = this.aggregateBuckets(td.buckets1m, fromTs, toTs, BUCKET_SIZE_1M);
      
      result.push({
        minAgo,
        netBuy: snap.netBuyVolumeSol,
        sellVol: snap.sellVolumeSol,
        buyVol: snap.buyVolumeSol,
        count: snap.buyCount + snap.sellCount,
      });
    }
    
    return result;
  }
  
  private aggregateBuckets(
    bucketMap: Map<number, InternalBucket>,
    fromTs: number,
    toTs: number,
    bucketSize: number
  ): VolumeSnapshot {
    const snapshot: VolumeSnapshot = {
      timestamp: fromTs,
      bucketSize: toTs - fromTs,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      netBuyVolumeSol: 0,
      buyCount: 0,
      sellCount: 0,
      uniqueBuyers: new Set(),
      uniqueSellers: new Set(),
      newWallets: new Set(),
      largeBuys: 0,
      largeSells: 0,
      avgBuySize: 0,
      avgSellSize: 0,
    };
    
    for (const bucket of bucketMap.values()) {
      if (bucket.end <= fromTs || bucket.start >= toTs) continue;
      
      snapshot.buyVolumeSol += bucket.buyVolumeSol;
      snapshot.sellVolumeSol += bucket.sellVolumeSol;
      snapshot.buyCount += bucket.buyCount;
      snapshot.sellCount += bucket.sellCount;
      snapshot.largeBuys += bucket.largeBuys;
      snapshot.largeSells += bucket.largeSells;
      
      bucket.uniqueBuyers.forEach(w => snapshot.uniqueBuyers.add(w));
      bucket.uniqueSellers.forEach(w => snapshot.uniqueSellers.add(w));
      bucket.newWallets.forEach(w => snapshot.newWallets.add(w));
    }
    
    snapshot.netBuyVolumeSol = snapshot.buyVolumeSol - snapshot.sellVolumeSol;
    snapshot.avgBuySize = snapshot.buyCount > 0 ? snapshot.buyVolumeSol / snapshot.buyCount : 0;
    snapshot.avgSellSize = snapshot.sellCount > 0 ? snapshot.sellVolumeSol / snapshot.sellCount : 0;
    
    return snapshot;
  }
  
  /**
   * 获取 1 小时基线(每分钟平均净买入)
   * 用于计算"量能爆发倍数"
   */
  getHourlyBaseline(tokenAddress: string): {
    netBuyPerMinute: number;
    uniqueBuyersPer5m: number;
    avgBuyVolume5m: number;
  } | null {
    const td = this.data.get(tokenAddress);
    if (!td) return null;
    
    // 缓存5分钟
    if (td.cachedHourlyAvg && Date.now() - td.cachedHourlyAvg.updatedAt < 5 * 60 * 1000) {
      return {
        netBuyPerMinute: td.cachedHourlyAvg.netBuyPerMinute,
        uniqueBuyersPer5m: td.cachedHourlyAvg.uniqueBuyersPer5m,
        avgBuyVolume5m: 0,
      };
    }
    
    const hourly = this.getHourlySnapshot(tokenAddress);
    if (!hourly || hourly.buyCount + hourly.sellCount < 10) {
      // 数据不足
      return null;
    }
    
    const netBuyPerMinute = hourly.netBuyVolumeSol / 60;
    
    // 5分钟独立买家平均: 把 1h 拆成 12 个 5m, 算平均
    let totalBuyersIn5mWindows = 0;
    let validWindows = 0;
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const winEnd = now - i * 5 * 60 * 1000;
      const winStart = winEnd - 5 * 60 * 1000;
      const winSnap = this.aggregateBuckets(td.buckets1m, winStart, winEnd, BUCKET_SIZE_1M);
      if (winSnap.buyCount + winSnap.sellCount > 0) {
        totalBuyersIn5mWindows += winSnap.uniqueBuyers.size;
        validWindows++;
      }
    }
    const uniqueBuyersPer5m = validWindows > 0 ? totalBuyersIn5mWindows / validWindows : 0;
    const avgBuyVolume5m = hourly.buyVolumeSol / 12;
    
    td.cachedHourlyAvg = {
      netBuyPerMinute,
      uniqueBuyersPer5m,
      updatedAt: Date.now(),
    };
    
    return { netBuyPerMinute, uniqueBuyersPer5m, avgBuyVolume5m };
  }
  
  /**
   * 检测连续 N 个 1分钟桶净买入是否为负
   * 用于退出信号
   */
  detectVolumeReversal(tokenAddress: string, consecutiveMinutes: number = 2): boolean {
    const td = this.data.get(tokenAddress);
    if (!td) return false;
    
    const now = Date.now();
    let consecutiveNegative = 0;
    
    for (let i = 0; i < consecutiveMinutes; i++) {
      const winEnd = now - i * BUCKET_SIZE_1M;
      const winStart = winEnd - BUCKET_SIZE_1M;
      const snap = this.aggregateBuckets(td.buckets1m, winStart, winEnd, BUCKET_SIZE_1M);
      
      // 如果该分钟无交易,跳过(不算反转)
      if (snap.buyCount + snap.sellCount === 0) return false;
      
      if (snap.netBuyVolumeSol < 0) consecutiveNegative++;
      else return false;
    }
    
    return consecutiveNegative >= consecutiveMinutes;
  }
  
  /**
   * 清理过期桶
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const td of this.data.values()) {
      cleaned += this.cleanBucketMap(td.buckets1m, now - RETENTION_1M);
      cleaned += this.cleanBucketMap(td.buckets5m, now - RETENTION_5M);
      cleaned += this.cleanBucketMap(td.buckets1h, now - RETENTION_1H);
    }
    
    if (cleaned > 0) {
      log.debug('Cleaned expired buckets', { count: cleaned, tokens: this.data.size });
    }
  }
  
  private cleanBucketMap(map: Map<number, InternalBucket>, cutoff: number): number {
    let removed = 0;
    for (const [start, bucket] of map.entries()) {
      if (bucket.end < cutoff) {
        map.delete(start);
        removed++;
      }
    }
    return removed;
  }
  
  getStats() {
    return {
      tokensTracked: this.data.size,
      totalSwaps: Array.from(this.data.values()).reduce((sum, t) => sum + t.totalSwaps, 0),
    };
  }
}

export const volumeAggregator = new VolumeAggregator();
