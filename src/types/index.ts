/**
 * 核心类型定义
 */

// ==================== 代币相关 ====================

export interface TokenInfo {
  address: string;          // CA地址
  symbol: string;           // 代币符号
  name?: string;
  decimals: number;
  logoURI?: string;
}

export interface TokenMarketData {
  address: string;
  symbol: string;
  price: number;            // USD
  priceSol?: number;
  fdv: number;              // 完全稀释估值
  marketCap?: number;
  liquidity: number;        // 流动性 (USD)
  volume24h: number;
  volumeChange24h?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  holders: number;
  top10HoldersPercent?: number;
  createdAt: number;        // 上线时间戳
  pool?: PoolInfo;
}

export interface PoolInfo {
  address: string;
  type: 'raydium' | 'meteora' | 'pumpfun' | 'orca' | 'unknown';
  baseToken: string;
  quoteToken: string;
  baseReserve?: number;
  quoteReserve?: number;
}

// ==================== 监控池管理 ====================

export type TokenStatus = 'active' | 'warning' | 'exiting' | 'protected';
export type AddSource = 'manual' | 'webhook';

export interface MonitoredToken {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  pool?: PoolInfo;
  
  addedAt: number;
  addedVia: AddSource;
  sourceDetail?: string;
  protectionUntil: number;  // 保护期截止
  
  status: TokenStatus;
  hasPosition: boolean;
  
  // 最新市场数据
  lastFdv: number;
  lastLiquidity: number;
  lastVolume24h: number;
  lastHolders: number;
  lastPrice: number;
  lastUpdated: number;
  
  // 历史趋势(用于评分)
  holderTrend: number[];    // 最近持币地址数序列
  scoreHistory: number[];   // 评分历史
  currentScore: number;
  
  // 上线时间
  listedAt: number;
}

// ==================== 量能数据 ====================

export interface VolumeSnapshot {
  timestamp: number;        // 桶起始时间(秒)
  bucketSize: number;       // 桶大小(秒): 60, 300, 3600
  
  buyVolumeSol: number;     // 买入总额(SOL)
  sellVolumeSol: number;    // 卖出总额(SOL)
  netBuyVolumeSol: number;  // 净买入(SOL)
  
  buyCount: number;
  sellCount: number;
  
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  
  newWallets: Set<string>;  // 首次交互此代币的钱包
  
  largeBuys: number;        // 大额买单数(>1 SOL)
  largeSells: number;
  
  avgBuySize: number;
  avgSellSize: number;
}

export interface SwapEvent {
  signature: string;
  timestamp: number;
  poolAddress: string;
  tokenAddress: string;
  walletAddress: string;
  
  type: 'buy' | 'sell';
  tokenAmount: number;
  solAmount: number;
  priceUsd?: number;
  
  isNewWallet?: boolean;    // 该钱包是否首次交互此代币
}

// ==================== 信号系统 ====================

export interface SignalScore {
  total: number;            // 0-100
  breakdown: {
    volumeBurst: number;
    walletStructure: number;
    priceStructure: number;
    safety: number;
  };
  reasons: string[];
}

export interface BuySignal {
  tokenAddress: string;
  symbol: string;
  timestamp: number;
  score: SignalScore;
  triggeredBy: string[];
  marketData: TokenMarketData;
  recommendedSize: number;  // 推荐仓位大小(SOL)
}

export interface SellSignal {
  tokenAddress: string;
  symbol: string;
  timestamp: number;
  reason: SellReason;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  triggeredBy: string[];
}

export type SellReason = 
  | 'take_profit_1'
  | 'take_profit_2'
  | 'stop_loss'
  | 'time_stop'
  | 'volume_reversal'
  | 'large_sell'
  | 'concentration_spike'
  | 'force_exit_fdv'
  | 'force_exit_lp'
  | 'manual';

// ==================== 持仓与交易 ====================

export interface Position {
  id: string;
  tokenAddress: string;
  symbol: string;
  
  entryPrice: number;       // USD
  entryPriceSol: number;
  entryAmount: number;      // 代币数量
  entryCostSol: number;     // 投入SOL
  entryTimestamp: number;
  
  currentAmount: number;    // 当前持有数量
  realizedPnlSol: number;   // 已实现盈亏(SOL)
  
  highestPrice: number;
  lowestPrice: number;
  
  takeProfit1Hit: boolean;
  takeProfit2Hit: boolean;
  
  status: 'open' | 'partial' | 'closed';
  
  txSignatures: string[];
}

export interface Trade {
  id: string;
  positionId: string;
  tokenAddress: string;
  symbol: string;
  
  type: 'buy' | 'sell';
  timestamp: number;
  
  tokenAmount: number;
  solAmount: number;
  priceUsd: number;
  priceSol: number;
  
  slippageBps: number;
  feeSol: number;
  
  txSignature: string;
  status: 'pending' | 'success' | 'failed';
  
  reason?: string;          // 触发原因
  signalScore?: number;
  
  pnlSol?: number;          // 仅sell有
  pnlPercent?: number;
}

// ==================== Webhook ====================

export interface WebhookPayload {
  network: string;
  address: string;
  symbol: string;
  source?: string;
  priority?: 'low' | 'normal' | 'high';
  context?: string;
  metadata?: Record<string, any>;
}

// ==================== 报告 ====================

export interface DailyReport {
  date: string;             // YYYY-MM-DD
  generatedAt: number;
  
  summary: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    
    totalPnlSol: number;
    totalPnlUsd: number;
    
    bestTrade: { symbol: string; pnlSol: number; pnlPercent: number } | null;
    worstTrade: { symbol: string; pnlSol: number; pnlPercent: number } | null;
    
    avgHoldingTimeMin: number;
  };
  
  monitoringSummary: {
    totalMonitored: number;
    addedToday: number;
    removedToday: number;
    currentlyHeld: number;
  };
  
  trades: Trade[];
  positions: Position[];
  newTokens: MonitoredToken[];
  removedTokens: { token: MonitoredToken; reason: string }[];
}
