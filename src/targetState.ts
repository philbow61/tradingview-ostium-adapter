/** Target-state resolution (DESIGN §5): (current on-chain, target sentiment) -> {close, open}. */
import type { Sentiment } from './schema';

export interface Ops {
  close: boolean;
  open: boolean;
}

export function resolveOps(current: 'long' | 'short' | 'flat', target: Sentiment): Ops {
  if (current === target) return { close: false, open: false }; // no-op / scale (MVP: no-op)
  if (target === 'flat') return { close: true, open: false };
  if (current === 'flat') return { close: false, open: true };
  return { close: true, open: true }; // flip
}
