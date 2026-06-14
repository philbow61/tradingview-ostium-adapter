/**
 * Read-only probe (T-003 TS): confirms Builder SDK reads work and caches data/pairs.json
 * (the live pair list, used by the symbol mapper). No key needed.
 *
 *   npm run probe
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OstiumClient } from '@ostium/builder-sdk';

const NETWORK = process.env.OSTIUM_NETWORK ?? 'testnet';
const TRADER = process.env.TRADER_ADDRESS as `0x${string}` | undefined;

async function main() {
  mkdirSync('data', { recursive: true });
  const client = await OstiumClient.createReadOnly({ testnet: NETWORK === 'testnet' });

  const { pairs } = await client.getPairs();
  console.log(`[ok] ${pairs.length} pairs (${NETWORK})`);
  writeFileSync('data/pairs.json', JSON.stringify(pairs, null, 2));
  console.log('[ok] wrote data/pairs.json');

  for (const want of ['BTC', 'XAU', 'CL', 'ETH']) {
    const p = pairs.find((x) => x.pairFrom.toUpperCase() === want || x.pairFrom.toUpperCase() === { CL: 'WTI' }[want]);
    if (p)
      console.log(
        `     ${p.pairFrom}/${p.pairTo} id=${p.pairId} mid=${p.midPx} open=${p.isMarketOpen} maxLev=${p.maxLeverage} minNtl=${p.minNtl}`,
      );
  }

  if (TRADER) {
    const bal = await client.getBalances(TRADER);
    console.log(`[ok] trader ${TRADER} balance: ${bal.usdc} USDC, ${bal.eth} ETH, allowance ${bal.allowance}`);
    const pos = await client.getOpenPositions({ user: TRADER });
    console.log(`[ok] open positions: ${pos.pairPositions.length}`);
  } else {
    console.log('[info] set TRADER_ADDRESS in .env to also print balance/positions');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
