import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DedupStore, dedupKey } from '../src/dedup';
import { SignalV1, dedupKeyMaterial } from '../src/schema';
import { SizingError, sizePosition, type PairLimits } from '../src/sizing';

describe('SignalV1 schema', () => {
  it('coerces TradingView string fields', () => {
    const raw = {
      secret: 's', strategy_id: 'gold-demo-001', schema: 'ostium-adapter/v1',
      sentiment: 'long', prev_sentiment: 'flat', ticker: 'OANDA:XAUUSD',
      order_type: 'market', sizing: { mode: 'fixed_notional', value: '100' },
      leverage: '10', signal_price: '2350.5', tv_contracts: '2',
      bar_time: '2026-06-13T14:00:00Z', fired_at: '2026-06-13T14:00:01Z',
      nonce: 'Long-1', dry_run: false,
    };
    const sig = SignalV1.parse(raw);
    expect(sig.leverage).toBe(10);
    expect(sig.sizing?.value).toBe(100);
    expect(sig.dry_run).toBe(false);
    expect(dedupKeyMaterial(sig)).toContain('gold-demo-001');
  });
});

describe('sizing', () => {
  const limits: PairLimits = { minNotional: 5, minLeverage: 1, maxLeverage: 150, minCollateral: 5 };

  it('fixed_notional', () => {
    const r = sizePosition({ mode: 'fixed_notional', value: 100, equity: 0, price: 2350, leverage: 10, limits, configMaxLeverage: 50, maxPositionNotional: 2000 });
    expect(r.notional).toBe(100);
    expect(r.collateral).toBe(10);
    expect(r.leverage).toBe(10);
  });

  it('clamps leverage to config max', () => {
    const r = sizePosition({ mode: 'fixed_notional', value: 1000, equity: 0, price: 2350, leverage: 100, limits, configMaxLeverage: 50, maxPositionNotional: 2000 });
    expect(r.leverage).toBe(50);
  });

  it('rejects above max and below min', () => {
    expect(() => sizePosition({ mode: 'fixed_notional', value: 5000, equity: 0, price: 2350, leverage: 10, limits, configMaxLeverage: 50, maxPositionNotional: 2000 })).toThrow(SizingError);
    const tight: PairLimits = { minNotional: 60, minLeverage: 1, maxLeverage: 150, minCollateral: 5 };
    expect(() => sizePosition({ mode: 'fixed_notional', value: 20, equity: 0, price: 2350, leverage: 10, limits: tight, configMaxLeverage: 50, maxPositionNotional: 2000 })).toThrow(SizingError);
  });
});

describe('dedup state machine', () => {
  it('claims, dedups, and re-claims FAILED', () => {
    const store = new DedupStore(join(tmpdir(), `dedup-${Date.now()}-${process.pid}.sqlite`));
    const k = dedupKey('a|b|c|d|e');
    expect(store.claim(k).isNew).toBe(true);
    expect(store.claim(k).isNew).toBe(false); // RECEIVED -> duplicate
    store.mark(k, 'FILLED');
    expect(store.claim(k).isNew).toBe(false); // FILLED short-circuits
    const k2 = dedupKey('x|y|z|0|1');
    store.claim(k2);
    store.mark(k2, 'FAILED', 'reverted');
    expect(store.claim(k2).isNew).toBe(true); // FAILED -> re-executable
    store.close();
  });
});
