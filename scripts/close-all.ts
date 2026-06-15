/**
 * One-off cleanup: close ALL open positions and cancel ALL open limit/stop orders for TRADER_ADDRESS,
 * signed by the DELEGATE key (gasless — the trader key is NOT needed for closes/cancels).
 * Keys are loaded from .env by dotenv; this never prints them. Re-run to confirm an empty account.
 *
 *   npm run close-all
 *
 * ⚠️ Stop the adapter first — two clients on one delegate Safe can race the ERC-4337 nonce.
 */
import 'dotenv/config';
import { OstiumClient, CancelOrderType } from '@ostium/builder-sdk';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const TRADER = process.env.TRADER_ADDRESS as `0x${string}` | undefined;
const DK = process.env.DELEGATE_PRIVATE_KEY as `0x${string}` | undefined;

async function main() {
  if (!DK || !TRADER) throw new Error('DELEGATE_PRIVATE_KEY / TRADER_ADDRESS missing in .env');
  const c = await OstiumClient.createDelegatedAndGasless({
    delegatePrivateKey: DK,
    traderAddress: TRADER,
    testnet: NETWORK === 'testnet',
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });
  console.log(`trader ${TRADER} · delegate Safe ${c.getSmartAccountAddress()} · ${NETWORK}`);

  const { pairs } = await c.getPairs();
  const midById = new Map(pairs.map((p) => [String(p.pairId), p.midPx]));

  // 1) close every open position
  const { pairPositions } = await c.getOpenPositions({ user: TRADER });
  console.log(`\nopen positions: ${pairPositions.length}`);
  let closed = 0;
  for (const { position: p } of pairPositions) {
    const price = String(midById.get(String(p.pairId)) ?? p.entryPx);
    try {
      const r = await c.closeTrade({ pairId: p.pairId, idx: p.idx, price, closePercent: 100, slippage: 300 });
      console.log(`  ✓ close ${p.pairFrom}/${p.pairTo} idx ${p.idx} ${p.side} → ${r.txHash}`);
      closed++;
    } catch (e) {
      console.error(`  ✗ close ${p.pairFrom}/${p.pairTo} idx ${p.idx}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2) cancel every resting limit/stop order
  const openOrders = await c.getOpenOrders({ user: TRADER });
  console.log(`\nopen limit/stop orders: ${openOrders.length}`);
  let cancelled = 0;
  for (const o of openOrders) {
    try {
      const r = await c.cancelOrder({ type: CancelOrderType.Limit, pairId: o.pairId, idx: o.idx });
      console.log(`  ✓ cancel ${o.orderType} ${o.pairFrom}/${o.pairTo} idx ${o.idx} → ${r.txHash}`);
      cancelled++;
    } catch (e) {
      console.error(`  ✗ cancel ${o.pairFrom}/${o.pairTo} idx ${o.idx}:`, e instanceof Error ? e.message : e);
    }
  }

  // 3) report pending market orders (they settle on their own → re-run to close any resulting position)
  const pending = await c.getOrders({ user: TRADER, isPending: true });
  console.log(`\npending market orders: ${pending.length}${pending.length ? ' (settle shortly → re-run)' : ''}`);

  console.log(`\nsubmitted ${closed} close(s) + ${cancelled} cancel(s). They settle via the keeper — re-run in ~30s to confirm 0 / 0.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
