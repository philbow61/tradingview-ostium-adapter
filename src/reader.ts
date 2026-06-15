/**
 * Read-only dashboard data source (T-111). Everything here is READ-ONLY — it never trades.
 *
 *  - positions(): trader balance + open positions + live mark prices via
 *    `OstiumClient.createReadOnly()` (needs no key).
 *  - delegate(): best-effort, cached on-chain check of whether the trader's single delegate slot
 *    still points at our Safe (mirrors scripts/delegate-info.ts). Only runs if a delegate key is
 *    configured; the slot can be re-pointed by the Ostium UI (DECISIONS D-013), so the dashboard
 *    surfaces ✅/❌ live.
 */
import { createPublicClient, http } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { OstiumClient, type MarginSummary } from '@ostium/builder-sdk';

type Network = 'testnet' | 'mainnet';

// Ostium TradingStorage (holds delegations(trader) → delegate Safe). Mirrors scripts/delegate-info.ts.
const TRADING_ADDR: Record<Network, `0x${string}`> = {
  mainnet: '0x6D0bA1f9996DBD8885827e1b2e8f6593e7702411',
  testnet: '0x2A9B9c988393f46a2537B0ff11E98c2C15a95afe',
};
const DELEGATIONS_ABI = [
  {
    name: 'delegations',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export interface DashPosition {
  pairId: string;
  pair: string;
  pairFrom: string;
  pairTo: string;
  side: 'long' | 'short';
  idx: number;
  size: string;
  entryPx: string;
  markPx: string | null;
  leverage: string;
  notional: string;
  unrealizedPnl: string;
  liquidationPx: string;
  collateralUsed: string;
  takeProfit: string | null;
  stopLoss: string | null;
  openedAt: number;
}

export interface DelegateStatus {
  configured: boolean;
  safe: string | null;
  onchain: string | null;
  authorized: boolean | null;
}

export interface PositionsSnapshot {
  trader: string | null;
  balance: { usdc: string; eth: string } | null;
  marginSummary: MarginSummary | null;
  positions: DashPosition[];
  time: number;
}

export interface CloseFill {
  pair: string;
  pairId: string;
  side: 'long' | 'short';
  action: string; // Close | StopLoss | TakeProfit | CloseDayTrade | Liquidation
  exitPx: string;
  pnl: string; // realized closedPnl (USD, net of fees + rollover)
  hash: string; // execution tx (joins to a 'closed' timeline event)
  time: number; // unix seconds
}

export interface SessionStats {
  startedAt: number; // unix seconds
  realizedPnl: number; // sum of closedPnl since startedAt
  count: number;
  wins: number;
  losses: number;
  winRate: number; // wins / (wins + losses), 0..1
  avgWin: number | null; // mean positive closedPnl, null if no wins
  avgLoss: number | null; // mean negative closedPnl, null if no losses
  best: number | null; // largest single win, null if no wins
  worst: number | null; // largest single loss, null if no losses
  recent: CloseFill[]; // newest first
  cumulative: Array<{ t: number; pnl: number }>; // running total, oldest→newest
  error?: string; // set if the fills read failed (vs a genuinely empty session)
}

export interface ReaderOpts {
  network: Network;
  trader?: string;
  rpcUrl?: string;
  delegateKey?: string;
}

export class DashboardReader {
  private client?: Promise<OstiumClient>;
  private delegateClient?: Promise<OstiumClient | null>;
  private safe: string | null = null;
  private delegateCache?: { at: number; value: DelegateStatus };

  constructor(private opts: ReaderOpts) {}

  private read(): Promise<OstiumClient> {
    if (!this.client) {
      this.client = OstiumClient.createReadOnly({
        testnet: this.opts.network === 'testnet',
        ...(this.opts.rpcUrl ? { rpcUrl: this.opts.rpcUrl } : {}),
      });
    }
    return this.client;
  }

  async positions(): Promise<PositionsSnapshot> {
    const trader = this.opts.trader;
    if (!trader) return { trader: null, balance: null, marginSummary: null, positions: [], time: Date.now() };

    const c = await this.read();
    const [open, bal, priceResp] = await Promise.all([
      c.getOpenPositions({ user: trader as `0x${string}` }),
      c.getBalances(trader as `0x${string}`).catch(() => null),
      c.getAllPrices().catch(() => ({ prices: {} as Record<string, { ask: string; bid: string; mid: string }> })),
    ]);
    const prices = priceResp.prices ?? {};

    const positions: DashPosition[] = open.pairPositions.map(({ position: p }) => ({
      pairId: String(p.pairId),
      pair: `${p.pairFrom}/${p.pairTo}`,
      pairFrom: p.pairFrom,
      pairTo: p.pairTo,
      side: p.side === 'B' ? 'long' : 'short',
      idx: p.idx,
      size: p.szi,
      entryPx: p.entryPx,
      markPx: prices[String(p.pairId)]?.mid ?? null,
      leverage: p.leverage,
      notional: p.ntl,
      unrealizedPnl: p.unrealizedPnl,
      liquidationPx: p.liquidationPx,
      collateralUsed: p.collateralUsed,
      takeProfit: p.tpPx ?? null,
      stopLoss: p.slPx ?? null,
      openedAt: p.openTimestamp,
    }));

    return {
      trader,
      balance: bal ? { usdc: bal.usdc, eth: bal.eth } : null,
      marginSummary: open.marginSummary ?? null,
      positions,
      time: open.time ?? Date.now(),
    };
  }

  /** Realized-PnL stats for the current session, from on-chain close fills (Fill.closedPnl). */
  async session(sinceSeconds: number): Promise<SessionStats> {
    const empty: SessionStats = { startedAt: sinceSeconds, realizedPnl: 0, count: 0, wins: 0, losses: 0, winRate: 0, avgWin: null, avgLoss: null, best: null, worst: null, recent: [], cumulative: [] };
    const trader = this.opts.trader;
    if (!trader) return empty;
    const c = await this.read();
    let fills;
    try {
      // Time-bounded so the subgraph filters to the session server-side — no all-time cap can drop in-session fills.
      fills = await c.getFillsByTime({ user: trader as `0x${string}`, startTime: sinceSeconds * 1000 });
    } catch (e) {
      console.warn('[reader] getFillsByTime failed:', e instanceof Error ? e.message : String(e));
      return { ...empty, error: 'fills_unavailable' };
    }
    const CLOSE = new Set(['Close', 'StopLoss', 'TakeProfit', 'CloseDayTrade', 'Liquidation']);
    const closes = fills.filter((f) => CLOSE.has(f.action) && f.time >= sinceSeconds).sort((a, b) => a.time - b.time);

    let cum = 0;
    let wins = 0;
    let losses = 0;
    let winSum = 0;
    let lossSum = 0;
    let best: number | null = null;
    let worst: number | null = null;
    const cumulative = closes.map((f) => {
      const p = Number(f.closedPnl) || 0;
      cum += p;
      if (p > 0) {
        wins++;
        winSum += p;
        if (best === null || p > best) best = p;
      } else if (p < 0) {
        losses++;
        lossSum += p;
        if (worst === null || p < worst) worst = p;
      }
      return { t: f.time, pnl: cum };
    });
    const recent: CloseFill[] = [...closes].reverse().slice(0, 50).map((f) => ({
      pair: `${f.pairFrom}/${f.pairTo}`,
      pairId: String(f.pairId),
      side: f.side === 'B' ? 'long' : 'short',
      action: f.action,
      exitPx: f.px,
      pnl: f.closedPnl,
      hash: f.hash,
      time: f.time,
    }));
    return {
      startedAt: sinceSeconds,
      realizedPnl: cum,
      count: closes.length,
      wins,
      losses,
      winRate: wins + losses ? wins / (wins + losses) : 0,
      avgWin: wins ? winSum / wins : null,
      avgLoss: losses ? lossSum / losses : null,
      best,
      worst,
      recent,
      cumulative,
    };
  }

  /** Cached (~30s) on-chain delegate authorization check. Returns configured:false if no key. */
  async delegate(): Promise<DelegateStatus> {
    const { delegateKey, trader, network } = this.opts;
    if (!delegateKey) return { configured: false, safe: null, onchain: null, authorized: null };

    const now = Date.now();
    if (this.delegateCache && now - this.delegateCache.at < 30_000) return this.delegateCache.value;

    // Derive our Safe once (the SDK computes it deterministically from the delegate key). If the
    // build fails, don't pin null forever — drop the cached promise so the next poll retries.
    if (!this.safe) {
      if (!this.delegateClient) {
        this.delegateClient = OstiumClient.createDelegatedAndGasless({
          delegatePrivateKey: delegateKey as `0x${string}`,
          traderAddress: (trader ?? privateKeyToAccount(delegateKey as `0x${string}`).address) as `0x${string}`,
          testnet: network === 'testnet',
          ...(this.opts.rpcUrl ? { rpcUrl: this.opts.rpcUrl } : {}),
        }).catch(() => null);
      }
      const client = await this.delegateClient;
      if (client) this.safe = client.getSmartAccountAddress() ?? null;
      else this.delegateClient = undefined; // allow a fresh attempt next call
    }

    let onchain: string | null = null;
    let authorized: boolean | null = null;
    if (trader && this.safe) {
      try {
        const pub = createPublicClient({
          chain: network === 'mainnet' ? arbitrum : arbitrumSepolia,
          transport: http(this.opts.rpcUrl),
        });
        const current = (await pub.readContract({
          address: TRADING_ADDR[network],
          abi: DELEGATIONS_ABI,
          functionName: 'delegations',
          args: [trader as `0x${string}`],
        })) as string;
        onchain = current;
        authorized = current.toLowerCase() === this.safe.toLowerCase();
      } catch {
        /* RPC hiccup — leave authorization unknown rather than asserting false */
      }
    }

    const value: DelegateStatus = { configured: true, safe: this.safe, onchain, authorized };
    // Cache a resolved verdict for the full 30s; for an unknown verdict (build or RPC hiccup)
    // back-date the timestamp so it expires in ~10s and the next poll re-checks.
    this.delegateCache = { at: authorized === null ? now - 20_000 : now, value };
    return value;
  }
}
