/**
 * SignalV1 — the webhook payload TradingView POSTs (see docs/TRADINGVIEW.md).
 * TradingView substitutes placeholders as strings, so numeric fields coerce from string.
 * We act on `sentiment` (target state), never on `tvContracts`.
 */
import { z } from 'zod';

export const Sentiment = z.enum(['long', 'short', 'flat']);
export type Sentiment = z.infer<typeof Sentiment>;

export const SizingMode = z.enum(['fixed_notional', 'percent_of_equity', 'risk_percent']);
export type SizingMode = z.infer<typeof SizingMode>;

const OrderTypeZ = z.enum(['market', 'limit']);

/** TradingView may send booleans as the literal `false`/`true` or as strings. */
const zBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const Bracket = z.object({
  type: z.enum(['percent', 'price']).default('percent'),
  value: z.coerce.number(),
});
export type Bracket = z.infer<typeof Bracket>;

export const SignalV1 = z
  .object({
    secret: z.string().min(1),
    strategy_id: z.string().min(1),
    schema: z.string().default('ostium-adapter/v1'),

    sentiment: Sentiment,
    prev_sentiment: Sentiment.optional(),
    action: z.enum(['buy', 'sell']).optional(),

    ticker: z.string().min(1),
    exchange: z.string().optional(),

    order_type: OrderTypeZ.default('market'),
    limit_price: z.coerce.number().optional(),

    sizing: z.object({ mode: SizingMode, value: z.coerce.number() }).optional(),
    leverage: z.coerce.number().optional(),

    take_profit: Bracket.optional(),
    stop_loss: Bracket.optional(),

    signal_price: z.coerce.number().optional(),
    tv_contracts: z.coerce.number().optional(), // AUDIT ONLY — never used for sizing
    tv_position_size: z.coerce.number().optional(),

    order_id: z.string().optional(),
    bar_time: z.string().optional(), // only used in the dedup key
    fired_at: z.coerce.date().optional(),
    nonce: z.string().min(1),

    dry_run: zBool.default(false),
    max_lag_sec: z.coerce.number().int().default(60),
  })
  .passthrough();

export type SignalV1 = z.infer<typeof SignalV1>;

export function dedupKeyMaterial(s: SignalV1): string {
  return `${s.strategy_id}|${s.ticker}|${s.action ?? ''}|${s.bar_time ?? ''}|${s.nonce}`;
}

export function lagSeconds(s: SignalV1, now = new Date()): number | null {
  if (!s.fired_at) return null;
  return (now.getTime() - s.fired_at.getTime()) / 1000;
}
