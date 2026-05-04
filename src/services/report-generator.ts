/**
 * 日报生成器
 * 每日 8:00 生成前一日的交易报告
 */
import * as cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { db } from '../db';
import { tokenMonitor } from '../core/token-monitor';
import { DailyReport, Trade, MonitoredToken } from '../types';

const log = getLogger('ReportGen');

const REPORTS_DIR = path.join(process.cwd(), 'data', 'reports');

export class ReportGenerator {
  private cronJob: cron.ScheduledTask | null = null;
  
  start(): void {
    if (!fs.existsSync(REPORTS_DIR)) {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }
    
    // 每日 8:00 触发
    const cronExpr = `0 ${config.dailyReportHour} * * *`;
    
    this.cronJob = cron.schedule(cronExpr, () => {
      this.generateDailyReport().catch(err => {
        log.error('Daily report generation failed', { error: err.message });
      });
    }, { timezone: config.dailyReportTimezone });
    
    log.info('ReportGenerator started', { 
      cron: cronExpr, 
      timezone: config.dailyReportTimezone,
    });
  }
  
  stop(): void {
    if (this.cronJob) this.cronJob.stop();
  }
  
  /**
   * 生成日报(默认昨天,可指定日期)
   * @param dateStr YYYY-MM-DD,不传则为昨天
   */
  async generateDailyReport(dateStr?: string): Promise<DailyReport> {
    const targetDate = dateStr ? new Date(dateStr) : this.getYesterday();
    const dateKey = this.formatDate(targetDate);
    
    log.info('Generating daily report', { date: dateKey });
    
    // 时间范围: 当日 0:00 - 24:00 (按配置时区)
    const startTs = this.getDayStart(targetDate);
    const endTs = startTs + 24 * 3600 * 1000;
    
    const trades = db.getTradesInRange(startTs, endTs);
    const sellTrades = trades.filter(t => t.type === 'sell' && t.status === 'success');
    
    // 盈亏统计
    const winningTrades = sellTrades.filter(t => (t.pnlSol ?? 0) > 0);
    const losingTrades = sellTrades.filter(t => (t.pnlSol ?? 0) < 0);
    const totalPnlSol = sellTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    
    // 最佳/最差交易
    const sortedByPnl = [...sellTrades].sort((a, b) => (b.pnlSol ?? 0) - (a.pnlSol ?? 0));
    const bestTrade = sortedByPnl[0];
    const worstTrade = sortedByPnl[sortedByPnl.length - 1];
    
    // 平均持仓时间
    let totalHoldingMs = 0;
    let countWithHolding = 0;
    for (const sellTrade of sellTrades) {
      const positionTrades = db.getTradesByPosition(sellTrade.positionId);
      const buyTrade = positionTrades.find(t => t.type === 'buy');
      if (buyTrade) {
        totalHoldingMs += sellTrade.timestamp - buyTrade.timestamp;
        countWithHolding++;
      }
    }
    const avgHoldingTimeMin = countWithHolding > 0 
      ? (totalHoldingMs / countWithHolding) / (60 * 1000) 
      : 0;
    
    // 监控池信息
    const allMonitored = tokenMonitor.getAllTokens();
    const positions = db.getOpenPositions();
    
    const report: DailyReport = {
      date: dateKey,
      generatedAt: Date.now(),
      summary: {
        totalTrades: sellTrades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: sellTrades.length > 0 ? winningTrades.length / sellTrades.length : 0,
        totalPnlSol,
        totalPnlUsd: 0,  // SOL本位策略,此字段保留但不计算
        bestTrade: bestTrade ? {
          symbol: bestTrade.symbol,
          pnlSol: bestTrade.pnlSol ?? 0,
          pnlPercent: bestTrade.pnlPercent ?? 0,
        } : null,
        worstTrade: worstTrade && worstTrade !== bestTrade ? {
          symbol: worstTrade.symbol,
          pnlSol: worstTrade.pnlSol ?? 0,
          pnlPercent: worstTrade.pnlPercent ?? 0,
        } : null,
        avgHoldingTimeMin,
      },
      monitoringSummary: {
        totalMonitored: allMonitored.length,
        addedToday: 0,
        removedToday: 0,
        currentlyHeld: positions.length,
      },
      trades,
      positions: positions,
      newTokens: [],
      removedTokens: [],
    };
    
    // 保存到 DB
    db.saveDailyReport(dateKey, report);
    
    // 生成文件版本
    const jsonPath = path.join(REPORTS_DIR, `report-${dateKey}.json`);
    const mdPath = path.join(REPORTS_DIR, `report-${dateKey}.md`);
    
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, this.renderMarkdown(report));
    
    log.info('Daily report generated', {
      date: dateKey,
      trades: sellTrades.length,
      pnlSol: totalPnlSol.toFixed(4),
      jsonPath,
      mdPath,
    });
    
    return report;
  }
  
  /**
   * 渲染 Markdown 报告
   */
  private renderMarkdown(report: DailyReport): string {
    const { summary, monitoringSummary } = report;
    const winRatePercent = (summary.winRate * 100).toFixed(1);
    const pnlEmoji = summary.totalPnlSol >= 0 ? '🟢' : '🔴';
    const pnlSign = summary.totalPnlSol >= 0 ? '+' : '';
    
    let md = `# 📊 Daily Trading Report - ${report.date}\n\n`;
    md += `**Generated at:** ${new Date(report.generatedAt).toLocaleString()}\n\n`;
    md += `---\n\n`;
    
    md += `## ${pnlEmoji} Summary\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Total Trades | ${summary.totalTrades} |\n`;
    md += `| Winning | ${summary.winningTrades} |\n`;
    md += `| Losing | ${summary.losingTrades} |\n`;
    md += `| **Win Rate** | **${winRatePercent}%** |\n`;
    md += `| **Total PnL (SOL)** | **${pnlSign}${summary.totalPnlSol.toFixed(4)}** |\n`;
    md += `| Avg Holding Time | ${summary.avgHoldingTimeMin.toFixed(1)} min |\n\n`;
    
    if (summary.bestTrade) {
      md += `### 🏆 Best Trade\n`;
      md += `- **${summary.bestTrade.symbol}**: +${summary.bestTrade.pnlSol.toFixed(4)} SOL (${summary.bestTrade.pnlPercent.toFixed(2)}%)\n\n`;
    }
    if (summary.worstTrade) {
      md += `### 📉 Worst Trade\n`;
      md += `- **${summary.worstTrade.symbol}**: ${summary.worstTrade.pnlSol.toFixed(4)} SOL (${summary.worstTrade.pnlPercent.toFixed(2)}%)\n\n`;
    }
    
    md += `## 📊 Monitoring Pool\n\n`;
    md += `- Total Monitored: ${monitoringSummary.totalMonitored}\n`;
    md += `- Currently Held: ${monitoringSummary.currentlyHeld}\n\n`;
    
    md += `## 📝 Trade Details\n\n`;
    if (report.trades.length === 0) {
      md += `_No trades today._\n\n`;
    } else {
      md += `| Time | Symbol | Type | Amount(SOL) | PnL(SOL) | Reason |\n`;
      md += `|------|--------|------|-------------|----------|--------|\n`;
      for (const t of report.trades) {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const pnl = t.pnlSol !== undefined ? t.pnlSol.toFixed(4) : '-';
        md += `| ${time} | ${t.symbol} | ${t.type} | ${t.solAmount.toFixed(4)} | ${pnl} | ${t.reason || ''} |\n`;
      }
      md += `\n`;
    }
    
    md += `## 💼 Open Positions\n\n`;
    if (report.positions.length === 0) {
      md += `_No open positions._\n\n`;
    } else {
      md += `| Symbol | Entry Price | Cost(SOL) | Realized PnL |\n`;
      md += `|--------|-------------|-----------|---------------|\n`;
      for (const p of report.positions) {
        md += `| ${p.symbol} | $${p.entryPrice.toFixed(8)} | ${p.entryCostSol.toFixed(4)} | ${p.realizedPnlSol.toFixed(4)} |\n`;
      }
      md += `\n`;
    }
    
    md += `---\n_Auto-generated by SOL Trading Bot_\n`;
    return md;
  }
  
  // ========== 时间工具 ==========
  
  private getYesterday(): Date {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }
  
  private formatDate(d: Date): string {
    return d.toISOString().split('T')[0];
  }
  
  private getDayStart(d: Date): number {
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
}

export const reportGenerator = new ReportGenerator();
