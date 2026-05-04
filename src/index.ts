/**
 * 主入口
 * 启动顺序: DB -> Helius WS -> VolumeAggregator -> TokenMonitor 
 *           -> SignalEngine -> TradingEngine -> ReportGenerator -> Dashboard
 */
import { config } from './utils/config';
import { getLogger } from './utils/logger';
import { db } from './db';
import { heliusService } from './services/helius';
import { volumeAggregator } from './core/volume-aggregator';
import { tokenMonitor } from './core/token-monitor';
import { signalEngine } from './core/signal-engine';
import { tradingEngine } from './core/trading-engine';
import { reportGenerator } from './services/report-generator';
import { dashboardServer } from './dashboard/server';

const log = getLogger('Main');

async function main() {
  log.info('===========================================');
  log.info('  SOL Trading Bot Starting');
  log.info('===========================================');
  log.info('Configuration', {
    dryRun: config.dryRun,
    nodeEnv: config.nodeEnv,
    maxMonitored: config.maxMonitoredTokens,
    maxConcurrentPositions: config.maxConcurrentPositions,
    maxTotalPositionSol: config.maxTotalPositionSol,
  });
  
  // ⚠️ 安全检查
  if (!config.dryRun) {
    log.warn('!!! LIVE TRADING MODE - REAL MONEY AT STAKE !!!');
    if (!config.walletPrivateKey) {
      log.error('WALLET_PRIVATE_KEY required when DRY_RUN=false');
      process.exit(1);
    }
  }
  
  try {
    // 1. 数据库已通过 import 初始化
    log.info('[1/7] Database ready');
    
    // 2. 连接 Helius WebSocket
    log.info('[2/7] Connecting to Helius...');
    try {
      await heliusService.connect();
    } catch (err: any) {
      log.warn('Helius WS connection failed (will retry)', { error: err.message });
      // 不阻塞启动,后台会重连
    }
    
    // 3. 启动量能聚合器
    log.info('[3/7] Starting VolumeAggregator');
    volumeAggregator.start();
    
    // 关键: 把Helius的swap事件接入聚合器
    heliusService.on('swap', (event) => {
      volumeAggregator.ingestSwap(event);
    });
    
    // 4. 启动监控池(会从DB加载已有代币并重新订阅)
    log.info('[4/7] Starting TokenMonitor');
    await tokenMonitor.start();
    
    // 5. 启动信号引擎
    log.info('[5/7] Starting SignalEngine');
    signalEngine.start();
    
    // 6. 启动交易引擎
    log.info('[6/7] Starting TradingEngine');
    tradingEngine.start();
    
    // 7. 启动报告生成器
    log.info('[7/7] Starting ReportGenerator');
    reportGenerator.start();
    
    // 启动 Dashboard
    log.info('Starting Dashboard server...');
    dashboardServer.start();
    
    log.info('===========================================');
    log.info('  Bot is running!');
    log.info(`  Dashboard: http://localhost:${config.dashboardPort}`);
    log.info(`  Webhook:   http://localhost:${config.dashboardPort}/webhook/add-token`);
    log.info('===========================================');
    
  } catch (err: any) {
    log.error('Startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ========== 优雅关闭 ==========
async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down...`);
  
  try {
    dashboardServer.stop();
    reportGenerator.stop();
    tradingEngine.stop();
    signalEngine.stop();
    tokenMonitor.stop();
    volumeAggregator.stop();
    heliusService.shutdown();
    db.close();
    
    log.info('Shutdown complete');
    process.exit(0);
  } catch (err: any) {
    log.error('Shutdown error', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});

main();
