// Create a dedicated TESTNET-ONLY wallet for funding the proof.
//
// Written OUTSIDE the repo (no source control can ever sweep it in) and the
// private key is printed ONCE, deliberately, so the human can back it up
// before funding it. This is worthless testnet key material.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DIR = join(homedir(), 'Documents', 'rh-testnet-wallet');
const FILE = join(DIR, 'testnet-deployer.json');

mkdirSync(DIR, { recursive: true });
if (existsSync(FILE)) {
  console.log('A testnet wallet already exists at:');
  console.log('  ' + FILE);
  process.exit(0);
}

const pk = generatePrivateKey();
const acct = privateKeyToAccount(pk);

const record = {
  WARNING: 'TESTNET ONLY (Robinhood Chain 46630). This key is worthless. NEVER send it mainnet ETH, never use it on a mainnet dApp, never reuse it.',
  purpose: 'Funder for goodsmash-holder-kit test/testnet-proof.mjs',
  chainId: 46630,
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  explorer: 'https://explorer.testnet.chain.robinhood.com',
  address: acct.address,
  privateKey: pk,
  createdAt: new Date().toISOString(),
};
writeFileSync(FILE, JSON.stringify(record, null, 2));

console.log('created  : ' + FILE);
console.log('');
console.log('ADDRESS (fund this)      ' + acct.address);
console.log('PRIVATE KEY (back this up now, shown once)');
console.log('  ' + pk);
console.log('');
console.log('To use it for the proof:');
console.log('  export ROBINHOOD_TESTNET_DEPLOYER_KEY=' + pk);
console.log('  npm run test:testnet');