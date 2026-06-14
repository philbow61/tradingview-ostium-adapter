/** Inspect the lifecycle of the order initiated by a given tx hash. Read-only. */
import 'dotenv/config';
import { OstiumClient } from '@ostium/builder-sdk';

const TX = (process.argv[2] ?? process.env.SMOKE_TX) as `0x${string}`;
const TRADER = process.env.TRADER_ADDRESS as `0x${string}`;

async function main() {
  const client = await OstiumClient.createReadOnly({ testnet: (process.env.OSTIUM_NETWORK ?? 'testnet') === 'testnet' });

  const bal = await client.getBalances(TRADER);
  console.log(`balance: ${bal.usdc} USDC`);

  if (TX) {
    const orders = await client.getOrders({ initiatedTxHashes: [TX], user: TRADER });
    console.log(`orders for ${TX}: ${orders.length}`);
    for (const o of orders) console.log(JSON.stringify(o, null, 1));
  }

  const recent = await client.getOrders({ user: TRADER, pairIds: [0] });
  console.log(`recent BTC orders: ${recent.length}`);
  for (const o of recent.slice(0, 5)) {
    console.log(`  action=${(o as any).orderAction} pending=${o.isPending} cancelled=${o.isCancelled} reason=${o.cancelReason ?? '-'} tx=${o.initiatedTx?.slice(0, 12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
