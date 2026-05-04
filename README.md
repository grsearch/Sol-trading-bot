# SOL Trading Bot

Solana 链上自动交易机器人 - 量能驱动的短线策略，针对上线 1-30 天的代币（pump.fun migrated, Raydium, Meteora 池子）。

## 🎯 核心特性

- **发现层解耦**: Webhook + Dashboard 手动添加，不做自动选币
- **实时监控**: Helius WebSocket 订阅 100 个代币池子的 Swap 事件
- **量能驱动**: 基于净买入、独立买家、新钱包占比、买卖笔数比的多因子评分
- **风控前置**: 入池前过滤 + FDV/LP 分层退出（warning + force exit）
- **持仓保护**: 持仓中的代币不会因容量被淘汰，但仍受强制退出保护
- **完整记录**: 每笔交易、每个信号、每个生命周期事件都进数据库
- **每日 8AM 自动报告**: Markdown + JSON 双格式

## 📐 架构

```
┌─────────────┐  ┌─────────────┐
│  Webhook    │  │  Dashboard  │  ← 发现层
│  Receiver   │  │  Manual Add │
└──────┬──────┘  └──────┬──────┘
       └────────┬───────┘
                ▼
       ┌─────────────────┐
       │  Token Monitor  │  ← 100币容量、保护期、淘汰、退出阈值
       │   (容量管理)    │
       └────────┬────────┘
                │
       ┌────────▼────────┐  ┌──────────────┐
       │  Helius WS      │─→│ Volume       │  ← 1m/5m/1h 滚动桶
       │  Pool Subscribe │  │ Aggregator   │
       └─────────────────┘  └──────┬───────┘
                                   │
                            ┌──────▼───────┐
                            │ Signal       │  ← 多维评分,score≥65触发
                            │ Engine       │
                            └──────┬───────┘
                                   │
                            ┌──────▼───────┐  ┌──────────┐
                            │ Trading      │─→│ Jupiter  │
                            │ Engine       │  │ Swap     │
                            └──────────────┘  └──────────┘
```

## 🚀 快速开始

### 1. 安装依赖

需要 Node.js 20+。

```bash
cd sol-trading-bot
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env, 填入:
# - BIRDEYE_API_KEY (Premium Plus)
# - HELIUS_API_KEY (Business)
# - HELIUS_RPC_URL / HELIUS_WSS_URL
# - JUPITER_API_KEY (Developer 可选)
# - WALLET_PRIVATE_KEY (Base58, 仅 DRY_RUN=false 时需要)
# - WEBHOOK_API_KEY (自定义,保护 webhook)
```

⚠️ **首次运行务必保持 `DRY_RUN=true`**，确认信号和淘汰逻辑符合预期再切换。

### 3. 启动

```bash
# 开发模式(自动重载)
npm run dev

# 生产构建
npm run build
npm start
```

启动成功后:
- Dashboard: http://localhost:3001
- Webhook 端点: http://localhost:3001/webhook/add-token

## 📨 Webhook 使用

```bash
curl -X POST http://your-server-ip:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_WEBHOOK_API_KEY" \
  -d '{
    "network": "solana",
    "address": "BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump",
    "symbol": "Nana",
    "source": "kol_alice"
  }' | jq .
```

返回示例:
```json
{
  "success": true,
  "token": {
    "address": "BWJ7zJauz...",
    "symbol": "Nana",
    "status": "protected",
    "addedAt": 1730000000000
  }
}
```

如果代币不通过入池过滤(LP/Volume/Holders 不足), 返回:
```json
{
  "success": false,
  "reason": "LP too low: $5234"
}
```

## 📊 Dashboard 功能

- **24h 盈亏统计**: 总 PnL（SOL/USD）、胜率、交易笔数
- **监控代币列表**: 状态、评分、FDV、LP、Volume、Holders、年龄、来源、是否持仓
- **持仓**: 入场价、当前价、未实现盈亏、持仓时长
- **交易记录**: 时间、品种、买卖、金额、PnL、原因
- **日报**: 历史日报列表 + 详情查看 + 立即生成今日

每 10 秒自动刷新；可点击"Pause Refresh"暂停。

## 📅 每日报告

每天 **08:00 (Asia/Shanghai)** 自动生成前一日的报告:
- 保存到 `data/reports/report-YYYY-MM-DD.json`
- 同时生成 Markdown 版本 `report-YYYY-MM-DD.md`
- 也存入数据库,可通过 Dashboard 查看

可以通过 Dashboard 的"Generate Today's Report Now"按钮立即生成今日报告。

## ⚙️ 关键配置参数 (激进档默认)

### 仓位 (SOL本位)
| 参数 | 默认 | 说明 |
|------|------|------|
| `MAX_MONITORED_TOKENS` | 100 | 监控池上限 |
| `MAX_POSITION_SOL` | 1.5 | 单币最大仓位 |
| `MAX_TOTAL_POSITION_SOL` | 20 | 总仓位上限 |
| `MAX_CONCURRENT_POSITIONS` | 10 | 同时持仓数 |
| `DEFAULT_BUY_AMOUNT_SOL` | 0.5 | 默认买入金额 |
| `PROTECTION_PERIOD_MINUTES` | 60 | 新币保护期(免淘汰、免触发) |
| `COOLDOWN_PERIOD_HOURS` | 24 | 淘汰后冷却期 |

### 退出阈值 (代币体量,USD标准)
| 参数 | 默认 | 说明 |
|------|------|------|
| `WARNING_FDV_USD` | 80000 | FDV 预警线 |
| `WARNING_LP_USD` | 25000 | LP 预警线 |
| `FORCE_EXIT_FDV_USD` | 30000 | FDV 强制退出 |
| `FORCE_EXIT_LP_USD` | 10000 | LP 强制退出 |

### 止盈止损
| 参数 | 默认 | 说明 |
|------|------|------|
| `STOP_LOSS_PERCENT` | 25 | 止损 |
| `TP1_PERCENT / TP1_SELL_RATIO` | 100 / 50 | 第一止盈点 (2x, 卖50%) |
| `TP2_PERCENT / TP2_SELL_RATIO` | 200 / 100 | 第二止盈点 (3x, 100%清仓) |
| `TIME_STOP_LOSS_HOURS` | 10 | 时间止损(无盈利退出) |
| `VOLUME_REVERSAL_PROFIT_THRESHOLD` | 25 | 量能反转触发的最小盈利 |

### 信号
| 参数 | 默认 | 说明 |
|------|------|------|
| `MIN_BUY_SIGNAL_SCORE` | 65 | 买入触发最低分数 |
| `VOLUME_BURST_MULTIPLIER` | 5 | 量能爆发判定倍数 |
| `BUY_SELL_RATIO_THRESHOLD` | 2.5 | 买卖笔数比阈值 |
| `NEW_WALLET_RATIO_THRESHOLD` | 0.5 | 新钱包占比阈值 |
| `LARGE_SWAP_MULTIPLIER` | 5 | 大单=平均单笔的N倍 |
| `LARGE_SWAP_MIN_SOL` | 3 | 大单兜底最小值 |

## 🗂️ 项目结构

```
sol-trading-bot/
├── src/
│   ├── core/                    # 核心引擎
│   │   ├── token-monitor.ts     # 监控池管理(容量、淘汰、退出)
│   │   ├── volume-aggregator.ts # 多周期量能桶
│   │   ├── signal-engine.ts     # 买卖信号检测
│   │   └── trading-engine.ts    # 仓位管理与执行
│   ├── services/                # 外部服务封装
│   │   ├── birdeye.ts           # 代币数据
│   │   ├── helius.ts            # WS订阅 + RPC
│   │   ├── jupiter.ts           # 报价 + Swap
│   │   └── report-generator.ts  # 日报
│   ├── db/                      # SQLite 持久化
│   ├── dashboard/               # Web UI
│   │   ├── server.ts            # Express
│   │   └── public/index.html    # 前端
│   ├── types/                   # TS 类型
│   ├── utils/                   # 配置 + 日志
│   └── index.ts                 # 主入口
├── data/                        # 数据库 + 报告
├── logs/                        # 日志文件
└── .env                         # 配置(不提交)
```

## 🛡️ 安全清单

跑实盘前请确认:

- [ ] `DRY_RUN=false` 已经过至少 24h 模拟验证
- [ ] 钱包私钥使用环境变量,不要硬编码
- [ ] `WEBHOOK_API_KEY` 设置为强随机字符串
- [ ] Webhook 接口建议放在内网或加 IP 白名单
- [ ] 设置合理的 `MAX_TOTAL_POSITION_SOL`(总持仓上限)
- [ ] 钱包余额不要超过策略所需,作为风险隔离
- [ ] 监控日志,设置告警(尤其是 force_exit 频繁触发时)

## 📈 信号评分逻辑

**买入信号** (默认 score ≥ 75 触发):
```
score = volumeBurst × 0.30        # 量能爆发(健康区间加分,过热反扣分)
      + walletStructure × 0.35    # 买家暴增 + 新钱包占比 + 健康买单大小
      + priceStructure × 0.25     # 大单分布 + 启动信号 + 投降反弹 ⭐
      + safety × 0.10             # 持币地址趋势
```

**核心创新 - 三种买入模式识别 (适配Memecoin快速节奏):**

1. **常规启动信号** - 量能/钱包结构突然爆发的健康区间(5-15x burst)
2. **二次启动 (Re-launch)** - 40分钟内"启动→冷却→再启动"模式
3. **投降式反弹 (Capitulation Bounce)** ⭐⭐ - 17分钟内"砸盘→衰竭→反转"V型反转
   - 砸盘期(5-15min前): 强抛压 卖>买×2
   - 衰竭期(2-5min前): 卖压萎缩 <砸盘×60%
   - 反转期(2min内): 净买入转正 + 买盘强势
   - 价格判定: 30分钟内跌幅≥15% + 当前回升≥2%
   - 命中 → +30~60分(按质量分级)

**过热反向保护:** 极致信号反而扣分(防止FOMO顶部接盘)
- Volume burst 30x+ → -25 分
- Buy/Sell ratio 10:1+ → -15 分
- New wallet 95%+ → -20 分(纯接盘)

**卖出信号** (优先级从高到低):
1. `force_exit_fdv` / `force_exit_lp` - FDV<$30K 或 LP<$10K, 100%清仓
2. `stop_loss` - 跌幅 ≥ 25%, 100%清仓
3. `take_profit_2` - 涨至 +120% (2.2x), **100%清仓**
4. `take_profit_1` - 涨至 +50% (1.5x), 卖70%
5. `large_sell` - 1分钟内大单卖出冲击 ≥ 5% LP
6. `volume_reversal` - 已盈利 ≥15% 且连续2分钟净流出
7. `time_stop` - 持仓 10h 仍未盈利

## 💱 计价模式: SOL本位

本机器人采用 **SOL本位** 计价:
- **仓位/盈亏统计** → SOL单位
- **代币体量指标** (FDV/LP/Volume) → USD单位 (行业标准,与Birdeye一致)
- **大单判定** → 相对该币近期交易统计 (无需SOL价格转换,自适应)

为什么这样混合:
- 你的钱包是SOL本位,关心的是赚多少SOL,不被SOL兑美元波动干扰
- 代币的FDV/LP是项目体量,必须用USD才能跨币种比较
- 大单用相对统计,避免SOL价格波动导致策略漂移

## 🐛 故障排查

**Helius WS 连接失败**: 检查 `HELIUS_WSS_URL` 是否含 `?api-key=` 参数

**Webhook 401**: 检查 `x-api-key` header 是否匹配 `.env` 中的 `WEBHOOK_API_KEY`

**Dashboard 数据为空**: 启动后需要等代币的Swap数据累积(至少几分钟才能形成1h基线)

**信号不触发**: 检查代币状态是否还在 `protected`,以及活跃度是否足够(5分钟内至少5笔交易)

## 📜 License

私有项目，仅供个人使用。

---

**⚠️ 风险提示**: 此机器人涉及加密货币交易,可能产生重大损失。请只用你能承受损失的资金,并先在 DRY_RUN 模式下充分测试。
