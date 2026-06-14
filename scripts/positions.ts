/** Read-only: print the trader's open positions + open limit orders. Does NOT trade. */
import 'dotenv/config';
import { OstiumClient } from '@ostium/builder-sdk';

const TRADER = (process.argv[2] ?? process.env.TRADER_ADDRESS) as `0x${string}`;

async function main() {
  const c = await OstiumClient.createReadOnly({ testnet: (process.env.OSTIUM_NETWORK ?? 'testnet') === 'testnet' });
  const bal = await c.getBalances(TRADER);
  console.log(`trader ${TRADER}  balance ${bal.usdc} USDC`);

  const { pairPositions, marginSummary } = await c.getOpenPositions({ user: TRADER });
  console.log(`open positions: ${pairPositions.length}  accountValue=${marginSummary?.accountValue}`);
  for (const { position: p } of pairPositions) {
    console.log(JSON.stringify(p, null, 1));
  }

  const orders = await c.getOpenOrders({ user: TRADER });
  console.log(`open limit orders: ${orders.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
