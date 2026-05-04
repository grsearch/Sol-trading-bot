/**
 * Birdeye API 服务
 * 用于:代币基础信息、安全数据、Holder分布、市场数据
 * 
 * 文档: https://docs.birdeye.so/
 * Premium Plus: 100M CU/月, WebSocket 500并发
 */
import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { getLogger } from '../utils/logger';
import { TokenMarketData, PoolInfo } from '../types';

const log = getLogger('Birdeye');

interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  price: number;
  liquidity: number;
  mc?: number;
  fdv?: number;
  v24hUSD?: number;
  v24hChangePercent?: number;
  priceChange1hPercent?: number;
  priceChange24hPercent?: number;
  holder?: number;
  numberMarkets?: number;
  extensions?: any;
}

interface BirdeyeTokenSecurity {
  ownerAddress?: string;
  creatorAddress?: string;
  totalSupply?: number;
  mutableMetadata?: boolean;
  ownerPercentage?: number;
  creatorPercentage?: number;
  top10HolderBalance?: number;
  top10HolderPercent?: number;
  top10UserBalance?: number;
  top10UserPercent?: number;
  isTrueToken?: boolean;
  fakeToken?: boolean;
  totalLPProviders?: number;
  lockInfo?: any;
  freezeable?: boolean;
  freezeAuthority?: string;
  transferFeeEnable?: boolean;
}

interface BirdeyeHolderData {
  amount: string;
  decimals: number;
  mint: string;
  owner: string;
  token_account: string;
  ui_amount: number;
}

interface BirdeyeTradeData {
  blockHumanTime: string;
  blockUnixTime: number;
  txHash: string;
  side: 'buy' | 'sell';
  alias?: string;
  isTradeOnBe?: boolean;
  source: string;
  from: { address: string; symbol: string; decimals: number; amount: number; uiAmount: number };
  to: { address: string; symbol: string; decimals: number; amount: number; uiAmount: number };
  tokenPrice?: number;
  nearestPrice?: number;
  tokenAmount?: number;
  volumeInUsd?: number;
}

class BirdeyeService {
  private client: AxiosInstance;
  private rateLimitRemaining: number = Infinity;
  private cuUsedToday: number = 0;
  
  constructor() {
    this.client = axios.create({
      baseURL: 'https://public-api.birdeye.so',
      timeout: 15000,
      headers: {
        'X-API-KEY': config.birdeyeApiKey,
        'x-chain': 'solana',
        'accept': 'application/json',
      },
    });
    
    // 响应拦截器跟踪CU使用
    this.client.interceptors.response.use(
      (response) => {
        const cuUsed = parseInt(response.headers['x-rate-limit-cu-used'] || '0');
        if (cuUsed) this.cuUsedToday += cuUsed;
        return response;
      },
      (error) => {
        if (error.response?.status === 429) {
          log.warn('Rate limit hit on Birdeye API');
        }
        return Promise.reject(error);
      }
    );
  }
  
  /**
   * 获取代币概览(基础市场数据)
   * CU消耗: 较低
   */
  async getTokenOverview(address: string): Promise<TokenMarketData | null> {
    try {
      const res = await this.client.get('/defi/token_overview', {
        params: { address },
      });
      
      if (!res.data?.success) return null;
      const d: BirdeyeTokenOverview = res.data.data;
      
      return {
        address: d.address,
        symbol: d.symbol,
        price: d.price,
        fdv: d.fdv ?? d.mc ?? 0,
        marketCap: d.mc,
        liquidity: d.liquidity ?? 0,
        volume24h: d.v24hUSD ?? 0,
        volumeChange24h: d.v24hChangePercent,
        priceChange1h: d.priceChange1hPercent,
        priceChange24h: d.priceChange24hPercent,
        holders: d.holder ?? 0,
        createdAt: 0,  // 需要其他接口获取
      };
    } catch (err: any) {
      log.error('getTokenOverview failed', { address, error: err.message });
      return null;
    }
  }
  
  /**
   * 获取代币安全信息(Top持仓、权限、LP锁定等)
   */
  async getTokenSecurity(address: string): Promise<BirdeyeTokenSecurity | null> {
    try {
      const res = await this.client.get('/defi/token_security', {
        params: { address },
      });
      if (!res.data?.success) return null;
      return res.data.data;
    } catch (err: any) {
      log.error('getTokenSecurity failed', { address, error: err.message });
      return null;
    }
  }
  
  /**
   * 获取Holder分布
   * @param limit 默认10, 最大100
   */
  async getTokenHolders(address: string, limit: number = 10): Promise<BirdeyeHolderData[]> {
    try {
      const res = await this.client.get('/defi/v3/token/holder', {
        params: { address, limit, offset: 0 },
      });
      if (!res.data?.success) return [];
      return res.data.data?.items ?? [];
    } catch (err: any) {
      log.error('getTokenHolders failed', { address, error: err.message });
      return [];
    }
  }
  
  /**
   * 获取代币创建时间(用于判断"上线1-30天"是否符合)
   */
  async getTokenCreationInfo(address: string): Promise<{ createdAt: number } | null> {
    try {
      const res = await this.client.get('/defi/token_creation_info', {
        params: { address },
      });
      if (!res.data?.success) return null;
      return {
        createdAt: res.data.data.blockUnixTime * 1000,
      };
    } catch (err: any) {
      log.debug('getTokenCreationInfo failed', { address, error: err.message });
      return null;
    }
  }
  
  /**
   * 获取近期交易(用于补充实时量能数据)
   * @param limit 最多50
   */
  async getRecentTrades(address: string, limit: number = 50): Promise<BirdeyeTradeData[]> {
    try {
      const res = await this.client.get('/defi/txs/token', {
        params: { address, offset: 0, limit, tx_type: 'swap', sort_type: 'desc' },
      });
      if (!res.data?.success) return [];
      return res.data.data?.items ?? [];
    } catch (err: any) {
      log.error('getRecentTrades failed', { address, error: err.message });
      return [];
    }
  }
  
  /**
   * 获取代币的池子信息
   */
  async getTokenPools(address: string): Promise<PoolInfo[]> {
    try {
      const res = await this.client.get('/defi/v2/markets', {
        params: { address, time_frame: '24h', sort_type: 'desc', sort_by: 'liquidity', limit: 10 },
      });
      if (!res.data?.success) return [];
      
      return (res.data.data?.items ?? []).map((m: any) => ({
        address: m.address,
        type: this.detectPoolType(m.source),
        baseToken: m.base?.address ?? address,
        quoteToken: m.quote?.address,
        baseReserve: m.base?.uiAmount,
        quoteReserve: m.quote?.uiAmount,
      }));
    } catch (err: any) {
      log.error('getTokenPools failed', { address, error: err.message });
      return [];
    }
  }
  
  private detectPoolType(source: string): PoolInfo['type'] {
    const s = source.toLowerCase();
    if (s.includes('raydium')) return 'raydium';
    if (s.includes('meteora')) return 'meteora';
    if (s.includes('pump')) return 'pumpfun';
    if (s.includes('orca')) return 'orca';
    return 'unknown';
  }
  
  /**
   * 一站式获取代币综合信息(用于入池验证)
   */
  async getTokenFullInfo(address: string): Promise<{
    market: TokenMarketData | null;
    security: BirdeyeTokenSecurity | null;
    pools: PoolInfo[];
    creationTime: number | null;
  }> {
    const [market, security, pools, creation] = await Promise.all([
      this.getTokenOverview(address),
      this.getTokenSecurity(address),
      this.getTokenPools(address),
      this.getTokenCreationInfo(address),
    ]);
    
    if (market && creation) {
      market.createdAt = creation.createdAt;
      const top10Pct = security?.top10HolderPercent;
      if (top10Pct !== undefined) {
        market.top10HoldersPercent = top10Pct * 100;
      }
      if (pools.length > 0) {
        market.pool = pools[0];
      }
    }
    
    return {
      market,
      security,
      pools,
      creationTime: creation?.createdAt ?? null,
    };
  }
  
  getCuUsageStats(): { used: number } {
    return { used: this.cuUsedToday };
  }
  
  resetCuCounter(): void {
    this.cuUsedToday = 0;
  }
}

export const birdeyeService = new BirdeyeService();
export type { BirdeyeTokenSecurity, BirdeyeTradeData };
