/**
 * Ostium Builder SDK wrapper (verified against @ostium/builder-sdk@0.4.0 — see docs/BUILDER_SDK.md).
 * Delegated + gasless: signs with a DELEGATE key, trades on behalf of traderAddress, no gas needed.
 * Writes return SubmissionResult { txHash, smartAccountAddress? }; opens are oracle-settled —
 * confirm via getOpenPositions / getFills using the returned txHash.
 */
import {
  OstiumClient,
  OrderType,
  CancelOrderType,
  OstiumError,
  type Order,
  type Pair,
  type Position,
  type SubmissionResult,
} from '@ostium/builder-sdk';

export interface ExecutorConfig {
  network: 'testnet' | 'mainnet';
  delegatePrivateKey: `0x${string}`;
  traderAddress: `0x${string}`;
  pimlicoUrl?: string;
  sponsorshipPolicyId?: string;
  rpcUrl?: string;
  slippageBps?: number;
}

export interface PositionView {
  state: 'long' | 'short' | 'flat';
  pairId: string | null;
  idx: number | null;
}

export interface OpenMarketArgs {
  pairId: string;
  isLong: boolean;
  collateral: number;
  leverage: number;
  price: number;
  takeProfit?: number;
  stopLoss?: number;
  slippageBps?: number;
  limitPrice?: number;
  orderType?: 'market' | 'limit';
}

export interface CloseArgs {
  pairId: string;
  idx: number;
  price: number;
  closePercent?: number;
  slippageBps?: number;
}

/** The executor surface the worker depends on — implemented by OstiumExecutor, faked in tests. */
export interface IExecutor {
  pairs(): Promise<Pair[]>;
  pairById(pairId: string): Promise<Pair | undefined>;
  positions(): Promise<Position[]>;
  usdcBalance(): Promise<number>;
  positionFor(positions: Position[], pairId: string): PositionView;
  openMarket(args: OpenMarketArgs): Promise<SubmissionResult>;
  close(args: CloseArgs): Promise<SubmissionResult>;
  ordersByTx(txHash: string): Promise<Order[]>;
  cancelPendingOpen(orderId: number): Promise<SubmissionResult>;
}

export class OstiumExecutor implements IExecutor {
  private constructor(
    private client: OstiumClient,
    readonly trader: `0x${string}`,
  ) {}

  static async create(cfg: ExecutorConfig): Promise<OstiumExecutor> {
    const client = await OstiumClient.createDelegatedAndGasless({
      delegatePrivateKey: cfg.delegatePrivateKey,
      traderAddress: cfg.traderAddress,
      testnet: cfg.network === 'testnet',
      ...(cfg.pimlicoUrl ? { pimlicoUrl: cfg.pimlicoUrl } : {}),
      ...(cfg.sponsorshipPolicyId ? { sponsorshipPolicyId: cfg.sponsorshipPolicyId } : {}),
      ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      ...(cfg.slippageBps ? { slippageBps: cfg.slippageBps } : {}),
    });
    return new OstiumExecutor(client, cfg.traderAddress);
  }

  // Serializes on-chain submissions: one delegate Safe, so ERC-4337 nonces must not race. Reads and
  // settlement polling stay concurrent — only the brief submit call is serialized.
  private writeChain: Promise<unknown> = Promise.resolve();
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // --- reads ---
  async pairs(): Promise<Pair[]> {
    return (await this.client.getPairs()).pairs;
  }

  async pairById(pairId: string): Promise<Pair | undefined> {
    return (await this.pairs()).find((p) => String(p.pairId) === String(pairId));
  }

  async positions(): Promise<Position[]> {
    const res = await this.client.getOpenPositions({ user: this.trader });
    return res.pairPositions.map((pp) => pp.position);
  }

  async usdcBalance(): Promise<number> {
    return Number((await this.client.getBalances(this.trader)).usdc);
  }

  positionFor(positions: Position[], pairId: string): PositionView {
    const p = positions.find((x) => String(x.pairId) === String(pairId));
    if (!p) return { state: 'flat', pairId, idx: null };
    return { state: p.side === 'B' ? 'long' : 'short', pairId: String(p.pairId), idx: p.idx };
  }

  /** Order(s) initiated by a given submission tx — use to track settlement (isPending/isCancelled). */
  async ordersByTx(txHash: string): Promise<Order[]> {
    return this.client.getOrders({ initiatedTxHashes: [txHash as `0x${string}`], user: this.trader });
  }

  /** Cancel a timed-out pending market OPEN to reclaim its collateral. */
  async cancelPendingOpen(orderId: number): Promise<SubmissionResult> {
    return this.serializeWrite(() => wrap(() => this.client.cancelOrder({ type: CancelOrderType.PendingOpen, orderId })));
  }

  // --- writes (gasless UserOperations) ---
  async openMarket(args: OpenMarketArgs): Promise<SubmissionResult> {
    return this.serializeWrite(() =>
      wrap(() =>
        this.client.openTrade({
          pairId: args.pairId,
          buy: args.isLong,
          price: String(args.orderType === 'limit' ? (args.limitPrice ?? args.price) : args.price),
          collateral: String(args.collateral),
          leverage: String(args.leverage),
          type: args.orderType === 'limit' ? OrderType.Limit : OrderType.Market,
          ...(args.takeProfit ? { takeProfit: String(args.takeProfit) } : {}),
          ...(args.stopLoss ? { stopLoss: String(args.stopLoss) } : {}),
          ...(args.slippageBps != null ? { slippage: args.slippageBps } : {}),
        }),
      ),
    );
  }

  async close(args: CloseArgs): Promise<SubmissionResult> {
    return this.serializeWrite(() =>
      wrap(() =>
        this.client.closeTrade({
          pairId: args.pairId,
          idx: args.idx,
          price: String(args.price),
          closePercent: args.closePercent ?? 100,
          ...(args.slippageBps != null ? { slippage: args.slippageBps } : {}),
        }),
      ),
    );
  }
}

export class OstiumExecError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OstiumError) throw new OstiumExecError(`${e.code}: ${e.message}`, e.code);
    throw new OstiumExecError(e instanceof Error ? e.message : String(e));
  }
}
