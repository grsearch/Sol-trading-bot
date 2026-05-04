/**
 * Jupiter API 服务
 * 用于:报价 + 构建Swap交易
 * 
 * 文档: https://station.jup.ag/docs/apis/swap-api
 */
import axios, { AxiosInstance } from 'axios';
import { Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { heliusService } from './helius';

const log = getLogger('Jupiter');

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

class JupiterService {
  private client: AxiosInstance;
  private wallet: Keypair | null = null;
  
  constructor() {
    // Jupiter Lite/Free API: https://lite-api.jup.ag (无需 key)
    // Jupiter Pro API: https://api.jup.ag (需要 key)
    const baseURL = config.jupiterApiKey 
      ? 'https://api.jup.ag'
      : 'https://lite-api.jup.ag';
    
    this.client = axios.create({
      baseURL,
      timeout: 15000,
      headers: config.jupiterApiKey 
        ? { 'x-api-key': config.jupiterApiKey } 
        : {},
    });
    
    if (config.walletPrivateKey && !config.dryRun) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
        log.info('Wallet loaded', { publicKey: this.wallet.publicKey.toBase58() });
      } catch (err: any) {
        log.error('Failed to load wallet', { error: err.message });
      }
    } else if (config.dryRun) {
      log.info('Running in DRY_RUN mode - no real trades will be executed');
    }
  }
  
  getWalletPublicKey(): string | null {
    return this.wallet?.publicKey.toBase58() ?? null;
  }
  
  /**
   * 获取报价
   * @param inputMint 输入代币
   * @param outputMint 输出代币
   * @param amount 输入数量(最小单位,如 lamports)
   * @param slippageBps 滑点基点(100 = 1%)
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number = config.defaultSlippageBps
  ): Promise<QuoteResponse | null> {
    try {
      const res = await this.client.get('/swap/v1/quote', {
        params: {
          inputMint,
          outputMint,
          amount,
          slippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false,
        },
      });
      return res.data;
    } catch (err: any) {
      log.error('getQuote failed', { 
        inputMint, outputMint, amount,
        error: err.message,
        response: err.response?.data,
      });
      return null;
    }
  }
  
  /**
   * 买入: 用 SOL 换 token
   */
  async getBuyQuote(tokenMint: string, solAmount: number, slippageBps?: number): Promise<QuoteResponse | null> {
    const lamports = Math.floor(solAmount * 1e9).toString();
    return this.getQuote(SOL_MINT, tokenMint, lamports, slippageBps);
  }
  
  /**
   * 卖出: 用 token 换 SOL
   */
  async getSellQuote(tokenMint: string, tokenAmount: string, slippageBps?: number): Promise<QuoteResponse | null> {
    return this.getQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  }
  
  /**
   * 构建并执行 Swap
   */
  async executeSwap(quote: QuoteResponse): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }> {
    if (config.dryRun) {
      const fakeSig = 'DRY_RUN_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      log.info('[DRY_RUN] Swap simulated', {
        signature: fakeSig,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
      });
      return { success: true, signature: fakeSig };
    }
    
    if (!this.wallet) {
      return { success: false, error: 'Wallet not loaded' };
    }
    
    try {
      // 1. 获取 swap 交易
      const swapRes = await this.client.post<SwapResponse>('/swap/v1/swap', {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: config.priorityFeeMicroLamports * 100,  // 微lamports转lamports安全上限
            priorityLevel: 'high',
          },
        },
        dynamicComputeUnitLimit: true,
      });
      
      if (!swapRes.data?.swapTransaction) {
        return { success: false, error: 'No swap transaction returned' };
      }
      
      // 2. 反序列化、签名
      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet]);
      
      // 3. 发送
      const signature = await heliusService.sendTransaction(Buffer.from(tx.serialize()));
      
      // 4. 确认
      const confirmed = await heliusService.confirmTransaction(signature, 60000);
      
      if (!confirmed) {
        return { success: false, signature, error: 'Transaction not confirmed' };
      }
      
      log.info('Swap executed successfully', { signature });
      return { success: true, signature };
      
    } catch (err: any) {
      log.error('executeSwap failed', { 
        error: err.message,
        response: err.response?.data,
      });
      return { 
        success: false, 
        error: err.message,
      };
    }
  }
  
  /**
   * 一站式买入
   */
  async buy(tokenMint: string, solAmount: number, slippageBps?: number): Promise<{
    success: boolean;
    signature?: string;
    quote?: QuoteResponse;
    error?: string;
  }> {
    const quote = await this.getBuyQuote(tokenMint, solAmount, slippageBps);
    if (!quote) return { success: false, error: 'Failed to get quote' };
    
    const result = await this.executeSwap(quote);
    return { ...result, quote };
  }
  
  /**
   * 一站式卖出
   */
  async sell(tokenMint: string, tokenAmount: string, slippageBps?: number): Promise<{
    success: boolean;
    signature?: string;
    quote?: QuoteResponse;
    error?: string;
  }> {
    const quote = await this.getSellQuote(tokenMint, tokenAmount, slippageBps);
    if (!quote) return { success: false, error: 'Failed to get quote' };
    
    const result = await this.executeSwap(quote);
    return { ...result, quote };
  }
}

export const jupiterService = new JupiterService();
