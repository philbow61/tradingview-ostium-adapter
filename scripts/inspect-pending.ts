/** Read-only: list the trader's pending orders so we know what to reclaim. No key needed. */
import 'dotenv/config';
import { OstiumClient } from '@ostium/builder-sdk';

const TRADER = (process.argv[2] ?? process.env.TRADER_ADDRESS) as `0x${string}`;

async function main() {
  const c = await OstiumClient.createReadOnly({
    testnet: (process.env.OSTIUM_NETWORK ?? 'testnet') === 'testnet',
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });
  const pending = await c.getOrders({ user: TRADER, isPending: true, limit: 1000 });
  const byAction: Record<string, number> = {};
  for (const o of pending) byAction[o.action] = (byAction[o.action] ?? 0) + 1;
  console.log(`pending: ${pending.length}  byAction:`, byAction);
  for (const o of pending.slice(0, 6)) {
    console.log(
      JSON.stringify({ pair: `${o.pairFrom}/${o.pairTo}`, action: o.action, oid: o.oid, pid: o.pid, initiatedTime: o.initiatedTime, isCancelled: o.isCancelled }),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
