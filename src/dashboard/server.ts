/**
 * Dashboard Express 服务器
 * 
 * 端点:
 * - POST /webhook/add-token  - 接收外部信号源推送
 * - GET  /api/tokens         - 监控池所有代币
 * - POST /api/tokens         - 手动添加代币
 * - DELETE /api/tokens/:address - 手动移除
 * - GET  /api/positions      - 当前持仓(含未实现盈亏)
 * - GET  /api/trades         - 交易记录
 * - GET  /api/stats/24h      - 24小时盈亏统计
 * - GET  /api/reports        - 日报列表
 * - GET  /api/reports/:date  - 单个日报
 * - POST /api/reports/generate - 手动生成今日报告
 * - GET  /api/system/status  - 系统状态
 */
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { db } from '../db';
import { tokenMonitor } from '../core/token-monitor';
import { tradingEngine } from '../core/trading-engine';
import { signalEngine } from '../core/signal-engine';
import { volumeAggregator } from '../core/volume-aggregator';
import { heliusService } from '../services/helius';
import { birdeyeService } from '../services/birdeye';
import { reportGenerator } from '../services/report-generator';
import { jupiterService } from '../services/jupiter';
import { WebhookPayload } from '../types';

const log = getLogger('Dashboard');

const REPORTS_DIR = path.join(process.cwd(), 'data', 'reports');

export class DashboardServer {
  private app: express.Express;
  private server: any;
  
  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json({ limit: '1mb' }));
    
    // 简单的请求日志
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      log.debug(`${req.method} ${req.path}`);
      next();
    });
  }
  
  /**
   * Webhook 鉴权中间件
   */
  private webhookAuth(req: Request, res: Response, next: NextFunction): void {
    const providedKey = req.header('x-api-key') || req.body?.apiKey;
    
    if (providedKey !== config.webhookApiKey) {
      log.warn('Unauthorized webhook attempt', { ip: req.ip });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }
  
  private setupRoutes(): void {
    // ==================== Webhook ====================
    this.app.post('/webhook/add-token', 
      this.webhookAuth.bind(this),
      async (req: Request, res: Response) => {
        try {
          const payload = req.body as WebhookPayload;
          
          // 校验 payload
          if (!payload.network || !payload.address || !payload.symbol) {
            res.status(400).json({ 
              error: 'missing_fields',
              required: ['network', 'address', 'symbol'],
            });
            return;
          }
          
          if (payload.network !== 'solana') {
            res.status(400).json({ error: 'unsupported_network' });
            return;
          }
          
          log.info('Webhook received', {
            address: payload.address,
            symbol: payload.symbol,
            source: payload.source,
          });
          
          const result = await tokenMonitor.handleWebhook(payload);
          
          if (result.success) {
            res.json({
              success: true,
              token: {
                address: result.token!.address,
                symbol: result.token!.symbol,
                status: result.token!.status,
                addedAt: result.token!.addedAt,
              },
            });
          } else {
            res.status(400).json({ 
              success: false,
              reason: result.reason,
            });
          }
        } catch (err: any) {
          log.error('Webhook error', { error: err.message });
          res.status(500).json({ error: err.message });
        }
      }
    );
    
    // ==================== 代币监控池 ====================
    this.app.get('/api/tokens', (_req: Request, res: Response) => {
      const tokens = tokenMonitor.getAllTokens();
      const enriched = tokens.map(t => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        status: t.status,
        hasPosition: t.hasPosition,
        addedAt: t.addedAt,
        addedVia: t.addedVia,
        sourceDetail: t.sourceDetail,
        protectionUntil: t.protectionUntil,
        listedAt: t.listedAt,
        ageDays: (Date.now() - t.listedAt) / (24 * 3600 * 1000),
        lastFdv: t.lastFdv,
        lastLiquidity: t.lastLiquidity,
        lastVolume24h: t.lastVolume24h,
        lastHolders: t.lastHolders,
        lastPrice: t.lastPrice,
        lastUpdated: t.lastUpdated,
        currentScore: t.currentScore,
        poolType: t.pool?.type,
      }));
      
      // 按score降序排列
      enriched.sort((a, b) => b.currentScore - a.currentScore);
      
      res.json({
        total: enriched.length,
        capacity: config.maxMonitoredTokens,
        capacityUsed: enriched.length / config.maxMonitoredTokens,
        tokens: enriched,
      });
    });
    
    this.app.get('/api/tokens/:address', (req: Request, res: Response) => {
      const token = tokenMonitor.getToken(req.params.address);
      if (!token) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      
      // 附加量能数据
      const volumeData = {
        fiveMin: this.serializeSnapshot(volumeAggregator.getFiveMinSnapshot(token.address)),
        oneMin: this.serializeSnapshot(volumeAggregator.getOneMinSnapshot(token.address)),
        baseline: volumeAggregator.getHourlyBaseline(token.address),
      };
      
      res.json({ token, volumeData });
    });
    
    this.app.post('/api/tokens', async (req: Request, res: Response) => {
      try {
        const { address, symbol } = req.body;
        if (!address) {
          res.status(400).json({ error: 'address_required' });
          return;
        }
        
        const result = await tokenMonitor.addToken({
          address,
          symbol,
          via: 'manual',
          sourceDetail: 'dashboard',
        });
        
        if (result.success) {
          res.json({ success: true, token: result.token });
        } else {
          res.status(400).json({ success: false, reason: result.reason });
        }
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    this.app.delete('/api/tokens/:address', async (req: Request, res: Response) => {
      try {
        const result = await tokenMonitor.removeToken(req.params.address, 'manual_removal');
        res.json({ success: result });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    // ==================== 持仓 ====================
    this.app.get('/api/positions', async (_req: Request, res: Response) => {
      try {
        const positions = await tradingEngine.getOpenPositionsWithPnL();
        res.json({ 
          total: positions.length,
          positions,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    // ==================== 交易记录 ====================
    this.app.get('/api/trades', (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const trades = db.getRecentTrades(limit);
      res.json({ total: trades.length, trades });
    });
    
    // ==================== 24h 统计 (SOL本位) ====================
    this.app.get('/api/stats/24h', (_req: Request, res: Response) => {
      const stats = db.get24hStats();
      const winRate = stats.totalTrades > 0 
        ? stats.winningTrades / stats.totalTrades 
        : 0;
      
      res.json({
        totalTrades: stats.totalTrades,
        winningTrades: stats.winningTrades,
        losingTrades: stats.losingTrades,
        winRate,
        pnlSol: stats.pnlSol,
      });
    });
    
    // ==================== 日报 ====================
    this.app.get('/api/reports', (_req: Request, res: Response) => {
      try {
        const reports = db.getRecentReports(30);
        const summary = reports.map((r: any) => ({
          date: r.date,
          generatedAt: r.generatedAt,
          totalTrades: r.summary.totalTrades,
          winRate: r.summary.winRate,
          totalPnlSol: r.summary.totalPnlSol,
          totalPnlUsd: r.summary.totalPnlUsd,
        }));
        res.json({ total: summary.length, reports: summary });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    this.app.get('/api/reports/:date', (req: Request, res: Response) => {
      const report = db.getDailyReport(req.params.date);
      if (!report) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(report);
    });
    
    this.app.get('/api/reports/:date/markdown', (req: Request, res: Response) => {
      const mdPath = path.join(REPORTS_DIR, `report-${req.params.date}.md`);
      if (!fs.existsSync(mdPath)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.type('text/markdown').send(fs.readFileSync(mdPath, 'utf-8'));
    });
    
    this.app.post('/api/reports/generate', async (req: Request, res: Response) => {
      try {
        const date = req.body?.date;
        const report = await reportGenerator.generateDailyReport(date);
        res.json({ success: true, report });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    // ==================== 系统状态 ====================
    this.app.get('/api/system/status', async (_req: Request, res: Response) => {
      try {
        const monitorStats = tokenMonitor.getStats();
        const tradingStats = tradingEngine.getStats();
        const heliusStats = heliusService.getStats();
        const volumeStats = volumeAggregator.getStats();
        const birdeyeStats = birdeyeService.getCuUsageStats();
        
        let walletBalance = 0;
        const walletPubkey = jupiterService.getWalletPublicKey();
        if (walletPubkey) {
          try {
            walletBalance = await heliusService.getSolBalance(walletPubkey);
          } catch {}
        }
        
        res.json({
          dryRun: config.dryRun,
          wallet: {
            publicKey: walletPubkey,
            solBalance: walletBalance,
          },
          monitor: monitorStats,
          trading: tradingStats,
          helius: heliusStats,
          volume: volumeStats,
          birdeye: birdeyeStats,
          uptime: process.uptime(),
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    
    // ==================== 静态文件 ====================
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    
    // 404
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'not_found' });
    });
  }
  
  private serializeSnapshot(snap: any): any {
    if (!snap) return null;
    return {
      ...snap,
      uniqueBuyers: snap.uniqueBuyers.size,
      uniqueSellers: snap.uniqueSellers.size,
      newWallets: snap.newWallets.size,
    };
  }
  
  start(): void {
    this.server = this.app.listen(config.dashboardPort, () => {
      log.info('Dashboard server listening', { 
        port: config.dashboardPort,
        url: `http://localhost:${config.dashboardPort}`,
      });
    });
  }
  
  stop(): void {
    if (this.server) {
      this.server.close();
      log.info('Dashboard server stopped');
    }
  }
}

export const dashboardServer = new DashboardServer();
