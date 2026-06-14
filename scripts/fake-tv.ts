/**
 * Simulated TradingView webhook sender (T-044 fallback / reliable demo path).
 * POSTs the exact JSON a TradingView alert would send — long → flip to short → flat — at the
 * running receiver, then streams the resulting events. Proves the full pipeline end-to-end
 * without depending on a live MA-cross.
 *
 * Run the receiver first (`npm start`), then:  npm run fake-tv
 */
import 'dotenv/config';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = process.env.PORT ?? '8080';
const PATHSEG = process.env.TV_PATH ?? 'demo';
const SECRET = process.env.STRAT_BTC_SECRET ?? '';
const TP_PCT = Number(process.env.TP_PCT ?? 5); // take-profit %, 0 = off
const SL_PCT = Number(process.env.SL_PCT ?? 2); // stop-loss %, 0 = off
const BASE = `http://${HOST}:${PORT}`;
const URL = `${BASE}/tv/${PATHSEG}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

function payload(sentiment: 'long' | 'short' | 'flat', prev: string, action?: 'buy' | 'sell') {
  const now = new Date().toISOString();
  return {
    secret: SECRET, strategy_id: 'btc-demo-001', schema: 'ostium-adapter/v1',
    ...(action ? { action } : {}),
    sentiment, prev_sentiment: prev, ticker: 'BTCUSD', order_type: 'market',
    sizing: { mode: 'fixed_notional', value: '100' }, leverage: '10',
    signal_price: '64000', // dry-run reference only; live mode re-quotes from the chain
    // TP/SL only matter on the open leg; include for long/short, skip for the flat close.
    ...(sentiment !== 'flat' && TP_PCT > 0 ? { take_profit: { type: 'percent', value: String(TP_PCT) } } : {}),
    ...(sentiment !== 'flat' && SL_PCT > 0 ? { stop_loss: { type: 'percent', value: String(SL_PCT) } } : {}),
    bar_time: now, fired_at: now,
    nonce: `${sentiment}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    dry_run: false, max_lag_sec: 600,
  };
}

async function post(label: string, body: object) {
  const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  console.log(`[${ts()}] POST ${label.padEnd(14)} → ${res.status} ${await res.text()}`);
}

async function streamEvents(maxMs = 300_000, idleStopMs = 25_000) {
  console.log(`\n--- streaming ${BASE}/events ---`);
  const seen = new Set<string>();
  const start = Date.now();
  let lastEventAt = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const evs = (await (await fetch(`${BASE}/events?limit=40`)).json()) as Array<Record<string, any>>;
      for (const e of evs.reverse()) {
        const key = `${e.ts}|${e.kind}|${e.dedupKey ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lastEventAt = Date.now();
        console.log(`[${ts()}] ${String(e.kind).padEnd(16)} ${JSON.stringify(e.data)}`);
      }
    } catch (err) {
      console.error('events fetch failed:', err);
    }
    if (Date.now() - lastEventAt > idleStopMs) break;
    await sleep(3000);
  }
}

async function main() {
  if (!SECRET) throw new Error('STRAT_BTC_SECRET not set in .env (must match config.yaml btc-demo-001).');
  const health = (await (await fetch(`${BASE}/healthz`)).json()) as { network: string; strategies: string[] };
  console.log(`receiver: ${BASE}  network=${health.network}  strategies=${health.strategies}`);

  // The serial queue processes these in order; the worker re-reads live on-chain state for each,
  // so long→short resolves to a real flip and short→flat to a close.
  await post('1 OPEN long', payload('long', 'flat', 'buy'));
  await sleep(2000);
  await post('2 FLIP short', payload('short', 'long', 'sell'));
  await sleep(2000);
  await post('3 CLOSE flat', payload('flat', 'short'));

  await streamEvents();
  console.log('\ndone. (final on-chain state should be flat)');
}

main().catch((e) => { console.error(e); process.exit(1); });
