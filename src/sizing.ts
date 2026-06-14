/**
 * Position sizing: TradingView intent -> Ostium collateral + leverage (DESIGN §7).
 * NEVER size from {{strategy.order.contracts}}. Size from a chosen mode vs LIVE on-chain equity.
 */
import type { Bracket, SizingMode } from './schema';

export class SizingError extends Error {}

export interface PairLimits {
  minNotional: number; // pair.minNtl (USD), Builder SDK: currently "5.0"
  minLeverage: number;
  maxLeverage: number;
  minCollateral: number; // platform floor fallback
}

export interface SizeResult {
  collateral: number;
  leverage: number;
  notional: number;
}

export function computeNotional(
  mode: SizingMode,
  value: number,
  equity: number,
  price: number,
  leverage: number,
  stopLossPrice?: number,
): number {
  if (mode === 'fixed_notional') return value;
  if (mode === 'percent_of_equity') return (equity * value) / 100 * leverage;
  if (mode === 'risk_percent') {
    if (!stopLossPrice || !price) throw new SizingError('risk_percent sizing requires a stop_loss price');
    const riskFrac = Math.abs(price - stopLossPrice) / price;
    if (riskFrac <= 0) throw new SizingError('stop_loss too close to price (zero risk distance)');
    return (equity * value) / 100 / riskFrac;
  }
  throw new SizingError(`unknown sizing mode: ${mode}`);
}

export function sizePosition(args: {
  mode: SizingMode;
  value: number;
  equity: number;
  price: number;
  leverage: number;
  limits: PairLimits;
  configMaxLeverage: number;
  maxPositionNotional: number;
  stopLossPrice?: number;
}): SizeResult {
  const { mode, value, equity, price, limits, configMaxLeverage, maxPositionNotional, stopLossPrice } = args;
  const lev = Math.max(limits.minLeverage, Math.min(args.leverage, limits.maxLeverage, configMaxLeverage));

  const notional = computeNotional(mode, value, equity, price, lev, stopLossPrice);
  if (notional <= 0) throw new SizingError('computed notional <= 0');
  if (notional > maxPositionNotional)
    throw new SizingError(`notional ${notional.toFixed(2)} exceeds max ${maxPositionNotional.toFixed(2)}`);

  const minNotional = Math.max(limits.minNotional, limits.minCollateral * lev);
  if (notional < minNotional)
    throw new SizingError(`notional ${notional.toFixed(2)} below pair minimum ${minNotional.toFixed(2)}`);

  const collateral = notional / lev;
  const floor = Math.max(limits.minCollateral, limits.minNotional / lev);
  if (collateral < floor) throw new SizingError(`collateral ${collateral.toFixed(2)} below minimum ${floor.toFixed(2)}`);

  return {
    collateral: round6(collateral),
    leverage: lev,
    notional: round6(notional),
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Convert a {type, value} bracket to an absolute trigger price. side = 'long' | 'short'. */
export function bracketToPrice(
  side: 'long' | 'short' | 'flat',
  refPrice: number,
  bracket: Bracket | undefined,
  isTakeProfit: boolean,
): number | undefined {
  if (!bracket) return undefined;
  if (bracket.type === 'price') return bracket.value;
  const pct = bracket.value / 100;
  const up = (side === 'long') === isTakeProfit; // long TP & short SL are above; else below
  return up ? refPrice * (1 + pct) : refPrice * (1 - pct);
}
