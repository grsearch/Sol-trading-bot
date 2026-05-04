/**
 * 交易引擎 (TradingEngine)
 * 
 * 职责:
 * - 监听 buy_signal / sell_signal / force_exit
 * - 仓位管理: 单币上限、总仓位上限、并发持仓数
 * - 执行交易(通过 Jupiter)
 * - 持仓状态维护(分批止盈、止损追踪)
 */
import { EventEmitter } from 'events';
import { v4 as uuid } from './uuid';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { db } from '../db';
import { jupiterService } from '../services/jupiter';
import { heliusService } from '../services/helius';
import { tokenMonitor } from './token-monitor';
import { signalEngine } from './signal-engine';
import {
  BuySignal, SellSignal, Position, Trade, MonitoredToken, SellReason,
} from '../types';

const log = getLogger('TradingEngine');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class TradingEngine extends EventEmitter {
  private isRunning = false;
  private pendingSignals = new Map<string, boolean>();  // token -> true
  private positionMonitorInterval: NodeJS.Timeout | null = null;
  
  start(): void {
    this.isRunning = true;
    
    // 监听信号
    signalEngine.on('buy_signal', (signal: BuySignal) => {
      this.handleBuySignal(signal).catch(err => {
        log.error('handleBuySignal error', { error: err.message });
      });
    });
    
    tokenMonitor.on('force_exit', ({ token, reason }: { token: MonitoredToken; reason: string }) => {
      this.forceExit(token, reason).catch(err => {
        log.error('forceExit error', { error: err.message });
      });
    });
    
    // 每30秒检查所有持仓的卖出信号
    this.positionMonitorInterval = setInterval(() => this.evaluateAllPositions(), 30 * 1000);
    
    log.info('TradingEngine started', { 
      dryRun: config.dryRun,
      maxConcurrent: config.maxConcurrentPositions,
    });
  }
  
  stop(): void {
    this.isRunning = false;
    if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
  }
  
  // ========== 买入流程 ==========
  
  private async handleBuySignal(signal: BuySignal): Promise<void> {
    const { tokenAddress, symbol, score, recommendedSize } = signal;
    
    // 防重复触发
    if (this.pendingSignals.has(tokenAddress)) {
      log.debug('Signal already pending', { symbol });
      return;
    }
    
    // 检查是否已有持仓
    const existing = db.getPositionByToken(tokenAddress);
    if (existing && (existing.status === 'open' || existing.status === 'partial')) {
      log.debug('Position already exists', { symbol });
      return;
    }
    
    // 仓位限制检查
    const openPositions = db.getOpenPositions();
    if (openPositions.length >= config.maxConcurrentPositions) {
      log.info('Max concurrent positions reached', { 
        symbol,
        current: openPositions.length,
        max: config.maxConcurrentPositions,
      });
      return;
    }
    
    const totalInvested = openPositions.reduce((sum, p) => sum + p.entryCostSol, 0);
    if (totalInvested + recommendedSize > config.maxTotalPositionSol) {
      log.info('Total position limit would be exceeded', { 
        symbol,
        current: totalInvested,
        attempt: recommendedSize,
        max: config.maxTotalPositionSol,
      });
      return;
    }
    
    this.pendingSignals.set(tokenAddress, true);
    
    try {
      const tokenForLog = tokenMonitor.getToken(tokenAddress);
      const isWarning = tokenForLog?.status === 'warning';
      
      log.info('Executing buy', {
        symbol,
        score: score.total,
        sizeSol: recommendedSize,
        ...(isWarning && { warningMode: true, note: 'Half position size due to warning status' }),
      });
      
      const result = await jupiterService.buy(
        tokenAddress,
        recommendedSize,
        config.defaultSlippageBps
      );
      
      if (!result.success || !result.signature) {
        log.error('Buy failed', { symbol, error: result.error });
        return;
      }
      
      // 创建持仓记录
      const tokenAmount = result.quote 
        ? Number(result.quote.outAmount) / Math.pow(10, await this.getTokenDecimals(tokenAddress))
        : 0;
      
      const priceSol = tokenAmount > 0 ? recommendedSize / tokenAmount : 0;
      const priceUsd = signal.marketData.price;
      
      const position: Position = {
        id: uuid(),
        tokenAddress,
        symbol,
        entryPrice: priceUsd,
        entryPriceSol: priceSol,
        entryAmount: tokenAmount,
        entryCostSol: recommendedSize,
        entryTimestamp: Date.now(),
        currentAmount: tokenAmount,
        realizedPnlSol: 0,
        highestPrice: priceUsd,
        lowestPrice: priceUsd,
        takeProfit1Hit: false,
        takeProfit2Hit: false,
        status: 'open',
        txSignatures: [result.signature],
      };
      
      db.upsertPosition(position);
      
      // 记录交易
      const trade: Trade = {
        id: uuid(),
        positionId: position.id,
        tokenAddress,
        symbol,
        type: 'buy',
        timestamp: Date.now(),
        tokenAmount,
        solAmount: recommendedSize,
        priceUsd,
        priceSol,
        slippageBps: config.defaultSlippageBps,
        feeSol: 0.000005 + config.priorityFeeMicroLamports / 1e9,
        txSignature: result.signature,
        status: 'success',
        reason: signal.triggeredBy.join('; '),
        signalScore: score.total,
      };
      db.insertTrade(trade);
      
      // 更新监控池
      tokenMonitor.markHasPosition(tokenAddress, true);
      
      log.info('Buy executed', {
        symbol,
        tokenAmount,
        costSol: recommendedSize,
        signature: result.signature,
      });
      
      this.emit('position_opened', position);
      
    } finally {
      this.pendingSignals.delete(tokenAddress);
    }
  }
  
  // ========== 卖出流程 ==========
  
  private async evaluateAllPositions(): Promise<void> {
    const positions = db.getOpenPositions();
    
    for (const pos of positions) {
      if (this.pendingSignals.has(pos.tokenAddress)) continue;
      
      const token = tokenMonitor.getToken(pos.tokenAddress);
      const signal = signalEngine.evaluateSellForPosition(pos, token);
      
      if (signal) {
        await this.executeSell(pos, signal).catch(err => {
          log.error('executeSell error', { 
            symbol: pos.symbol, error: err.message,
          });
        });
      }
    }
  }
  
  /**
   * 执行卖出
   */
  private async executeSell(position: Position, signal: SellSignal): Promise<void> {
    if (this.pendingSignals.has(position.tokenAddress)) return;
    this.pendingSignals.set(position.tokenAddress, true);
    
    try {
      // 决定卖出比例
      const { sellRatio, isFinal } = this.determineSellRatio(signal.reason, position);
      const sellAmount = position.currentAmount * sellRatio;
      
      if (sellAmount <= 0) {
        log.warn('Sell amount is zero, skipping', { symbol: position.symbol });
        return;
      }
      
      const decimals = await this.getTokenDecimals(position.tokenAddress);
      const sellAmountRaw = Math.floor(sellAmount * Math.pow(10, decimals)).toString();
      
      log.info('Executing sell', {
        symbol: position.symbol,
        reason: signal.reason,
        ratio: sellRatio,
        amount: sellAmount,
        urgency: signal.urgency,
      });
      
      // 紧急度对应滑点 (优化后:降低高紧急度的滑点,减少超额损失)
      // critical(force_exit): 1000bps = 10% (原1500bps)
      // high(stop_loss/large_sell): 500bps = 5% (原800bps,减少滑点超额)
      // medium(TP/reversal): 300bps = 3% (默认)
      // low(time_stop): 300bps = 3% (默认)
      const slippage = signal.urgency === 'critical' ? 1000
        : signal.urgency === 'high' ? 500
        : config.defaultSlippageBps;
      
      const result = await jupiterService.sell(
        position.tokenAddress,
        sellAmountRaw,
        slippage
      );
      
      if (!result.success || !result.signature) {
        log.error('Sell failed', { symbol: position.symbol, error: result.error });
        return;
      }
      
      const solReceived = result.quote 
        ? Number(result.quote.outAmount) / 1e9
        : 0;
      
      // 计算盈亏
      const costBasis = position.entryCostSol * sellRatio;  // 此次卖出对应的成本
      const pnlSol = solReceived - costBasis;
      const pnlPercent = costBasis > 0 ? (pnlSol / costBasis) * 100 : 0;
      
      // 更新持仓
      position.currentAmount -= sellAmount;
      position.realizedPnlSol += pnlSol;
      position.txSignatures.push(result.signature);
      
      if (signal.reason === 'take_profit_1') position.takeProfit1Hit = true;
      if (signal.reason === 'take_profit_2') position.takeProfit2Hit = true;
      
      if (isFinal || position.currentAmount < position.entryAmount * 0.01) {
        position.status = 'closed';
        position.currentAmount = 0;
      } else {
        position.status = 'partial';
      }
      
      db.upsertPosition(position);
      
      // 记录交易
      const tokenForPrice = tokenMonitor.getToken(position.tokenAddress);
      const trade: Trade = {
        id: uuid(),
        positionId: position.id,
        tokenAddress: position.tokenAddress,
        symbol: position.symbol,
        type: 'sell',
        timestamp: Date.now(),
        tokenAmount: sellAmount,
        solAmount: solReceived,
        priceUsd: tokenForPrice?.lastPrice ?? 0,
        priceSol: sellAmount > 0 ? solReceived / sellAmount : 0,
        slippageBps: slippage,
        feeSol: 0.000005 + config.priorityFeeMicroLamports / 1e9,
        txSignature: result.signature,
        status: 'success',
        reason: signal.reason,
        pnlSol,
        pnlPercent,
      };
      db.insertTrade(trade);
      
      log.info('Sell executed', {
        symbol: position.symbol,
        solReceived,
        pnlSol: pnlSol.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2) + '%',
        positionStatus: position.status,
      });
      
      // 如果完全平仓
      if (position.status === 'closed') {
        tokenMonitor.markHasPosition(position.tokenAddress, false);
        this.emit('position_closed', { position, trade });
        
        // 如果是强制退出,完成清算后从监控池移除
        if (signal.reason === 'force_exit_fdv' || signal.reason === 'force_exit_lp') {
          await tokenMonitor.removeToken(position.tokenAddress, signal.reason);
        }
      } else {
        this.emit('position_partial_close', { position, trade });
      }
      
    } finally {
      this.pendingSignals.delete(position.tokenAddress);
    }
  }
  
  private determineSellRatio(reason: SellReason, position: Position): { sellRatio: number; isFinal: boolean } {
    switch (reason) {
      case 'take_profit_1': {
        const ratio = config.tp1SellRatio / 100;
        // 如果配置成100%卖出,也是终止性的
        return { sellRatio: ratio, isFinal: ratio >= 0.999 };
      }
      case 'take_profit_2': {
        const ratio = config.tp2SellRatio / 100;
        // TP2若配置100%清仓,标记为isFinal,后续不会再触发
        return { sellRatio: ratio, isFinal: ratio >= 0.999 };
      }
      case 'stop_loss':
      case 'force_exit_fdv':
      case 'force_exit_lp':
      case 'large_sell':
      case 'concentration_spike':
        return { sellRatio: 1.0, isFinal: true };
      case 'volume_reversal':
      case 'time_stop':
        return { sellRatio: 1.0, isFinal: true };
      case 'manual':
      default:
        return { sellRatio: 1.0, isFinal: true };
    }
  }
  
  /**
   * 强制退出(由TokenMonitor触发)
   */
  private async forceExit(token: MonitoredToken, reason: string): Promise<void> {
    const position = db.getPositionByToken(token.address);
    if (!position) {
      // 没持仓直接移除
      await tokenMonitor.removeToken(token.address, reason);
      return;
    }
    
    const signal: SellSignal = {
      tokenAddress: token.address,
      symbol: token.symbol,
      timestamp: Date.now(),
      reason: reason.includes('lp') ? 'force_exit_lp' : 'force_exit_fdv',
      urgency: 'critical',
      triggeredBy: [`Force exit: ${reason}`],
    };
    
    await this.executeSell(position, signal);
  }
  
  // ========== 工具方法 ==========
  
  private async getTokenDecimals(tokenAddress: string): Promise<number> {
    const token = tokenMonitor.getToken(tokenAddress);
    if (token?.decimals) return token.decimals;
    
    try {
      const conn = heliusService.getConnection();
      const { PublicKey } = await import('@solana/web3.js');
      const info = await conn.getParsedAccountInfo(new PublicKey(tokenAddress));
      const parsed = (info.value?.data as any)?.parsed?.info;
      return parsed?.decimals ?? 9;
    } catch {
      return 9;
    }
  }
  
  // ========== 查询接口 ==========
  
  async getOpenPositionsWithPnL(): Promise<Array<Position & {
    currentPrice: number;
    unrealizedPnlSol: number;
    unrealizedPnlPercent: number;
  }>> {
    const positions = db.getOpenPositions();
    return positions.map(p => {
      const token = tokenMonitor.getToken(p.tokenAddress);
      const currentPrice = token?.lastPrice ?? 0;
      const currentValue = p.currentAmount * (currentPrice / (token?.lastPrice ?? 1));
      
      // 简化PnL计算: 当前价格估算
      const remainingValueSol = currentPrice > 0 && p.entryPrice > 0
        ? (p.currentAmount / p.entryAmount) * p.entryCostSol * (currentPrice / p.entryPrice)
        : 0;
      
      const remainingCostSol = (p.currentAmount / p.entryAmount) * p.entryCostSol;
      const unrealizedPnlSol = remainingValueSol - remainingCostSol;
      const unrealizedPnlPercent = remainingCostSol > 0 
        ? (unrealizedPnlSol / remainingCostSol) * 100 
        : 0;
      
      return {
        ...p,
        currentPrice,
        unrealizedPnlSol,
        unrealizedPnlPercent,
      };
    });
  }
  
  getStats() {
    const open = db.getOpenPositions();
    const totalInvested = open.reduce((s, p) => s + p.entryCostSol * (p.currentAmount / p.entryAmount), 0);
    return {
      openPositions: open.length,
      totalInvestedSol: totalInvested,
      capacityUsed: open.length / config.maxConcurrentPositions,
      pendingSignals: this.pendingSignals.size,
    };
  }
}

export const tradingEngine = new TradingEngine();
