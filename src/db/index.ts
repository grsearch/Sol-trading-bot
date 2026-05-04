/**
 * SQLite 数据库模块
 * 使用 better-sqlite3 (同步API,适合本地工具)
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { MonitoredToken, Position, Trade, TokenStatus } from '../types';

const log = getLogger('Database');

class DBManager {
  private db: Database.Database;
  
  constructor() {
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    
    this.initSchema();
    log.info('Database initialized', { path: config.dbPath });
  }
  
  private initSchema() {
    // 监控池表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_tokens (
        address TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        decimals INTEGER NOT NULL,
        pool_address TEXT,
        pool_type TEXT,
        added_at INTEGER NOT NULL,
        added_via TEXT NOT NULL,
        source_detail TEXT,
        protection_until INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        has_position INTEGER NOT NULL DEFAULT 0,
        last_fdv REAL DEFAULT 0,
        last_liquidity REAL DEFAULT 0,
        last_volume_24h REAL DEFAULT 0,
        last_holders INTEGER DEFAULT 0,
        last_price REAL DEFAULT 0,
        last_updated INTEGER DEFAULT 0,
        holder_trend TEXT DEFAULT '[]',
        score_history TEXT DEFAULT '[]',
        current_score REAL DEFAULT 0,
        listed_at INTEGER NOT NULL,
        price_history TEXT DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_monitored_status ON monitored_tokens(status);
      CREATE INDEX IF NOT EXISTS idx_monitored_score ON monitored_tokens(current_score);
    `);
    
    // 数据库迁移: 给已存在的表加 price_history 列(如果还没有)
    try {
      this.db.exec(`ALTER TABLE monitored_tokens ADD COLUMN price_history TEXT DEFAULT '[]'`);
      log.info('Schema migration: added price_history column');
    } catch (err: any) {
      // 列已存在,忽略
      if (!err.message.includes('duplicate column')) {
        log.debug('price_history column check', { error: err.message });
      }
    }
    
    // 代币生命周期记录(进出历史)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_lifecycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        added_via TEXT NOT NULL,
        source_detail TEXT,
        removed_at INTEGER,
        removed_reason TEXT,
        peak_fdv REAL DEFAULT 0,
        peak_volume_24h REAL DEFAULT 0,
        had_position INTEGER DEFAULT 0,
        position_pnl_sol REAL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_lifecycle_address ON token_lifecycle(address);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_added_at ON token_lifecycle(added_at);
    `);
    
    // 冷却期表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cooldown_tokens (
        address TEXT PRIMARY KEY,
        cooldown_until INTEGER NOT NULL,
        reason TEXT
      );
    `);
    
    // 持仓表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        entry_price REAL NOT NULL,
        entry_price_sol REAL NOT NULL,
        entry_amount REAL NOT NULL,
        entry_cost_sol REAL NOT NULL,
        entry_timestamp INTEGER NOT NULL,
        current_amount REAL NOT NULL,
        realized_pnl_sol REAL DEFAULT 0,
        highest_price REAL DEFAULT 0,
        lowest_price REAL DEFAULT 0,
        take_profit_1_hit INTEGER DEFAULT 0,
        take_profit_2_hit INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        tx_signatures TEXT DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_address);
    `);
    
    // 交易记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        token_amount REAL NOT NULL,
        sol_amount REAL NOT NULL,
        price_usd REAL NOT NULL,
        price_sol REAL NOT NULL,
        slippage_bps INTEGER,
        fee_sol REAL DEFAULT 0,
        tx_signature TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        signal_score REAL,
        pnl_sol REAL,
        pnl_percent REAL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
      CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);
    `);
    
    // 信号记录表(用于复盘)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        score REAL,
        score_breakdown TEXT,
        reasons TEXT,
        market_snapshot TEXT,
        executed INTEGER DEFAULT 0,
        trade_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
      CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token_address);
    `);
    
    // 日报表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_reports (
        date TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        total_trades INTEGER,
        winning_trades INTEGER,
        losing_trades INTEGER,
        total_pnl_sol REAL,
        total_pnl_usd REAL,
        report_data TEXT NOT NULL
      );
    `);
    
    // Webhook来源统计
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_sources (
        source_name TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        tokens_pushed INTEGER DEFAULT 0,
        tokens_passed_filter INTEGER DEFAULT 0,
        tokens_traded INTEGER DEFAULT 0,
        cumulative_pnl_sol REAL DEFAULT 0
      );
    `);
  }
  
  // ========== 监控池操作 ==========
  
  upsertMonitoredToken(token: MonitoredToken): void {
    const stmt = this.db.prepare(`
      INSERT INTO monitored_tokens (
        address, symbol, name, decimals, pool_address, pool_type,
        added_at, added_via, source_detail, protection_until,
        status, has_position, last_fdv, last_liquidity,
        last_volume_24h, last_holders, last_price, last_updated,
        holder_trend, score_history, current_score, listed_at,
        price_history
      ) VALUES (
        @address, @symbol, @name, @decimals, @pool_address, @pool_type,
        @added_at, @added_via, @source_detail, @protection_until,
        @status, @has_position, @last_fdv, @last_liquidity,
        @last_volume_24h, @last_holders, @last_price, @last_updated,
        @holder_trend, @score_history, @current_score, @listed_at,
        @price_history
      )
      ON CONFLICT(address) DO UPDATE SET
        symbol = excluded.symbol,
        name = excluded.name,
        status = excluded.status,
        has_position = excluded.has_position,
        last_fdv = excluded.last_fdv,
        last_liquidity = excluded.last_liquidity,
        last_volume_24h = excluded.last_volume_24h,
        last_holders = excluded.last_holders,
        last_price = excluded.last_price,
        last_updated = excluded.last_updated,
        holder_trend = excluded.holder_trend,
        score_history = excluded.score_history,
        current_score = excluded.current_score,
        price_history = excluded.price_history
    `);
    
    stmt.run({
      address: token.address,
      symbol: token.symbol,
      name: token.name ?? null,
      decimals: token.decimals,
      pool_address: token.pool?.address ?? null,
      pool_type: token.pool?.type ?? null,
      added_at: token.addedAt,
      added_via: token.addedVia,
      source_detail: token.sourceDetail ?? null,
      protection_until: token.protectionUntil,
      status: token.status,
      has_position: token.hasPosition ? 1 : 0,
      last_fdv: token.lastFdv,
      last_liquidity: token.lastLiquidity,
      last_volume_24h: token.lastVolume24h,
      last_holders: token.lastHolders,
      last_price: token.lastPrice,
      last_updated: token.lastUpdated,
      holder_trend: JSON.stringify(token.holderTrend),
      score_history: JSON.stringify(token.scoreHistory),
      current_score: token.currentScore,
      listed_at: token.listedAt,
      price_history: JSON.stringify(token.priceHistory ?? []),
    });
  }
  
  getAllMonitoredTokens(): MonitoredToken[] {
    const rows = this.db.prepare('SELECT * FROM monitored_tokens').all() as any[];
    return rows.map(this.rowToMonitoredToken);
  }
  
  getMonitoredToken(address: string): MonitoredToken | null {
    const row = this.db.prepare('SELECT * FROM monitored_tokens WHERE address = ?').get(address) as any;
    return row ? this.rowToMonitoredToken(row) : null;
  }
  
  removeMonitoredToken(address: string, reason: string): void {
    const token = this.getMonitoredToken(address);
    if (!token) return;
    
    // 写入生命周期记录
    this.db.prepare(`
      UPDATE token_lifecycle 
      SET removed_at = ?, removed_reason = ?
      WHERE address = ? AND removed_at IS NULL
    `).run(Date.now(), reason, address);
    
    // 从监控池移除
    this.db.prepare('DELETE FROM monitored_tokens WHERE address = ?').run(address);
    
    log.info('Token removed from monitoring', { address, symbol: token.symbol, reason });
  }
  
  countMonitoredTokens(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM monitored_tokens').get() as any;
    return result.count;
  }
  
  getEligibleForRemoval(): MonitoredToken[] {
    // 排除保护期内的、有持仓的(除非是force_exit触发)
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT * FROM monitored_tokens 
      WHERE protection_until < ? AND has_position = 0
      ORDER BY current_score ASC
    `).all(now) as any[];
    return rows.map(this.rowToMonitoredToken);
  }
  
  private rowToMonitoredToken(row: any): MonitoredToken {
    return {
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      pool: row.pool_address ? {
        address: row.pool_address,
        type: row.pool_type,
        baseToken: row.address,
        quoteToken: 'So11111111111111111111111111111111111111112',
      } : undefined,
      addedAt: row.added_at,
      addedVia: row.added_via,
      sourceDetail: row.source_detail,
      protectionUntil: row.protection_until,
      status: row.status,
      hasPosition: !!row.has_position,
      lastFdv: row.last_fdv,
      lastLiquidity: row.last_liquidity,
      lastVolume24h: row.last_volume_24h,
      lastHolders: row.last_holders,
      lastPrice: row.last_price,
      lastUpdated: row.last_updated,
      holderTrend: JSON.parse(row.holder_trend || '[]'),
      scoreHistory: JSON.parse(row.score_history || '[]'),
      currentScore: row.current_score,
      listedAt: row.listed_at,
      priceHistory: JSON.parse(row.price_history || '[]'),
    };
  }
  
  // ========== 生命周期记录 ==========
  
  addLifecycleEntry(token: MonitoredToken): void {
    this.db.prepare(`
      INSERT INTO token_lifecycle (address, symbol, added_at, added_via, source_detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(token.address, token.symbol, token.addedAt, token.addedVia, token.sourceDetail ?? null);
  }
  
  // ========== 冷却期 ==========
  
  isInCooldown(address: string): boolean {
    const row = this.db.prepare('SELECT cooldown_until FROM cooldown_tokens WHERE address = ?').get(address) as any;
    if (!row) return false;
    if (row.cooldown_until < Date.now()) {
      this.db.prepare('DELETE FROM cooldown_tokens WHERE address = ?').run(address);
      return false;
    }
    return true;
  }
  
  addCooldown(address: string, untilTimestamp: number, reason: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO cooldown_tokens (address, cooldown_until, reason)
      VALUES (?, ?, ?)
    `).run(address, untilTimestamp, reason);
  }
  
  // ========== 持仓 ==========
  
  upsertPosition(pos: Position): void {
    this.db.prepare(`
      INSERT INTO positions (
        id, token_address, symbol, entry_price, entry_price_sol,
        entry_amount, entry_cost_sol, entry_timestamp, current_amount,
        realized_pnl_sol, highest_price, lowest_price,
        take_profit_1_hit, take_profit_2_hit, status, tx_signatures
      ) VALUES (
        @id, @token_address, @symbol, @entry_price, @entry_price_sol,
        @entry_amount, @entry_cost_sol, @entry_timestamp, @current_amount,
        @realized_pnl_sol, @highest_price, @lowest_price,
        @take_profit_1_hit, @take_profit_2_hit, @status, @tx_signatures
      )
      ON CONFLICT(id) DO UPDATE SET
        current_amount = excluded.current_amount,
        realized_pnl_sol = excluded.realized_pnl_sol,
        highest_price = excluded.highest_price,
        lowest_price = excluded.lowest_price,
        take_profit_1_hit = excluded.take_profit_1_hit,
        take_profit_2_hit = excluded.take_profit_2_hit,
        status = excluded.status,
        tx_signatures = excluded.tx_signatures
    `).run({
      id: pos.id,
      token_address: pos.tokenAddress,
      symbol: pos.symbol,
      entry_price: pos.entryPrice,
      entry_price_sol: pos.entryPriceSol,
      entry_amount: pos.entryAmount,
      entry_cost_sol: pos.entryCostSol,
      entry_timestamp: pos.entryTimestamp,
      current_amount: pos.currentAmount,
      realized_pnl_sol: pos.realizedPnlSol,
      highest_price: pos.highestPrice,
      lowest_price: pos.lowestPrice,
      take_profit_1_hit: pos.takeProfit1Hit ? 1 : 0,
      take_profit_2_hit: pos.takeProfit2Hit ? 1 : 0,
      status: pos.status,
      tx_signatures: JSON.stringify(pos.txSignatures),
    });
  }
  
  getOpenPositions(): Position[] {
    const rows = this.db.prepare(`SELECT * FROM positions WHERE status IN ('open', 'partial')`).all() as any[];
    return rows.map(this.rowToPosition);
  }
  
  getPositionByToken(tokenAddress: string): Position | null {
    const row = this.db.prepare(`
      SELECT * FROM positions 
      WHERE token_address = ? AND status IN ('open', 'partial')
      ORDER BY entry_timestamp DESC LIMIT 1
    `).get(tokenAddress) as any;
    return row ? this.rowToPosition(row) : null;
  }
  
  private rowToPosition(row: any): Position {
    return {
      id: row.id,
      tokenAddress: row.token_address,
      symbol: row.symbol,
      entryPrice: row.entry_price,
      entryPriceSol: row.entry_price_sol,
      entryAmount: row.entry_amount,
      entryCostSol: row.entry_cost_sol,
      entryTimestamp: row.entry_timestamp,
      currentAmount: row.current_amount,
      realizedPnlSol: row.realized_pnl_sol,
      highestPrice: row.highest_price,
      lowestPrice: row.lowest_price,
      takeProfit1Hit: !!row.take_profit_1_hit,
      takeProfit2Hit: !!row.take_profit_2_hit,
      status: row.status,
      txSignatures: JSON.parse(row.tx_signatures || '[]'),
    };
  }
  
  // ========== 交易记录 ==========
  
  insertTrade(trade: Trade): void {
    this.db.prepare(`
      INSERT INTO trades (
        id, position_id, token_address, symbol, type, timestamp,
        token_amount, sol_amount, price_usd, price_sol,
        slippage_bps, fee_sol, tx_signature, status, reason,
        signal_score, pnl_sol, pnl_percent
      ) VALUES (
        @id, @position_id, @token_address, @symbol, @type, @timestamp,
        @token_amount, @sol_amount, @price_usd, @price_sol,
        @slippage_bps, @fee_sol, @tx_signature, @status, @reason,
        @signal_score, @pnl_sol, @pnl_percent
      )
    `).run({
      id: trade.id,
      position_id: trade.positionId,
      token_address: trade.tokenAddress,
      symbol: trade.symbol,
      type: trade.type,
      timestamp: trade.timestamp,
      token_amount: trade.tokenAmount,
      sol_amount: trade.solAmount,
      price_usd: trade.priceUsd,
      price_sol: trade.priceSol,
      slippage_bps: trade.slippageBps,
      fee_sol: trade.feeSol,
      tx_signature: trade.txSignature,
      status: trade.status,
      reason: trade.reason ?? null,
      signal_score: trade.signalScore ?? null,
      pnl_sol: trade.pnlSol ?? null,
      pnl_percent: trade.pnlPercent ?? null,
    });
  }
  
  getTradesInRange(startTs: number, endTs: number): Trade[] {
    const rows = this.db.prepare(`
      SELECT * FROM trades 
      WHERE timestamp >= ? AND timestamp < ?
      ORDER BY timestamp DESC
    `).all(startTs, endTs) as any[];
    return rows.map(this.rowToTrade);
  }
  
  getRecentTrades(limit: number = 50): Trade[] {
    const rows = this.db.prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`).all(limit) as any[];
    return rows.map(this.rowToTrade);
  }
  
  getTradesByPosition(positionId: string): Trade[] {
    const rows = this.db.prepare(`SELECT * FROM trades WHERE position_id = ? ORDER BY timestamp ASC`).all(positionId) as any[];
    return rows.map(this.rowToTrade);
  }
  
  private rowToTrade(row: any): Trade {
    return {
      id: row.id,
      positionId: row.position_id,
      tokenAddress: row.token_address,
      symbol: row.symbol,
      type: row.type,
      timestamp: row.timestamp,
      tokenAmount: row.token_amount,
      solAmount: row.sol_amount,
      priceUsd: row.price_usd,
      priceSol: row.price_sol,
      slippageBps: row.slippage_bps,
      feeSol: row.fee_sol,
      txSignature: row.tx_signature,
      status: row.status,
      reason: row.reason,
      signalScore: row.signal_score,
      pnlSol: row.pnl_sol,
      pnlPercent: row.pnl_percent,
    };
  }
  
  // ========== 信号记录 ==========
  
  insertSignal(data: {
    tokenAddress: string;
    symbol: string;
    signalType: string;
    timestamp: number;
    score?: number;
    scoreBreakdown?: object;
    reasons: string[];
    marketSnapshot?: object;
    executed?: boolean;
    tradeId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO signals (
        token_address, symbol, signal_type, timestamp, score,
        score_breakdown, reasons, market_snapshot, executed, trade_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.tokenAddress,
      data.symbol,
      data.signalType,
      data.timestamp,
      data.score ?? null,
      data.scoreBreakdown ? JSON.stringify(data.scoreBreakdown) : null,
      JSON.stringify(data.reasons),
      data.marketSnapshot ? JSON.stringify(data.marketSnapshot) : null,
      data.executed ? 1 : 0,
      data.tradeId ?? null,
    );
  }
  
  // ========== 日报 ==========
  
  saveDailyReport(date: string, report: any): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO daily_reports (
        date, generated_at, total_trades, winning_trades, losing_trades,
        total_pnl_sol, total_pnl_usd, report_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      date,
      Date.now(),
      report.summary.totalTrades,
      report.summary.winningTrades,
      report.summary.losingTrades,
      report.summary.totalPnlSol,
      report.summary.totalPnlUsd,
      JSON.stringify(report),
    );
  }
  
  getDailyReport(date: string): any {
    const row = this.db.prepare('SELECT * FROM daily_reports WHERE date = ?').get(date) as any;
    return row ? JSON.parse(row.report_data) : null;
  }
  
  getRecentReports(limit: number = 30): any[] {
    const rows = this.db.prepare('SELECT * FROM daily_reports ORDER BY date DESC LIMIT ?').all(limit) as any[];
    return rows.map(r => JSON.parse(r.report_data));
  }
  
  // ========== 统计 ==========
  
  get24hStats(): {
    totalTrades: number;
    pnlSol: number;
    winningTrades: number;
    losingTrades: number;
  } {
    const since = Date.now() - 24 * 3600 * 1000;
    const result = this.db.prepare(`
      SELECT 
        COUNT(*) as total_trades,
        COALESCE(SUM(pnl_sol), 0) as pnl_sol,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as winning,
        SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losing
      FROM trades 
      WHERE timestamp >= ? AND type = 'sell' AND status = 'success'
    `).get(since) as any;
    
    return {
      totalTrades: result.total_trades || 0,
      pnlSol: result.pnl_sol || 0,
      winningTrades: result.winning || 0,
      losingTrades: result.losing || 0,
    };
  }
  
  close(): void {
    this.db.close();
  }
}

export const db = new DBManager();
