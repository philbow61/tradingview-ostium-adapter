/**
 * Live testnet smoke (T-012/T-013): open + close a tiny BTC position via the Builder SDK's
 * delegated + gasless path (BTC trades 24/7). Proves the unblocked execution path end-to-end.
 * Needs DELEGATE_PRIVATE_KEY + TRADER_ADDRESS in .env. Gasless — no ETH required.
 *
 *   npm run smoke
 */
import 'dotenv/config';
import { OstiumExecutor } from '../src/ostium';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`;
  const trader = process.env.TRADER_ADDRESS as `0x${string}`;
  if (!dk || !trader) throw new Error('set DELEGATE_PRIVATE_KEY and TRADER_ADDRESS in .env');

  const exec = await OstiumExecutor.create({
    network: NETWORK,
    delegatePrivateKey: dk,
    traderAddress: trader,
    ...(process.env.PIMLICO_URL ? { pimlicoUrl: process.env.PIMLICO_URL } : {}),
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const btc = (await exec.pairs()).find((p) => p.pairFrom.toUpperCase() === 'BTC');
  if (!btc) throw new Error('BTC pair not found');
  console.log(`[info] BTC id=${btc.pairId} mid=${btc.midPx} open=${btc.isMarketOpen}`);
  if (!btc.isMarketOpen) return console.log('[abort] BTC market closed');

  const pairId = String(btc.pairId);
  console.log(`[info] balance ${await exec.usdcBalance()} USDC; positions ${(await exec.positions()).length}`);

  console.log('[step] OPEN flat->long 100 USD @ 10x ...');
  const open = await exec.openMarket({
    pairId, isLong: true, collateral: 10, leverage: 10, price: Number(btc.midPx), slippageBps: 100,
  });
  console.log(`[ok] open submitted txHash=${open.txHash} smartAccount=${open.smartAccountAddress ?? '-'}`);

  console.log('[step] waiting for oracle settlement (PENDING -> position | cancelled) ...');
  let pos = exec.positionFor(await exec.positions(), pairId);
  let oid: number | undefined;
  for (let i = 0; i < 45 && pos.state === 'flat'; i++) {
    const [order] = await exec.ordersByTx(open.txHash);
    oid = Number((order as any)?.oid ?? (order as any)?.pid) || oid;
    if (order?.isCancelled) {
      return console.log(`[warn] open was cancelled by the venue: ${order.cancelReason ?? 'unknown'}`);
    }
    await sleep(2000);
    pos = exec.positionFor(await exec.positions(), pairId);
  }

  if (pos.state === 'flat') {
    // Never settled within the market-order timeout — reclaim the locked collateral.
    console.log('[warn] not settled after ~90s (testnet oracle keeper). Reclaiming collateral ...');
    if (oid) {
      const c = await exec.cancelPendingOpen(oid);
      console.log(`[ok] cancel pending open submitted txHash=${c.txHash} (orderId=${oid})`);
    } else {
      console.log('[warn] could not resolve orderId to cancel; check manually');
    }
    return;
  }

  console.log(`[ok] OPEN settled: state=${pos.state} idx=${pos.idx}`);
  console.log('[step] CLOSE long->flat ...');
  const close = await exec.close({ pairId, idx: pos.idx!, price: Number((await exec.pairById(pairId))!.midPx), slippageBps: 100 });
  console.log(`[ok] close submitted txHash=${close.txHash}`);

  for (let i = 0; i < 40; i++) {
    if (exec.positionFor(await exec.positions(), pairId).state === 'flat') {
      return console.log('[ok] CLOSE settled. Round trip complete.');
    }
    await sleep(2000);
  }
  console.log('[warn] still open after ~80s; close may still be settling');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
