/** End-to-end receiver test in dry-run mode (no key, no chain). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'tvostium-'));
process.env.ADAPTER_CONFIG = 'config.example.yaml';
process.env.STRAT_GOLD_SECRET = 'testsecret';
process.env.STRAT_OIL_SECRET = 'testsecret-oil';
delete process.env.DELEGATE_PRIVATE_KEY;

const { buildServer } = await import('../src/server');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signal(over: Record<string, unknown> = {}) {
  return {
    secret: 'testsecret', strategy_id: 'gold-demo-001', schema: 'ostium-adapter/v1',
    action: 'buy', sentiment: 'long', prev_sentiment: 'flat',
    ticker: 'OANDA:XAUUSD', order_type: 'market',
    sizing: { mode: 'fixed_notional', value: '100' }, leverage: '10',
    signal_price: '2350.5', tv_contracts: '2',
    bar_time: '2026-06-13T14:00:00Z', nonce: `Long-${Math.random()}`, dry_run: true, max_lag_sec: 600,
    ...over,
  };
}

describe('receiver (dry-run e2e)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it('health', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.json().network).toBe('testnet');
  });

  it('happy path -> 200 ok, then duplicate, auth + schema guards, worker plan', async () => {
    const sig = signal();
    const r1 = await app.inject({ method: 'POST', url: '/tv/x', payload: sig });
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toBe('ok');

    const r2 = await app.inject({ method: 'POST', url: '/tv/x', payload: sig });
    expect(r2.body).toContain('duplicate');

    const bad = await app.inject({ method: 'POST', url: '/tv/x', payload: signal({ secret: 'wrong' }) });
    expect(bad.statusCode).toBe(401);

    const unknown = await app.inject({ method: 'POST', url: '/tv/x', payload: signal({ strategy_id: 'nope' }) });
    expect(unknown.statusCode).toBe(401);

    const garbage = await app.inject({ method: 'POST', url: '/tv/x', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(garbage.statusCode).toBe(422);

    // worker should resolve a dry-run plan
    let plan: any;
    for (let i = 0; i < 40 && !plan; i++) {
      const evs = (await app.inject({ method: 'GET', url: '/events?limit=20' })).json() as any[];
      plan = evs.find((e) => e.kind === 'dry_run_plan');
      if (!plan) await sleep(50);
    }
    expect(plan).toBeTruthy();
    expect(plan.data.pair).toBe('XAU/USD');
    expect(plan.data.ops).toEqual({ close: false, open: true });
  });
});
