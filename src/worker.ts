/**
 * Execution worker (DESIGN §3/§5): map ticker -> pair, resolve target-state (open/close/flip),
 * size from live collateral, route to Ostium, and CONFIRM oracle settlement.
 *
 * Lifecycle (live): submit -> poll until the order settles into a position, is cancelled by the
 * venue, or times out (then we cancel the pending open and reclaim collateral). Flip = close ->
 * await flat -> re-read equity -> open -> await settle.
 */
import type { AppConfig, StrategyConfig } from './config';
import { pairAllowed } from './config';
import { DedupStore } from './dedup';
import { OstiumExecutor, OstiumExecError, type ExecutorConfig, type IExecutor } from './ostium';
import type { SignalV1, Sentiment } from './schema';
import { bracketToPrice, sizePosition, SizingError, type PairLimits, type SizeResult } from './sizing';
import { EventStore } from './state';
import { SymbolMapper } from './symbols';
import { resolveOps } from './targetState';
import type { Notifier } from './notify';
import { NoopNotifier } from './notify';

export interface Job {
  signal: SignalV1;
  strategy: StrategyConfig;
  dedupKey: string;
  clientOrderId: string;
}

export interface SettleConfig {
  attempts: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultSettle: SettleConfig = {
  // ~150s — testnet oracle-keeper settlement can exceed 90s; be generous before reclaiming.
  attempts: 60,
  pollMs: 2500,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface WorkerDeps {
  config: AppConfig;
  mapper: SymbolMapper;
  dedup: DedupStore;
  events: EventStore;
  executor?: IExecutor; // inject for tests; otherwise built lazily from executorConfig
  executorConfig?: Omit<ExecutorConfig, 'network'>;
  settle?: Partial<SettleConfig>;
  notifier?: Notifier;
}

type OpenOutcome =
  | { kind: 'settled' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'timeout'; orderId?: number };

export class Worker {
  private executor?: IExecutor;
  private executorPromise?: Promise<IExecutor>;
  // Account-wide lock: USDC is shared across all pairs, so equity-based sizing + the open submit
  // must not interleave with another pair's. reservedCollateral covers in-flight opens the balance
  // read can't see yet.
  private acctChain: Promise<unknown> = Promise.resolve();
  private reservedCollateral = 0;
  private settle: SettleConfig;
  private notifier: Notifier;

  constructor(private deps: WorkerDeps) {
    this.executor = deps.executor;
    this.settle = { ...defaultSettle, ...(deps.settle ?? {}) };
    this.notifier = deps.notifier ?? new NoopNotifier();
  }

  // Concurrency-safe: with per-pair queues, multiple jobs may call live() at once — build once.
  private async live(): Promise<IExecutor> {
    if (this.executor) return this.executor;
    if (!this.executorPromise) {
      const ec = this.deps.executorConfig;
      if (!ec) throw new Error('no executor config for live mode');
      this.executorPromise = OstiumExecutor.create({ network: this.deps.config.global.network, ...ec }).then((e) => {
        this.executor = e;
        return e;
      });
    }
    return this.executorPromise;
  }

  /** The shared executor — the dashboard close path reuses ONE instance (one ERC-4337 nonce chain). */
  async getExecutor(): Promise<IExecutor> {
    return this.live();
  }

  private serializeAccount<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.acctChain.then(fn, fn);
    this.acctChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async process(job: Job): Promise<void> {
    const { signal: sig, strategy: strat } = job;
    const { config, mapper, dedup } = this.deps;
    const live = strat.mode === 'live' && !sig.dry_run;

    if (config.global.killSwitch || !strat.enabled) return this.reject(job, 'kill_switch_or_disabled');

    const pair = mapper.resolve(sig.ticker);
    if (!pair || !pairAllowed(strat, pair.pairName)) return this.reject(job, `unmapped_or_disallowed:${sig.ticker}`);

    dedup.mark(job.dedupKey, 'EXECUTING');

    let price = sig.signal_price ?? 0;
    let equity = 0;
    let current: 'long' | 'short' | 'flat' = sig.prev_sentiment ?? 'flat';
    let pairId: string = pair.pairId ?? ''; // resolved to the live pairId in the live branch
    let limits: PairLimits = {
      minNotional: config.global.minCollateralUsdc,
      minLeverage: 1,
      maxLeverage: strat.maxLeverage,
      minCollateral: config.global.minCollateralUsdc,
    };
    let exec: IExecutor | undefined;

    if (live) {
      exec = await this.live();
      const pInfo = (await exec.pairs()).find(
        (x) => String(x.pairId) === String(pairId) || `${x.pairFrom}/${x.pairTo}`.toUpperCase() === pair.pairName,
      );
      if (!pInfo) return this.reject(job, `pair_not_live:${pair.pairName}`);
      if (!pInfo.isMarketOpen) return this.reject(job, 'market_closed');
      pairId = String(pInfo.pairId);
      price = Number(pInfo.midPx);
      limits = {
        minNotional: Number(pInfo.minNtl) || config.global.minCollateralUsdc,
        minLeverage: 1,
        maxLeverage: pInfo.maxLeverage || strat.maxLeverage,
        minCollateral: config.global.minCollateralUsdc,
      };
      current = exec.positionFor(await exec.positions(), pairId).state;
    }

    const plan = resolveOps(current, sig.sentiment);
    if (!plan.close && !plan.open) {
      this.info(job, 'noop', { current, target: sig.sentiment });
      return dedup.mark(job.dedupKey, 'FILLED', 'noop');
    }

    let size: SizeResult | undefined;
    if (plan.open && !live) {
      // Eager size for the dry-run plan only; live sizing happens inside the account lock below.
      try {
        size = this.sizeOpen(sig, strat, equity, price, limits);
      } catch (e) {
        if (e instanceof SizingError) return this.reject(job, `sizing:${e.message}`);
        throw e;
      }
    }

    // --- DRY RUN ---
    if (!live || !exec) {
      const tp = plan.open ? bracketToPrice(sig.sentiment, price, sig.take_profit, true) : undefined;
      const sl = plan.open ? bracketToPrice(sig.sentiment, price, sig.stop_loss, false) : undefined;
      this.info(job, 'dry_run_plan', {
        pair: pair.pairName, current, target: sig.sentiment, ops: plan, refPrice: price,
        collateral: size?.collateral, leverage: size?.leverage, notional: size?.notional,
        takeProfit: tp, stopLoss: sl,
      });
      return dedup.mark(job.dedupKey, 'FILLED', 'dry_run');
    }

    // --- LIVE ---
    const slippageBps = Math.round(strat.slippagePct * 100);
    const isFlip = plan.close && plan.open;
    const ex = exec; // live ⇒ exec is defined; stable ref for the account-lock closure
    try {
      // CLOSE leg (flatten or first half of a flip)
      if (plan.close && current !== 'flat') {
        if (isFlip) this.info(job, 'flip_in_progress', { pair: pair.pairName, from: current, to: sig.sentiment });
        // Close ALL positions on this pair. Ostium allows multiple positions per pair, and a stray
        // extra (a manual UI trade, a slow-keeper open the adapter gave up on, or a second strategy
        // on the same pair) would otherwise block confirmClosed forever — the pair never reads flat.
        const toClose = (await exec.positions()).filter((p) => String(p.pairId) === pairId);
        if (toClose.length) {
          let lastTx: string | undefined;
          for (const p of toClose) {
            const closeRes = await exec.close({ pairId, idx: p.idx, price, slippageBps });
            lastTx = closeRes.txHash;
            // Surface each on-chain tx immediately (pending) so a stalled keeper is visible.
            this.info(job, 'submitted', { pair: pair.pairName, action: 'close', idx: p.idx, txHash: closeRes.txHash });
          }
          const closed = await this.confirmClosed(exec, pairId);
          if (!closed) return this.reject(job, 'close_not_settled');
          this.info(job, 'closed', { pair: pair.pairName, pairId, txHash: lastTx });
        }
      }

      // OPEN leg — size + submit under the account lock so concurrent pairs don't double-spend the
      // shared USDC balance (reservedCollateral covers in-flight opens the balance read can't see yet).
      if (plan.open) {
        const tp = bracketToPrice(sig.sentiment, price, sig.take_profit, true);
        const sl = bracketToPrice(sig.sentiment, price, sig.stop_loss, false);
        let reserved = 0;
        try {
          const res = await this.serializeAccount(async () => {
            const eq = (await ex.usdcBalance()) - this.reservedCollateral;
            size = this.sizeOpen(sig, strat, eq, price, limits);
            const r = await ex.openMarket({
              pairId, isLong: sig.sentiment === 'long',
              collateral: size.collateral, leverage: size.leverage, price, slippageBps,
              orderType: sig.order_type,
              ...(tp != null ? { takeProfit: tp } : {}),
              ...(sl != null ? { stopLoss: sl } : {}),
              ...(sig.limit_price != null ? { limitPrice: sig.limit_price } : {}),
            });
            reserved = size.collateral;
            this.reservedCollateral += reserved;
            return r;
          }).catch((e) => {
            if (e instanceof SizingError) {
              this.reject(job, `sizing:${e.message}`);
              return null;
            }
            throw e;
          });
          if (res == null) return; // sizing rejected (already marked FAILED)
          // Surface the on-chain tx immediately (pending) so a stalled keeper is visible.
          this.info(job, 'submitted', { pair: pair.pairName, action: 'open', side: sig.sentiment, txHash: res.txHash });
          const outcome = await this.confirmOpen(ex, res.txHash, pairId, sig.sentiment);
          if (outcome.kind === 'cancelled') return this.reject(job, `open_cancelled:${outcome.reason}`);
          if (outcome.kind === 'timeout') {
            if (outcome.orderId != null) {
              const cancelRes = await ex.cancelPendingOpen(outcome.orderId);
              this.info(job, 'reclaimed', { pair: pair.pairName, txHash: cancelRes.txHash, orderId: outcome.orderId });
            }
            return this.reject(job, 'open_not_settled_reclaimed');
          }
          this.info(job, 'opened', {
            pair: pair.pairName, txHash: res.txHash, smartAccount: res.smartAccountAddress,
            collateral: size!.collateral, leverage: size!.leverage, notional: size!.notional, refPrice: price,
          });
        } finally {
          this.reservedCollateral -= reserved; // release the reservation once the open resolves
        }
      }
      dedup.mark(job.dedupKey, 'FILLED');
    } catch (e) {
      if (e instanceof OstiumExecError) return this.reject(job, `exec:${e.message}`);
      throw e;
    }
  }

  /** Poll until the order settles into a position (matching the target side), is cancelled, or times out. */
  private async confirmOpen(exec: IExecutor, txHash: string, pairId: string, want: Sentiment): Promise<OpenOutcome> {
    let orderId: number | undefined;
    for (let i = 0; i < this.settle.attempts; i++) {
      const pos = exec.positionFor(await exec.positions(), pairId);
      if (pos.state === want) return { kind: 'settled' };
      const [order] = await exec.ordersByTx(txHash);
      const o = order as unknown as Record<string, unknown> | undefined;
      const oid = Number(o?.['oid'] ?? o?.['pid']);
      if (Number.isFinite(oid) && oid > 0) orderId = oid;
      if (order?.isCancelled) return { kind: 'cancelled', reason: order.cancelReason ?? 'unknown' };
      await this.settle.sleep(this.settle.pollMs);
    }
    return orderId != null ? { kind: 'timeout', orderId } : { kind: 'timeout' };
  }

  /** Poll until the position for a pair is gone (flat). Returns false on timeout. */
  private async confirmClosed(exec: IExecutor, pairId: string): Promise<boolean> {
    for (let i = 0; i < this.settle.attempts; i++) {
      if (exec.positionFor(await exec.positions(), pairId).state === 'flat') return true;
      await this.settle.sleep(this.settle.pollMs);
    }
    return false;
  }

  private sizeOpen(sig: SignalV1, strat: StrategyConfig, equity: number, price: number, limits: PairLimits): SizeResult {
    let mode = strat.sizing.defaultMode;
    let value = strat.sizing.defaultValue;
    let leverage = strat.defaultLeverage;
    if (strat.sizing.allowPayloadOverride) {
      if (sig.sizing) { mode = sig.sizing.mode; value = sig.sizing.value; }
      if (sig.leverage) leverage = sig.leverage;
    }
    const slPrice = bracketToPrice(sig.sentiment, price, sig.stop_loss, false);
    return sizePosition({
      mode, value, equity, price, leverage, limits,
      configMaxLeverage: strat.maxLeverage,
      maxPositionNotional: strat.sizing.maxPositionNotional,
      ...(slPrice != null ? { stopLossPrice: slPrice } : {}),
    });
  }

  private info(job: Job, kind: string, data: Record<string, unknown>): void {
    console.log(`[worker] ${kind} ${job.clientOrderId}`, data);
    this.deps.events.log(kind, { strategyId: job.strategy.strategyId, dedupKey: job.dedupKey, data });
    if (kind === 'opened' || kind === 'closed') {
      void this.notifier.send(`✅ ${job.strategy.strategyId}: ${kind} ${JSON.stringify(data)}`);
    }
  }

  private reject(job: Job, reason: string): void {
    console.warn(`[worker] reject ${job.clientOrderId}: ${reason}`);
    this.deps.events.log('reject', { strategyId: job.strategy.strategyId, dedupKey: job.dedupKey, data: { reason } });
    this.deps.dedup.mark(job.dedupKey, 'FAILED', reason);
    void this.notifier.send(`⚠️ ${job.strategy.strategyId}: rejected — ${reason}`);
  }
}
