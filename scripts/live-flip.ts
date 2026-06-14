/**
 * Live flip validation (T-042): drive the REAL worker (live executor) through
 * flat→long → flip to short → flat on testnet BTC, exercising the flip saga on-chain
 * (close → await flat → re-size → open). Needs DELEGATE_PRIVATE_KEY + TRADER_ADDRESS in .env.
 *
 *   npm run live-flip
 */
import 'dotenv/config';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../src/config';
import { DedupStore, dedupKey } from '../src/dedup';
import { OstiumExecutor } from '../src/ostium';
import { SignalV1, type Sentiment } from '../src/schema';
import { EventStore } from '../src/state';
import { SymbolMapper, type SdkPairLike } from '../src/symbols';
import { Worker, type Job } from '../src/worker';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

const config: AppConfig = {
  global: { network: NETWORK, killSwitch: false, tvAllowedIps: [], enforceIpAllowlist: false, maxLagSecHardCap: 120, minCollateralUsdc: 5 },
  strategies: {
    'btc-flip': {
      strategyId: 'btc-flip', enabled: true, mode: 'live', secret: 'x',
      defaultLeverage: 10, maxLeverage: 50, slippagePct: 1,
      sizing: { defaultMode: 'fixed_notional', defaultValue: 100, maxPositionNotional: 2000, allowPayloadOverride: true },
      allowedPairs: ['BTC/USD'],
      risk: { maxOpenPositions: 1, requireSlForRiskMode: true },
    },
  },
};

function mapper(): SymbolMapper {
  const f = 'data/pairs.json';
  if (existsSync(f)) return SymbolMapper.fromSdkPairs(JSON.parse(readFileSync(f, 'utf8')) as SdkPairLike[]);
  return SymbolMapper.fromDefault();
}

async function main() {
  if (!process.env.DELEGATE_PRIVATE_KEY || !process.env.TRADER_ADDRESS) {
    throw new Error('set DELEGATE_PRIVATE_KEY and TRADER_ADDRESS in .env');
  }
  const exec = await OstiumExecutor.create({
    network: NETWORK,
    delegatePrivateKey: process.env.DELEGATE_PRIVATE_KEY as `0x${string}`,
    traderAddress: process.env.TRADER_ADDRESS as `0x${string}`,
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const dir = mkdtempSync(join(tmpdir(), 'flip-'));
  const dedup = new DedupStore(join(dir, 'd.sqlite'));
  const events = new EventStore(join(dir, 'e.sqlite'));
  // Generous settle window for testnet keeper latency (3s × 60 = up to 180s per leg).
  const settle = { attempts: 60, pollMs: 3000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  const worker = new Worker({ config, mapper: mapper(), dedup, events, executor: exec, settle });

  const state = async () => {
    const p = exec.positionFor(await exec.positions(), '0');
    return `${p.state}${p.idx != null ? ` (idx ${p.idx})` : ''}`;
  };
  const run = async (label: string, sentiment: Sentiment) => {
    const key = dedupKey(`flip-${sentiment}-${label}-${Math.random()}`);
    dedup.claim(key);
    const sig = SignalV1.parse({
      secret: 'x', strategy_id: 'btc-flip', schema: 'ostium-adapter/v1',
      sentiment, ticker: 'BTCUSD', order_type: 'market',
      sizing: { mode: 'fixed_notional', value: 100 }, leverage: 10, nonce: key, dry_run: false,
    });
    const job: Job = { signal: sig, strategy: config.strategies['btc-flip']!, dedupKey: key, clientOrderId: key.slice(0, 32) };
    console.log(`\n>>> ${label}: target=${sentiment}  (on-chain before: ${await state()})`);
    await worker.process(job);
    console.log(`    dedup=${dedup.status(key)}  on-chain after: ${await state()}`);
  };

  console.log(`BTC pair open=${(await exec.pairById('0'))?.isMarketOpen}; starting state: ${await state()}`);
  await run('1 OPEN long', 'long');
  await run('2 FLIP to short', 'short');
  await run('3 CLOSE to flat', 'flat');

  console.log('\n[events]');
  for (const e of events.recent(20).reverse()) console.log(' ', e.kind, JSON.stringify(e.data));
  console.log(`\nFinal on-chain state: ${await state()}`);
  dedup.close(); events.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
