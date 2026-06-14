/**
 * Print the addresses derived from DELEGATE_PRIVATE_KEY (+ trader/network from .env).
 * You do NOT need a public key in .env — the SDK derives everything from the private key.
 * Use this only to CONFIRM the key matches the delegate Ostium registered.
 *
 *   npm run delegate-info
 *
 * Never prints the private key.
 */
import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { OstiumClient } from '@ostium/builder-sdk';

const NETWORK = (process.env.OSTIUM_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const TRADING = NETWORK === 'mainnet'
  ? '0x6D0bA1f9996DBD8885827e1b2e8f6593e7702411'
  : '0x2A9B9c988393f46a2537B0ff11E98c2C15a95afe';
const DELEGATIONS_ABI = [{
  name: 'delegations', type: 'function', stateMutability: 'view',
  inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }],
}] as const;

async function main() {
  const dk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}` | undefined;
  const trader = process.env.TRADER_ADDRESS as `0x${string}` | undefined;
  if (!dk) throw new Error('DELEGATE_PRIVATE_KEY missing in .env');

  // Delegate EOA address — derived locally from the private key (no network).
  const delegateEoa = privateKeyToAccount(dk).address;
  console.log(`Delegate EOA address : ${delegateEoa}`);
  console.log(`Trader address       : ${trader ?? '(TRADER_ADDRESS not set)'}`);
  console.log(`Network              : ${NETWORK}`);

  // Safe smart-account address — what the trader must have setDelegate()'d to.
  const client = await OstiumClient.createDelegatedAndGasless({
    delegatePrivateKey: dk,
    traderAddress: (trader ?? delegateEoa) as `0x${string}`,
    testnet: NETWORK === 'testnet',
    ...(process.env.PIMLICO_URL ? { pimlicoUrl: process.env.PIMLICO_URL } : {}),
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const safe = client.getSmartAccountAddress();
  console.log(`Delegate Safe (smart account): ${safe ?? '(undefined)'}`);

  // Read the trader's CURRENT on-chain delegate and compare to our Safe.
  if (trader && safe) {
    const pub = createPublicClient({ chain: NETWORK === 'mainnet' ? arbitrum : arbitrumSepolia, transport: http(process.env.RPC_URL) });
    const current = (await pub.readContract({ address: TRADING as `0x${string}`, abi: DELEGATIONS_ABI, functionName: 'delegations', args: [trader] })) as string;
    const ok = current.toLowerCase() === safe.toLowerCase();
    console.log(`On-chain delegate for trader : ${current}`);
    console.log(ok
      ? '\n✅ ADAPTER AUTHORIZED — our delegate is registered. Live trading will work.'
      : "\n❌ NOT AUTHORIZED — the trader's delegate is someone else (e.g. the Ostium UI relayer).\n   Run `npm run register-delegate` (needs TRADER_PRIVATE_KEY in .env) to re-point it to us.");
  } else {
    console.log('(set TRADER_ADDRESS in .env to check the on-chain delegate)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
