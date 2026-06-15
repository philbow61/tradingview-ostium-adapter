/**
 * Fastify receiver (DESIGN §2/§3): verify secret -> validate -> freshness -> dedup
 * -> ENQUEUE -> return 200 fast. The SDK is NEVER called on the request path.
 */
import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig } from './config';
import { DedupStore, dedupKey } from './dedup';
import { OstiumExecutor, type ExecutorConfig } from './ostium';
import { SignalV1, dedupKeyMaterial, lagSeconds } from './schema';
import { EventStore } from './state';
import { SymbolMapper, type SdkPairLike } from './symbols';
import { SerialQueue } from './queue';
import { makeNotifier } from './notify';
import { Worker, type Job } from './worker';
import { DashboardReader } from './reader';
import { dashboardHtml } from './dashboard';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SESSION_STARTED_AT = Math.floor(Date.now() / 1000); // unix seconds — session PnL is measured from here

function constantTimeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** config.yaml if present; else the shipped example — zero-config boot (e.g. a fresh Replit fork). */
function resolveConfigPath(): string {
  if (process.env.ADAPTER_CONFIG) return process.env.ADAPTER_CONFIG;
  if (existsSync('config.yaml')) return 'config.yaml';
  if (existsSync('config.example.yaml')) {
    console.warn('[receiver] config.yaml not found — using config.example.yaml (copy it to customize / go live).');
    return 'config.example.yaml';
  }
  return 'config.yaml'; // let loadConfig surface a clear ENOENT
}

function buildMapper(): SymbolMapper {
  const file = `${DATA_DIR}/pairs.json`;
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(data) && data.length && 'pairFrom' in data[0]) {
      return SymbolMapper.fromSdkPairs(data as SdkPairLike[]);
    }
    return new SymbolMapper(data);
  }
  return SymbolMapper.fromDefault();
}

export async function buildServer(): Promise<FastifyInstance> {
  mkdirSync(DATA_DIR, { recursive: true });
  const config = loadConfig(resolveConfigPath());

  // Testnet-first guardrail (template default). Mainnet requires a deliberate opt-in.
  if (config.global.network === 'mainnet' && process.env.ALLOW_MAINNET !== 'true') {
    throw new Error(
      'Refusing to start on MAINNET — this adapter is testnet-first. Use network: testnet, ' +
        'or set ALLOW_MAINNET=true to override (real funds at risk).',
    );
  }
  const mapper = buildMapper();
  const dedup = new DedupStore(`${DATA_DIR}/dedup.sqlite`);
  const events = new EventStore(`${DATA_DIR}/events.sqlite`);

  const anyLive = Object.values(config.strategies).some((s) => s.mode === 'live');
  let executorConfig: Omit<ExecutorConfig, 'network'> | undefined;
  if (anyLive) {
    const dk = process.env.DELEGATE_PRIVATE_KEY;
    const trader = process.env.TRADER_ADDRESS;
    if (dk && trader) {
      executorConfig = {
        delegatePrivateKey: dk as `0x${string}`,
        traderAddress: trader as `0x${string}`,
        ...(process.env.PIMLICO_URL ? { pimlicoUrl: process.env.PIMLICO_URL } : {}),
        ...(process.env.SPONSORSHIP_POLICY_ID ? { sponsorshipPolicyId: process.env.SPONSORSHIP_POLICY_ID } : {}),
        ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
      };
    } else {
      // Live configured but signing secrets missing (e.g. a fresh Replit fork before Secrets are
      // added): degrade live strategies to dry-run so the server + dashboard still boot. Add
      // DELEGATE_PRIVATE_KEY + TRADER_ADDRESS and restart to trade for real.
      console.warn(
        '[receiver] live strategy configured but DELEGATE_PRIVATE_KEY / TRADER_ADDRESS missing — running DRY-RUN until they are set.',
      );
      for (const s of Object.values(config.strategies)) if (s.mode === 'live') s.mode = 'dry_run';
    }
  }

  const notifier = makeNotifier(process.env.DISCORD_WEBHOOK_URL);
  const worker = new Worker({ config, mapper, dedup, events, notifier, ...(executorConfig ? { executorConfig } : {}) });
  const queue = new SerialQueue<Job>((job) => worker.process(job));

  // Read-only data source for the dashboard (T-111). Never trades; createReadOnly needs no key,
  // and the on-chain delegate check is best-effort (only when a delegate key is configured).
  const reader = new DashboardReader({
    network: config.global.network,
    ...(process.env.TRADER_ADDRESS ? { trader: process.env.TRADER_ADDRESS } : {}),
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
    ...(process.env.DELEGATE_PRIVATE_KEY ? { delegateKey: process.env.DELEGATE_PRIVATE_KEY } : {}),
  });

  // Dashboard "Close position" action. Closing is a state-changing on-chain action on a public URL,
  // so it's token-gated (DASHBOARD_TOKEN, falling back to the shared STRAT_DEMO_SECRET) and uses a
  // lazily-built executor (separate from the worker's; shares the delegate key).
  const CLOSE_TOKEN = process.env.DASHBOARD_TOKEN || process.env.STRAT_DEMO_SECRET || '';
  let closeExecPromise: Promise<OstiumExecutor> | undefined;
  function getCloseExec(): Promise<OstiumExecutor> | undefined {
    if (!executorConfig) return undefined;
    if (!closeExecPromise) closeExecPromise = OstiumExecutor.create({ network: config.global.network, ...executorConfig });
    return closeExecPromise;
  }

  const app = Fastify({ logger: false });
  // TradingView sends the alert message as text/plain (or no content-type). Take ALL
  // bodies as a raw string and parse JSON ourselves so we control the error response.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/healthz', async () => ({
    ok: true,
    network: config.global.network,
    strategies: Object.keys(config.strategies),
  }));

  // --- Dashboard (T-111): self-contained operator view served by this same receiver ---
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(dashboardHtml()));

  app.get('/api/status', async () => ({
    ok: true,
    network: config.global.network,
    killSwitch: config.global.killSwitch,
    trader: process.env.TRADER_ADDRESS ?? null,
    strategies: Object.values(config.strategies).map((s) => ({
      id: s.strategyId,
      mode: s.mode,
      enabled: s.enabled,
      pairs: s.allowedPairs,
    })),
    delegate: await reader.delegate(),
    canClose: Boolean(CLOSE_TOKEN && executorConfig),
  }));

  app.get('/api/positions', async (_req, reply) => {
    try {
      const [snap, session] = await Promise.all([reader.positions(), reader.session(SESSION_STARTED_AT)]);
      return { ...snap, session, lastSignalAt: events.latest('received') };
    } catch (e) {
      return reply.code(200).send({ error: e instanceof Error ? e.message : String(e), positions: [], session: null });
    }
  });

  // Close one open position on-chain. Token-gated (never embed the token in the page).
  app.post('/api/close', async (req, reply) => {
    if (!CLOSE_TOKEN) {
      return reply.code(403).send({ error: 'close_disabled', detail: 'set DASHBOARD_TOKEN (or STRAT_DEMO_SECRET) to enable closing from the dashboard' });
    }
    const token = (req.headers['x-adapter-secret'] as string | undefined) ?? '';
    if (!constantTimeEq(token, CLOSE_TOKEN)) return reply.code(401).send({ error: 'unauthorized' });

    const execP = getCloseExec();
    if (!execP) {
      return reply.code(503).send({ error: 'no_executor', detail: 'live signing not configured (DELEGATE_PRIVATE_KEY + TRADER_ADDRESS)' });
    }

    let body: { pairId?: string | number };
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : ((req.body as { pairId?: string | number }) ?? {});
    } catch {
      return reply.code(422).send({ error: 'invalid_json' });
    }
    const pairId = body.pairId != null ? String(body.pairId) : '';
    if (!pairId) return reply.code(422).send({ error: 'missing_pairId' });

    try {
      const exec = await execP;
      const positions = await exec.positions();
      const pos = exec.positionFor(positions, pairId);
      if (pos.state === 'flat' || pos.idx == null) return reply.code(200).send({ error: 'no_position' });
      const full = positions.find((p) => String(p.pairId) === pairId);
      const pInfo = (await exec.pairs()).find((p) => String(p.pairId) === pairId);
      const price = Number(pInfo?.midPx) || 0;
      const res = await exec.close({ pairId, idx: pos.idx, price, slippageBps: 150 });
      const pairName = full ? `${full.pairFrom}/${full.pairTo}` : pairId;
      events.log('submitted', { strategyId: 'dashboard', data: { action: 'close', manual: true, pair: pairName, pairId, txHash: res.txHash } });
      return reply.code(200).send({ ok: true, txHash: res.txHash });
    } catch (e) {
      return reply.code(200).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/events', async (req) => {
    const limit = Number((req.query as Record<string, string>)?.limit ?? 50);
    return events.recent(limit);
  });

  app.post('/tv/:path', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});

    let body: unknown;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return reply.code(422).send({ error: 'invalid_json' });
    }
    const parsed = SignalV1.safeParse(body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_payload', detail: parsed.error.issues });
    }
    const sig = parsed.data;

    const strat = config.strategies[sig.strategy_id];
    if (!strat || !strat.secret || !constantTimeEq(sig.secret, strat.secret)) {
      app.log.warn(`auth fail strategy_id=${sig.strategy_id}`);
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (config.global.enforceIpAllowlist && config.global.tvAllowedIps.length) {
      if (!config.global.tvAllowedIps.includes(req.ip)) {
        return reply.code(403).send({ error: 'forbidden_ip' });
      }
    }

    const maxLag = Math.min(sig.max_lag_sec, config.global.maxLagSecHardCap);
    const lag = lagSeconds(sig);
    if (lag != null && lag > maxLag) {
      events.log('stale', { strategyId: sig.strategy_id, data: { lag, maxLag } });
      return reply.code(200).send('stale, ignored');
    }

    const key = dedupKey(dedupKeyMaterial(sig));
    const claim = dedup.claim(key);
    if (!claim.isNew) {
      events.log('deduped', {
        strategyId: sig.strategy_id,
        dedupKey: key,
        data: { status: claim.status, ticker: sig.ticker, sentiment: sig.sentiment },
      });
      return reply.code(200).send(`duplicate (${claim.status}), ignored`);
    }

    queue.push({ signal: sig, strategy: strat, dedupKey: key, clientOrderId: claim.clientOrderId });
    events.log('received', {
      strategyId: sig.strategy_id, dedupKey: key,
      data: { ticker: sig.ticker, sentiment: sig.sentiment, mode: strat.mode },
    });
    return reply.code(200).send('ok');
  });

  app.addHook('onClose', async () => {
    dedup.close();
    events.close();
  });

  return app;
}

// Entry point (only when run directly, not when imported by tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  // On Replit (REPL_ID present) bind 0.0.0.0 so the public webview/Deployment URL can reach us.
  const host = process.env.HOST ?? (process.env.REPL_ID ? '0.0.0.0' : '127.0.0.1');
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then((addr) => console.log(`[receiver] listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
