/** Read current positions/orders for the trader; close any open BTC position (cleanup). */
import 'dotenv/config';
import { OstiumExecutor } from '../src/ostium';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

async function main() {
  const exec = await OstiumExecutor.create({
    network: NETWORK,
    delegatePrivateKey: process.env.DELEGATE_PRIVATE_KEY as `0x${string}`,
    traderAddress: process.env.TRADER_ADDRESS as `0x${string}`,
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const positions = await exec.positions();
  console.log(`open positions: ${positions.length}`);
  for (const p of positions) {
    console.log(`  pairId=${p.pairId} ${p.pairFrom}/${p.pairTo} side=${p.side} idx=${p.idx} szi=${p.szi}`);
  }

  const btc = positions.find((p) => String(p.pairId) === '0');
  if (btc) {
    const mid = Number((await exec.pairById('0'))!.midPx);
    console.log(`[step] closing BTC position idx=${btc.idx} @ ~${mid} ...`);
    const res = await exec.close({ pairId: '0', idx: btc.idx, price: mid, slippageBps: 100 });
    console.log(`[ok] close submitted txHash=${res.txHash}`);
  } else {
    console.log('[info] no open BTC position (still pending oracle settlement, or already closed)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
