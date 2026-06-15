import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig, StrategyConfig } from '../src/config';
import { DedupStore, dedupKey } from '../src/dedup';
import type { IExecutor, OpenMarketArgs, CloseArgs, PositionView } from '../src/ostium';
import { SignalV1 } from '../src/schema';
import { EventStore } from '../src/state';
import { SymbolMapper } from '../src/symbols';
import { Worker, type Job } from '../src/worker';

// A controllable in-memory executor implementing IExecutor.
class FakeExecutor implements IExecutor {
  positionsList: Array<{ pairId: string; side: 'B' | 'S'; idx: number; pairFrom: string; pairTo: string }> = [];
  equity = 100_000;
  marketOpen = true;
  orderCancelled = false;
  settleOnOpen = true; // if true, openMarket immediately creates the settled position
  calls: string[] = [];
  lastOpen?: OpenMarketArgs;
  cancelled: number[] = [];

  midPx = '64000'; // getPairs().midPx — can be set to '0' to exercise the oracle fallback
  async pairs() {
    return [{ pairId: '0', pairFrom: 'BTC', pairTo: 'USD', isMarketOpen: this.marketOpen, midPx: this.midPx, maxLeverage: 50, minNtl: '5.0' }] as any;
  }
  async pairById(id: string) {
    return (await this.pairs()).find((p: any) => String(p.pairId) === id);
  }
  oraclePrice = 64000; // real-time feed fallback (used when pairs().midPx is 0)
  async price(_id: string) {
    return this.oraclePrice;
  }
  async positions() {
    return this.positionsList as any;
  }
  async usdcBalance() {
    return this.equity;
  }
  positionFor(positions: any[], pairId: string): PositionView {
    const p = positions.find((x) => String(x.pairId) === String(pairId));
    if (!p) return { state: 'flat', pairId, idx: null };
    return { state: p.side === 'B' ? 'long' : 'short', pairId: String(p.pairId), idx: p.idx };
  }
  async openMarket(args: OpenMarketArgs) {
    this.calls.push('open');
    this.lastOpen = args;
    if (this.settleOnOpen) {
      this.positionsList = [{ pairId: args.pairId, side: args.isLong ? 'B' : 'S', idx: 0, pairFrom: 'BTC', pairTo: 'USD' }];
    }
    return { txHash: '0xopen' as `0x${string}` };
  }
  async close(_args: CloseArgs) {
    this.calls.push('close');
    this.positionsList = []; // close settles immediately in the fake
    return { txHash: '0xclose' as `0x${string}` };
  }
  async ordersByTx() {
    return [{ isPending: !this.orderCancelled, isCancelled: this.orderCancelled, cancelReason: this.orderCancelled ? 'slippage' : undefined, oid: '999' }] as any;
  }
  async cancelPendingOpen(orderId: number) {
    this.calls.push('cancelPendingOpen');
    this.cancelled.push(orderId);
    return { txHash: '0xcancel' as `0x${string}` };
  }
}

function liveConfig(): AppConfig {
  const strat: StrategyConfig = {
    strategyId: 'btc-live', enabled: true, mode: 'live', secret: 's',
    defaultLeverage: 10, maxLeverage: 50, slippagePct: 1,
    sizing: { defaultMode: 'fixed_notional', defaultValue: 100, maxPositionNotional: 2000, allowPayloadOverride: true },
    allowedPairs: ['BTC/USD'],
    risk: { maxOpenPositions: 1, requireSlForRiskMode: true },
  };
  return {
    global: { network: 'testnet', killSwitch: false, tvAllowedIps: [], enforceIpAllowlist: false, maxLagSecHardCap: 120, minCollateralUsdc: 5 },
    strategies: { 'btc-live': strat },
  };
}

function sig(over: Record<string, unknown> = {}) {
  return SignalV1.parse({
    secret: 's', strategy_id: 'btc-live', schema: 'ostium-adapter/v1',
    sentiment: 'long', ticker: 'BTCUSD', order_type: 'market',
    sizing: { mode: 'fixed_notional', value: 100 }, leverage: 10,
    nonce: `n-${Math.random()}`, dry_run: false, ...over,
  });
}

describe('Worker live lifecycle (fake executor)', () => {
  let dir: string, dedup: DedupStore, events: EventStore, fake: FakeExecutor;
  const mapper = SymbolMapper.fromSdkPairs([{ pairId: 0, pairFrom: 'BTC', pairTo: 'USD' }]);
  const fastSettle = { attempts: 3, pollMs: 0, sleep: async () => {} };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wrk-'));
    dedup = new DedupStore(join(dir, 'd.sqlite'));
    events = new EventStore(join(dir, 'e.sqlite'));
    fake = new FakeExecutor();
  });
  afterEach(() => { dedup.close(); events.close(); });

  function worker() {
    return new Worker({ config: liveConfig(), mapper, dedup, events, executor: fake, settle: fastSettle });
  }
  function job(s = sig()): Job {
    const key = dedupKey(`${Math.random()}`);
    dedup.claim(key);
    return { signal: s, strategy: liveConfig().strategies['btc-live']!, dedupKey: key, clientOrderId: key.slice(0, 32) };
  }

  it('flat->long open that settles -> FILLED', async () => {
    const j = job();
    await worker().process(j);
    expect(fake.calls).toEqual(['open']);
    expect(fake.lastOpen?.isLong).toBe(true);
    expect(dedup.status(j.dedupKey)).toBe('FILLED');
  });

  it('open that never settles -> cancels pending open + FAILED', async () => {
    fake.settleOnOpen = false; // position never appears
    const j = job();
    await worker().process(j);
    expect(fake.calls).toContain('cancelPendingOpen');
    expect(fake.cancelled).toEqual([999]);
    expect(dedup.status(j.dedupKey)).toBe('FAILED');
  });

  it('flip long->short -> close then open, FILLED', async () => {
    fake.positionsList = [{ pairId: '0', side: 'B', idx: 0, pairFrom: 'BTC', pairTo: 'USD' }]; // currently long
    const j = job(sig({ sentiment: 'short', prev_sentiment: 'long' }));
    await worker().process(j);
    expect(fake.calls).toEqual(['close', 'open']);
    expect(fake.lastOpen?.isLong).toBe(false);
    expect(dedup.status(j.dedupKey)).toBe('FILLED');
  });

  it('midPx 0 -> falls back to oracle price, opens with it (regression: oil WrongParams)', async () => {
    fake.midPx = '0'; // getPairs().midPx flaked to 0 (observed on oil/WTI)
    fake.oraclePrice = 79.07; // real-time feed still has the price
    const j = job();
    await worker().process(j);
    expect(fake.calls).toEqual(['open']);
    expect(fake.lastOpen?.price).toBe(79.07); // never submits the 0 price that reverts WrongParams
    expect(dedup.status(j.dedupKey)).toBe('FILLED');
  });

  it('no price anywhere (midPx 0 + oracle 0) -> rejected no_price, no open', async () => {
    fake.midPx = '0';
    fake.oraclePrice = 0;
    const j = job();
    await worker().process(j);
    expect(fake.calls).toEqual([]); // refuses to burn a gasless op on a guaranteed revert
    expect(dedup.status(j.dedupKey)).toBe('FAILED');
  });

  it('kill switch -> FAILED, no calls', async () => {
    const cfg = liveConfig();
    cfg.global.killSwitch = true;
    const j = job();
    await new Worker({ config: cfg, mapper, dedup, events, executor: fake, settle: fastSettle }).process(j);
    expect(fake.calls).toEqual([]);
    expect(dedup.status(j.dedupKey)).toBe('FAILED');
  });
});
