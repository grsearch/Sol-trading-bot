/**
 * 全局配置管理
 * 从环境变量加载并提供类型安全的访问
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function getEnvNum(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const num = Number(v);
  if (isNaN(num)) throw new Error(`Invalid number for ${key}: ${v}`);
  return num;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() === 'true';
}

export const config = {
  // 服务
  dashboardPort: getEnvNum('DASHBOARD_PORT', 3001),
  webhookApiKey: getEnv('WEBHOOK_API_KEY', 'dev-key-change-this'),
  
  // API Keys
  birdeyeApiKey: getEnv('BIRDEYE_API_KEY', ''),
  heliusApiKey: getEnv('HELIUS_API_KEY', ''),
  jupiterApiKey: getEnv('JUPITER_API_KEY', ''),
  
  // RPC
  heliusRpcUrl: getEnv('HELIUS_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  heliusWssUrl: getEnv('HELIUS_WSS_URL', ''),
  heliusLaserStreamUrl: getEnv('HELIUS_LASERSTREAM_URL', ''),
  
  // 钱包
  walletPrivateKey: getEnv('WALLET_PRIVATE_KEY', ''),
  
  // 监控池
  maxMonitoredTokens: getEnvNum('MAX_MONITORED_TOKENS', 100),
  protectionPeriodMinutes: getEnvNum('PROTECTION_PERIOD_MINUTES', 60),
  cooldownPeriodHours: getEnvNum('COOLDOWN_PERIOD_HOURS', 24),
  
  // 退出阈值
  warningFdvUsd: getEnvNum('WARNING_FDV_USD', 80000),
  warningLpUsd: getEnvNum('WARNING_LP_USD', 25000),
  forceExitFdvUsd: getEnvNum('FORCE_EXIT_FDV_USD', 30000),
  forceExitLpUsd: getEnvNum('FORCE_EXIT_LP_USD', 10000),
  
  // 入池过滤
  minLpUsd: getEnvNum('MIN_LP_USD', 10000),
  minVolume24hUsd: getEnvNum('MIN_VOLUME_24H_USD', 50000),
  minHolders: getEnvNum('MIN_HOLDERS', 100),
  maxTop10Percent: getEnvNum('MAX_TOP10_PERCENT', 30),
  
  // 交易 (SOL本位 - 激进档默认)
  maxPositionSol: getEnvNum('MAX_POSITION_SOL', 1.5),
  maxTotalPositionSol: getEnvNum('MAX_TOTAL_POSITION_SOL', 20),
  maxConcurrentPositions: getEnvNum('MAX_CONCURRENT_POSITIONS', 10),
  defaultBuyAmountSol: getEnvNum('DEFAULT_BUY_AMOUNT_SOL', 0.5),
  defaultSlippageBps: getEnvNum('DEFAULT_SLIPPAGE_BPS', 300),
  priorityFeeMicroLamports: getEnvNum('PRIORITY_FEE_MICROLAMPORTS', 100000),
  
  // 风控
  stopLossPercent: getEnvNum('STOP_LOSS_PERCENT', 25),
  timeStopLossHours: getEnvNum('TIME_STOP_LOSS_HOURS', 10),
  tp1Percent: getEnvNum('TP1_PERCENT', 100),       // 2x
  tp1SellRatio: getEnvNum('TP1_SELL_RATIO', 50),
  tp2Percent: getEnvNum('TP2_PERCENT', 200),       // 3x
  tp2SellRatio: getEnvNum('TP2_SELL_RATIO', 100),  // 100% 清仓
  volumeReversalProfitThreshold: getEnvNum('VOLUME_REVERSAL_PROFIT_THRESHOLD', 25),
  
  // 信号
  volumeBurstMultiplier: getEnvNum('VOLUME_BURST_MULTIPLIER', 5),
  uniqueBuyersMultiplier: getEnvNum('UNIQUE_BUYERS_MULTIPLIER', 3),
  buySellRatioThreshold: getEnvNum('BUY_SELL_RATIO_THRESHOLD', 2.5),
  newWalletRatioThreshold: getEnvNum('NEW_WALLET_RATIO_THRESHOLD', 0.5),
  minBuySignalScore: getEnvNum('MIN_BUY_SIGNAL_SCORE', 65),
  
  // 大单检测 (SOL本位,相对统计)
  largeSwapMultiplier: getEnvNum('LARGE_SWAP_MULTIPLIER', 5),
  largeSwapMinSol: getEnvNum('LARGE_SWAP_MIN_SOL', 3),
  largeSellLpRatioThreshold: getEnvNum('LARGE_SELL_LP_RATIO_THRESHOLD', 0.05),
  
  // 系统
  nodeEnv: getEnv('NODE_ENV', 'development'),
  logLevel: getEnv('LOG_LEVEL', 'info'),
  dbPath: getEnv('DB_PATH', './data/trading-bot.db'),
  dryRun: getEnvBool('DRY_RUN', true),
  
  // 报告
  dailyReportHour: getEnvNum('DAILY_REPORT_HOUR', 8),
  dailyReportTimezone: getEnv('DAILY_REPORT_TIMEZONE', 'Asia/Shanghai'),
};

export type Config = typeof config;
