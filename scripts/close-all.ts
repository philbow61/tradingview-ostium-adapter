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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 2500); // space out gasless submits — the sponsor rate-limits bursts

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
    await sleep(THROTTLE_MS);
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

  // 3) clear pending market orders: reclaim pending OPENS, and cancel pending CLOSES whose pair no
  //    longer has an open position (orphaned/redundant close attempts the keeper left dangling).
  const pending = await c.getOrders({ user: TRADER, isPending: true, limit: 1000 });
  const openPairIds = new Set((await c.getOpenPositions({ user: TRADER })).pairPositions.map((pp) => String(pp.position.pairId)));
  console.log(`\npending market orders: ${pending.length}`);
  let reclaimed = 0;
  for (const o of pending) {
    const orderId = Number(o.oid);
    if (!Number.isFinite(orderId)) {
      console.error(`  ✗ ${o.pairFrom}/${o.pairTo} ${o.action}: non-numeric oid ${o.oid}`);
      continue;
    }
    try {
      if (o.action === 'Open') {
        await c.cancelOrder({ type: CancelOrderType.PendingOpen, orderId });
        console.log(`  ✓ reclaim pending OPEN ${o.pairFrom}/${o.pairTo} order ${orderId}`);
        reclaimed++;
      } else if (o.action === 'Close' && !openPairIds.has(String(o.pairId))) {
        await c.cancelOrder({ type: CancelOrderType.PendingClose, orderId }); // retry defaults false → just clear it
        console.log(`  ✓ clear orphaned CLOSE ${o.pairFrom}/${o.pairTo} order ${orderId}`);
        reclaimed++;
      } else {
        console.log(`  – skip pending ${o.action} ${o.pairFrom}/${o.pairTo} order ${orderId} (pair still has a position)`);
      }
    } catch (e) {
      console.error(`  ✗ cancel pending ${o.action} order ${orderId}:`, e instanceof Error ? e.message : e);
    }
    await sleep(THROTTLE_MS);
  }

  console.log(`\nsubmitted ${closed} close(s) + ${cancelled} order-cancel(s) + ${reclaimed} pending-cancel(s). Re-run in ~30s to confirm 0 / 0 / 0.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
