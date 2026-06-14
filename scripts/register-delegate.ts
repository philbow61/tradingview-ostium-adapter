/**
 * One-time: register OUR adapter's delegate Safe on your trader wallet, so the adapter can
 * trade on your behalf (gasless). This is a TRADER-signed on-chain call (setDelegate), so it
 * needs your wallet key.
 *
 * ⚠️ Add TRADER_PRIVATE_KEY (your 0x0963 wallet key) to .env JUST for this step. Testnet only.
 * ⚠️ This re-points the SINGLE delegate slot to our Safe — it will OVERRIDE the Ostium UI's
 *    gasless relayer on this wallet (see D-013). For a clean setup, use a dedicated wallet.
 *
 *   npm run register-delegate
 */
import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { OstiumClient } from '@ostium/builder-sdk';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

async function main() {
  const traderKey = process.env.TRADER_PRIVATE_KEY as `0x${string}` | undefined;
  const delegateKey = process.env.DELEGATE_PRIVATE_KEY as `0x${string}` | undefined;
  const rpcUrl = process.env.RPC_URL;
  if (!traderKey) throw new Error('Add TRADER_PRIVATE_KEY (your wallet key) to .env for this one-time setDelegate.');
  if (!delegateKey) throw new Error('DELEGATE_PRIVATE_KEY missing in .env.');
  if (!rpcUrl) throw new Error('RPC_URL missing in .env (Arbitrum Sepolia for testnet).');

  const traderAddr = privateKeyToAccount(traderKey).address;

  // Derive OUR delegate Safe from the delegate key (the address to register).
  const del = await OstiumClient.createDelegatedAndGasless({
    delegatePrivateKey: delegateKey, traderAddress: traderAddr, testnet: NETWORK === 'testnet', rpcUrl,
  });
  const safe = del.getSmartAccountAddress();
  if (!safe) throw new Error('could not derive delegate Safe address');
  console.log(`trader            : ${traderAddr}`);
  console.log(`registering delegate Safe: ${safe}`);

  // Trader signs setDelegate(safe) directly (self-self, pays a little gas).
  const trader = await OstiumClient.createSelfAndSelf({ traderPrivateKey: traderKey, rpcUrl, testnet: NETWORK === 'testnet' });
  const res = await trader.setDelegate(safe);
  console.log(`[ok] setDelegate submitted txHash=${res.txHash}`);
  console.log('Now the adapter (DELEGATE_PRIVATE_KEY) can trade for this wallet. Remove TRADER_PRIVATE_KEY from .env again.');
}

main().catch((e) => { console.error(e); process.exit(1); });
