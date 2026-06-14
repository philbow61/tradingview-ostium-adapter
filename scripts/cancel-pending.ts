/** Cancel a timed-out pending market OPEN to reclaim its collateral. Usage: tsx scripts/cancel-pending.ts <orderId> */
import 'dotenv/config';
import { OstiumClient, CancelOrderType } from '@ostium/builder-sdk';

const orderId = Number(process.argv[2]);

async function main() {
  if (!orderId) throw new Error('pass an orderId, e.g. tsx scripts/cancel-pending.ts 144093');
  const client = await OstiumClient.createDelegatedAndGasless({
    delegatePrivateKey: process.env.DELEGATE_PRIVATE_KEY as `0x${string}`,
    traderAddress: process.env.TRADER_ADDRESS as `0x${string}`,
    testnet: (process.env.OSTIUM_NETWORK ?? 'testnet') === 'testnet',
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const before = (await client.getBalances(process.env.TRADER_ADDRESS as `0x${string}`)).usdc;
  console.log(`balance before: ${before} USDC`);
  console.log(`[step] cancelling pending OPEN orderId=${orderId} ...`);
  const res = await client.cancelOrder({ type: CancelOrderType.PendingOpen, orderId });
  console.log(`[ok] cancel submitted txHash=${res.txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
