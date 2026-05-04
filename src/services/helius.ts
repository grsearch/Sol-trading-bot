/**
 * Helius RPC + WebSocket 服务
 * 
 * 核心用途:
 * 1. 通过 WebSocket 实时订阅池子的 Swap 事件
 * 2. 通过 RPC 发送交易(Staked Connections)
 * 3. 解析交易获取链上原始数据
 * 
 * 文档: https://docs.helius.dev/
 */
import WebSocket from 'ws';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { SwapEvent } from '../types';
import { EventEmitter } from 'events';

const log = getLogger('Helius');

// Solana 系统常量
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const METEORA_DAMM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPFUN_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

class HeliusService extends EventEmitter {
  private connection: Connection;
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, number>();  // poolAddress -> subId
  private subIdToPool = new Map<number, string>();    // subId -> poolAddress  
  private poolToToken = new Map<string, string>();    // poolAddress -> tokenAddress
  private tokenInfo = new Map<string, { decimals: number; symbol: string }>();
  private knownWallets = new Map<string, Set<string>>(); // tokenAddr -> walletAddrs
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private wsRequestId = 1;
  
  constructor() {
    super();
    this.connection = new Connection(config.heliusRpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.heliusWssUrl,
    });
  }
  
  // ========== WebSocket 连接管理 ==========
  
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    
    return new Promise((resolve, reject) => {
      log.info('Connecting to Helius WebSocket', { url: config.heliusWssUrl });
      
      this.ws = new WebSocket(config.heliusWssUrl);
      
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);
      
      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        log.info('Helius WebSocket connected');
        this.emit('connected');
        resolve();
      });
      
      this.ws.on('message', (data) => {
        try {
          this.handleWsMessage(data.toString());
        } catch (err: any) {
          log.error('Error handling WS message', { error: err.message });
        }
      });
      
      this.ws.on('error', (err) => {
        log.error('WebSocket error', { error: err.message });
      });
      
      this.ws.on('close', (code, reason) => {
        log.warn('WebSocket closed', { code, reason: reason.toString() });
        this.emit('disconnected');
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }
  
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    log.info('Scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay });
    
    setTimeout(async () => {
      try {
        await this.connect();
        // 重连后重新订阅所有池子
        const pools = Array.from(this.subscriptions.keys());
        this.subscriptions.clear();
        this.subIdToPool.clear();
        for (const pool of pools) {
          const tokenAddr = this.poolToToken.get(pool);
          if (tokenAddr) {
            await this.subscribePool(pool, tokenAddr);
          }
        }
      } catch (err: any) {
        log.error('Reconnect failed', { error: err.message });
        this.scheduleReconnect();
      }
    }, delay);
  }
  
  private handleWsMessage(message: string): void {
    const msg = JSON.parse(message);
    
    // 订阅确认
    if (msg.id && msg.result !== undefined && typeof msg.result === 'number') {
      const requestId = msg.id;
      this.emit(`sub_response_${requestId}`, msg.result);
      return;
    }
    
    // 通知消息(订阅推送)
    if (msg.method === 'logsNotification' || msg.method === 'accountNotification') {
      const subId = msg.params?.subscription;
      const poolAddress = this.subIdToPool.get(subId);
      if (!poolAddress) return;
      
      const tokenAddress = this.poolToToken.get(poolAddress);
      if (!tokenAddress) return;
      
      this.handleSwapNotification(msg.params.result, poolAddress, tokenAddress);
    }
  }
  
  /**
   * 订阅池子的日志事件,从中识别 Swap
   */
  async subscribePool(poolAddress: string, tokenAddress: string): Promise<void> {
    if (this.subscriptions.has(poolAddress)) return;
    
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    
    const requestId = this.wsRequestId++;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'logsSubscribe',
      params: [
        { mentions: [poolAddress] },
        { commitment: 'confirmed' },
      ],
    };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Subscribe timeout for ${poolAddress}`));
      }, 10000);
      
      this.once(`sub_response_${requestId}`, (subId: number) => {
        clearTimeout(timeout);
        this.subscriptions.set(poolAddress, subId);
        this.subIdToPool.set(subId, poolAddress);
        this.poolToToken.set(poolAddress, tokenAddress);
        log.debug('Pool subscribed', { poolAddress, tokenAddress, subId });
        resolve();
      });
      
      this.ws!.send(JSON.stringify(request));
    });
  }
  
  async unsubscribePool(poolAddress: string): Promise<void> {
    const subId = this.subscriptions.get(poolAddress);
    if (!subId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    const request = {
      jsonrpc: '2.0',
      id: this.wsRequestId++,
      method: 'logsUnsubscribe',
      params: [subId],
    };
    
    this.ws.send(JSON.stringify(request));
    this.subscriptions.delete(poolAddress);
    this.subIdToPool.delete(subId);
    this.poolToToken.delete(poolAddress);
    log.debug('Pool unsubscribed', { poolAddress });
  }
  
  /**
   * 处理 Swap 通知
   * 注意:从 logs 只能拿到 signature, 需要 fetch 完整交易再解析
   */
  private async handleSwapNotification(
    result: any,
    poolAddress: string,
    tokenAddress: string
  ): Promise<void> {
    const signature = result?.value?.signature;
    if (!signature) return;
    
    // 简单过滤: 必须有 swap 相关的日志
    const logs: string[] = result.value.logs || [];
    const hasSwap = logs.some(l => 
      l.includes('Swap') || l.includes('swap') || 
      l.includes('Trade') || l.includes('Buy') || l.includes('Sell')
    );
    if (!hasSwap) return;
    
    // 异步解析交易
    setImmediate(() => this.parseAndEmitSwap(signature, poolAddress, tokenAddress));
  }
  
  private async parseAndEmitSwap(
    signature: string,
    poolAddress: string,
    tokenAddress: string
  ): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      
      if (!tx || !tx.meta || tx.meta.err) return;
      
      const swapEvent = this.parseSwapFromTx(tx, poolAddress, tokenAddress, signature);
      if (swapEvent) {
        // 标记是否新钱包
        let wallets = this.knownWallets.get(tokenAddress);
        if (!wallets) {
          wallets = new Set();
          this.knownWallets.set(tokenAddress, wallets);
        }
        swapEvent.isNewWallet = !wallets.has(swapEvent.walletAddress);
        wallets.add(swapEvent.walletAddress);
        
        this.emit('swap', swapEvent);
      }
    } catch (err: any) {
      log.debug('Failed to parse swap tx', { signature, error: err.message });
    }
  }
  
  /**
   * 从交易中解析 Swap 事件
   * 通过 token balance changes 计算实际买卖
   */
  private parseSwapFromTx(
    tx: ParsedTransactionWithMeta,
    poolAddress: string,
    tokenAddress: string,
    signature: string
  ): SwapEvent | null {
    if (!tx.meta) return null;
    
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    // 找到交易发起者(签名者通常是 fee payer 也是 trader)
    const accountKeys = tx.transaction.message.accountKeys;
    if (!accountKeys.length) return null;
    
    const trader = accountKeys[0].pubkey.toBase58();
    
    // 计算 trader 的 token 和 SOL 变化
    let tokenChange = 0;
    let solChange = 0;
    let tokenDecimals = 9;
    
    // SOL 变化
    const preSol = tx.meta.preBalances[0] ?? 0;
    const postSol = tx.meta.postBalances[0] ?? 0;
    solChange = (postSol - preSol) / 1e9;
    
    // token 变化(找 trader 的 ATA)
    for (const post of postTokenBalances) {
      if (post.mint !== tokenAddress) continue;
      if (post.owner !== trader) continue;
      
      const pre = preTokenBalances.find(p => 
        p.accountIndex === post.accountIndex && p.mint === tokenAddress
      );
      
      const preAmount = pre?.uiTokenAmount.uiAmount ?? 0;
      const postAmount = post.uiTokenAmount.uiAmount ?? 0;
      tokenChange = postAmount - preAmount;
      tokenDecimals = post.uiTokenAmount.decimals;
      break;
    }
    
    // 如果 trader 没有这个 token 的 ATA, 检查所有变化的 ATA
    if (tokenChange === 0) {
      for (const post of postTokenBalances) {
        if (post.mint !== tokenAddress) continue;
        const pre = preTokenBalances.find(p => 
          p.accountIndex === post.accountIndex && p.mint === tokenAddress
        );
        const preAmount = pre?.uiTokenAmount.uiAmount ?? 0;
        const postAmount = post.uiTokenAmount.uiAmount ?? 0;
        const diff = postAmount - preAmount;
        // 池子余额减少表示 trader 买入,反之卖出
        // 简化处理:取最大变化绝对值
        if (Math.abs(diff) > Math.abs(tokenChange)) {
          tokenChange = -diff;  // 取反,因为是池子的视角
          tokenDecimals = post.uiTokenAmount.decimals;
        }
      }
    }
    
    if (tokenChange === 0) return null;
    
    const fee = (tx.meta.fee || 0) / 1e9;
    const solAmountAbs = Math.abs(solChange) - fee;
    
    if (solAmountAbs <= 0.0001) return null;  // 过滤极小交易和非swap
    
    return {
      signature,
      timestamp: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      poolAddress,
      tokenAddress,
      walletAddress: trader,
      type: tokenChange > 0 ? 'buy' : 'sell',
      tokenAmount: Math.abs(tokenChange),
      solAmount: solAmountAbs,
    };
  }
  
  // ========== Token Metadata (链上元数据) ==========
  
  /**
   * 从链上获取代币元数据(symbol, name, decimals)
   * 这是最权威的来源,但比第三方API慢一些
   * 
   * 通过两步:
   * 1. 先getMint拿到decimals
   * 2. 再用Metaplex PDA拿到symbol/name
   */
  async getTokenMetadataOnChain(tokenAddress: string): Promise<{
    symbol: string;
    name: string;
    decimals: number;
  } | null> {
    try {
      const mint = new PublicKey(tokenAddress);
      
      // 1. 获取mint info(拿decimals)
      const mintInfo = await this.connection.getParsedAccountInfo(mint);
      const mintParsed = (mintInfo.value?.data as any)?.parsed?.info;
      const decimals = mintParsed?.decimals ?? 9;
      
      // 2. 计算 Metaplex Metadata PDA
      // PDA derivation: ['metadata', metadataProgramId, mintAddress]
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        METADATA_PROGRAM_ID,
      );
      
      // 3. 获取metadata account
      const accountInfo = await this.connection.getAccountInfo(metadataPDA);
      if (!accountInfo?.data) {
        return { symbol: '', name: '', decimals };
      }
      
      // 4. 解析 Metaplex Metadata struct
      // 格式: 1 byte key + 32 bytes update_authority + 32 bytes mint + 
      //       4 bytes name length + name + 4 bytes symbol length + symbol + ...
      const data = accountInfo.data;
      let offset = 1 + 32 + 32;  // 跳过key + update_authority + mint
      
      // 读取name
      const nameLen = data.readUInt32LE(offset);
      offset += 4;
      const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0+$/, '').trim();
      offset += nameLen;
      
      // 读取symbol
      const symbolLen = data.readUInt32LE(offset);
      offset += 4;
      const symbol = data.slice(offset, offset + symbolLen).toString('utf8').replace(/\0+$/, '').trim();
      
      return { symbol, name, decimals };
    } catch (err: any) {
      log.debug('getTokenMetadataOnChain failed', { 
        tokenAddress, error: err.message,
      });
      return null;
    }
  }
  
  // ========== 工具方法 ==========
  
  getConnection(): Connection {
    return this.connection;
  }
  
  async getSolBalance(walletAddress: string): Promise<number> {
    const balance = await this.connection.getBalance(new PublicKey(walletAddress));
    return balance / 1e9;
  }
  
  async getTokenBalance(walletAddress: string, tokenMint: string): Promise<{ amount: number; decimals: number } | null> {
    try {
      const owner = new PublicKey(walletAddress);
      const mint = new PublicKey(tokenMint);
      
      const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { mint });
      if (accounts.value.length === 0) return null;
      
      const acc = accounts.value[0];
      const info = acc.account.data.parsed.info;
      return {
        amount: info.tokenAmount.uiAmount,
        decimals: info.tokenAmount.decimals,
      };
    } catch (err: any) {
      log.debug('getTokenBalance failed', { walletAddress, tokenMint, error: err.message });
      return null;
    }
  }
  
  async sendTransaction(serializedTx: Buffer): Promise<string> {
    const signature = await this.connection.sendRawTransaction(serializedTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    log.info('Transaction sent', { signature });
    return signature;
  }
  
  async confirmTransaction(signature: string, timeoutMs: number = 60000): Promise<boolean> {
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const status = await this.connection.getSignatureStatus(signature);
        if (status?.value?.confirmationStatus === 'confirmed' || 
            status?.value?.confirmationStatus === 'finalized') {
          if (status.value.err) {
            log.error('Transaction failed', { signature, err: status.value.err });
            return false;
          }
          return true;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    } catch (err: any) {
      log.error('confirmTransaction error', { signature, error: err.message });
      return false;
    }
  }
  
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  
  getStats() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscriptions: this.subscriptions.size,
      knownWalletsCount: Array.from(this.knownWallets.values()).reduce((sum, s) => sum + s.size, 0),
    };
  }
}

export const heliusService = new HeliusService();
