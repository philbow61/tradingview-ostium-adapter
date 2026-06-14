/**
 * TradingView ticker -> Ostium pair mapping (see docs/DESIGN.md §6).
 *
 * Normalize -> alias table -> split BASE/QUOTE -> HARD-VALIDATE against the live pair set
 * (also try flipped orientation, e.g. CADUSD -> USD/CAD). Reject if no exact match.
 *
 * Canonical pair names are "BASE/QUOTE" (e.g. "CL/USD"). The Builder SDK's getPairs()
 * returns a display `pairFrom` ("WTI" for raw "CL"), so build the live map via fromSdkPairs(),
 * which normalizes display->raw. DEFAULT_PAIRS is an offline fallback (no pairIds).
 */

export interface SdkPairLike {
  pairId: string | number;
  pairFrom: string;
  pairTo: string;
}

export interface PairRef {
  pairName: string;
  base: string;
  quote: string;
  pairId: string | null;
}

/** Builder SDK display name -> canonical raw base. Extend as the live feed reveals more. */
const DISPLAY_TO_RAW: Record<string, string> = {
  WTI: 'CL',
  GOLD: 'XAU',
  SILVER: 'XAG',
};

/** Offline fallback (canonical names, no ids). Live getPairs() overrides this. */
export const DEFAULT_PAIRS: string[] = [
  'ADA/USD', 'BNB/USD', 'BTC/USD', 'ETH/USD', 'HYPE/USD', 'LINK/USD', 'SOL/USD', 'TRX/USD', 'XRP/USD',
  'BRENT/USD', 'CL/USD', 'HG/USD', 'XAG/USD', 'XAU/USD', 'XPD/USD', 'XPT/USD',
  'AUD/USD', 'EUR/USD', 'GBP/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY', 'USD/KRW', 'USD/MXN',
  'DAX/EUR', 'DJI/USD', 'FTSE/GBP', 'HSI/HKD', 'NDX/USD', 'NIK/JPY', 'SPX/USD',
  'AAPL/USD', 'AMD/USD', 'AMZN/USD', 'GOOG/USD', 'META/USD', 'MSFT/USD', 'MSTR/USD',
  'NVDA/USD', 'PLTR/USD', 'TSLA/USD', 'TSM/USD', 'COIN/USD',
  'HYG/USD', 'TLT/USD', 'UNG/USD', 'URA/USD', 'XLE/USD', 'REMX/USD',
];

/** Direct alias: normalized TV symbol -> canonical Ostium pair name. */
const ALIAS: Record<string, string> = {
  GOLD: 'XAU/USD', SILVER: 'XAG/USD', PLATINUM: 'XPT/USD', PALLADIUM: 'XPD/USD',
  USOIL: 'CL/USD', WTI: 'CL/USD', CL: 'CL/USD', CRUDEOIL: 'CL/USD',
  UKOIL: 'BRENT/USD', BRENT: 'BRENT/USD', NATGAS: 'UNG/USD',
  COPPER: 'HG/USD', HG: 'HG/USD',
  US500: 'SPX/USD', SPX500: 'SPX/USD', SPX: 'SPX/USD', SP500: 'SPX/USD',
  US100: 'NDX/USD', NAS100: 'NDX/USD', NDX: 'NDX/USD', NASDAQ100: 'NDX/USD',
  US30: 'DJI/USD', DJI: 'DJI/USD', DOW: 'DJI/USD',
  GER40: 'DAX/EUR', GER30: 'DAX/EUR', DAX: 'DAX/EUR', DE40: 'DAX/EUR',
  UK100: 'FTSE/GBP', FTSE: 'FTSE/GBP',
  JP225: 'NIK/JPY', NIK: 'NIK/JPY', NIKKEI: 'NIK/JPY',
  HK50: 'HSI/HKD', HSI: 'HSI/HKD',
};

const SUFFIXES = ['.P', 'PERP', '.1', '1!', '2!'];
const STABLES = ['USDT', 'USDC', 'USD'];

function normalize(ticker: string): string {
  let t = ticker.trim().toUpperCase();
  if (t.includes(':')) t = t.slice(t.indexOf(':') + 1);
  for (const suf of SUFFIXES) if (t.endsWith(suf)) t = t.slice(0, -suf.length);
  return t;
}

export class SymbolMapper {
  private index = new Map<string, string | null>(); // canonical pairName -> pairId
  private quotes = new Set<string>();

  constructor(pairs: Array<string | { pairName: string; pairId?: string | null }>) {
    for (const p of pairs) {
      const name = (typeof p === 'string' ? p : p.pairName).toUpperCase();
      const id = typeof p === 'string' ? null : (p.pairId ?? null);
      this.index.set(name, id);
      const parts = name.split('/');
      if (parts.length === 2) this.quotes.add(parts[1]!);
    }
  }

  static fromDefault(): SymbolMapper {
    return new SymbolMapper(DEFAULT_PAIRS);
  }

  static fromSdkPairs(pairs: SdkPairLike[]): SymbolMapper {
    return new SymbolMapper(
      pairs.map((p) => {
        const base = DISPLAY_TO_RAW[p.pairFrom.toUpperCase()] ?? p.pairFrom.toUpperCase();
        return { pairName: `${base}/${p.pairTo.toUpperCase()}`, pairId: String(p.pairId) };
      }),
    );
  }

  private candidates(norm: string): string[] {
    if (ALIAS[norm]) return [ALIAS[norm]!];

    if (norm.includes('/')) {
      const [base, q] = norm.split('/') as [string, string];
      const quote = q === 'USDT' || q === 'USDC' ? 'USD' : q;
      return [`${base}/${quote}`, `${quote}/${base}`];
    }

    const quoteCandidates = [...STABLES, ...[...this.quotes].sort((a, b) => b.length - a.length)];
    for (const q of quoteCandidates) {
      if (norm.endsWith(q) && norm.length > q.length) {
        const base = norm.slice(0, -q.length);
        const quote = q === 'USDT' || q === 'USDC' ? 'USD' : q;
        return [`${base}/${quote}`, `${quote}/${base}`];
      }
    }

    if (norm.length === 6 && /^[A-Z]{6}$/.test(norm)) {
      return [`${norm.slice(0, 3)}/${norm.slice(3)}`, `${norm.slice(3)}/${norm.slice(0, 3)}`];
    }

    return [`${norm}/USD`];
  }

  resolve(ticker: string): PairRef | null {
    const norm = normalize(ticker);
    for (const cand of this.candidates(norm)) {
      const cu = cand.toUpperCase();
      if (this.index.has(cu)) {
        const [base, quote] = cu.split('/') as [string, string];
        return { pairName: cu, base, quote, pairId: this.index.get(cu) ?? null };
      }
    }
    return null;
  }
}
