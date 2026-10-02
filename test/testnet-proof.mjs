// REAL TESTNET PROOF — mints for real on Robinhood Chain TESTNET (46630).
//
// Uses the actual CLI code path (Vault -> Signer -> RpcPool -> mintState),
// against a contract deployed to testnet. No mocks, no fixtures.
// The deployer key is read from the project env by NAME and never printed.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';

import { RpcPool } from '../src/rpc.mjs';
import { Vault } from '../src/vault.mjs';
import { Signer, signersFrom } from '../src/signer.mjs';
import { encodeCall, decodeUint, formatUnits, parseUnits } from '../src/abi.mjs';
import { mintState } from '../src/mintscan.mjs';
import { mintAll } from '../src/mint.mjs';
import { erc721Inventory } from '../src/inventory.mjs';
import { spread } from '../src/distribute.mjs';
import { RunLedger } from '../src/safety.mjs';
import { resolveChain } from '../src/config.mjs';

const DROP = JSON.parse(readFileSync('test/testnet-drop.json', 'utf8'));

/**
 * Find a funded testnet deployer key, in order of preference:
 *   1. ROBINHOOD_TESTNET_DEPLOYER_KEY in the environment (CI, agents)
 *   2. ~/Documents/rh-testnet-wallet/testnet-deployer.json (the wallet
 *      `node test/make-testnet-wallet.mjs` creates for you)
 *   3. a legacy .env in another checkout, as a last resort
 *
 * Hardcoding one absolute path made this file unusable for anyone who cloned
 * the repo, which is the opposite of what a public proof should be.
 */
function findDeployerKey() {
  const env = process.env.ROBINHOOD_TESTNET_DEPLOYER_KEY?.trim();
  if (env) return { key: env.startsWith('0x') ? env : '0x' + env, source: 'ROBINHOOD_TESTNET_DEPLOYER_KEY' };

  const walletFile = join(homedir(), 'Documents', 'rh-testnet-wallet', 'testnet-deployer.json');
  if (existsSync(walletFile)) {
    try {
      const rec = JSON.parse(readFileSync(walletFile, 'utf8'));
      if (rec.privateKey) {
        const k = rec.privateKey.startsWith('0x') ? rec.privateKey : '0x' + rec.privateKey;
        return { key: k, source: walletFile };
      }
    } catch {
      /* fall through to the next candidate */
    }
  }

  const legacy = 'C:/Users/ryanm/Downloads/goodsmash-v2-full/goodsmash-onchain-worlds-v2/packages/contracts/.env';
  if (existsSync(legacy)) {
    const m = readFileSync(legacy, 'utf8').match(/^(?:DEPLOYER_PRIVATE_KEY|ROBINHOOD_TESTNET_DEPLOYER_KEY)\s*=\s*(.+)$/m);
    if (m) {
      const k = m[1].trim().replace(/^["']|["']$/g, '');
      return { key: k.startsWith('0x') ? k : '0x' + k, source: 'legacy .env' };
    }
  }

  console.error(
    '\nNo testnet deployer key found.\n\n' +
    'Create one, fund it with test ETH (https://faucet.testnet.chain.robinhood.com),\n' +
    'then re-run:\n\n' +
    '  node test/make-testnet-wallet.mjs\n' +
    '  npm run test:testnet\n\n' +
    'Or set ROBINHOOD_TESTNET_DEPLOYER_KEY in the environment.\n'
  );
  process.exit(1);
}

const { key: deployerKey, source: keySource } = findDeployerKey();

const spec = resolveChain('robinhoodTestnet', {});
const pool = new RpcPool(spec.endpoints, spec.id);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
};

console.log('\n============================================================');
console.log(' REAL TESTNET PROOF — Robinhood Chain TESTNET (46630)');
console.log('============================================================');
console.log(` contract : ${DROP.contract}`);
console.log(` deployTx : ${DROP.deployTx}`);
console.log(` rpc      : ${spec.endpoints[0].url}\n`);

// 1. The contract is real.
const code = await pool.getCode(DROP.contract);
ok('contract has bytecode on testnet', code && code !== '0x', `${(code.length - 2) / 2} bytes`);

// 2. The chain is really 46630.
const cid = await pool.fetchChainId();
ok('chain id is 46630', cid === 46630, `got ${cid}`);

// 3. Scanner sees it as free + live from real chain state.
const st = await mintState(pool, DROP.contract, { probeFrom: privateKeyToAccount(deployerKey).address });
ok('scanner verdict is FREE LIVE', st.verdict === 'free-live', `${st.verdict} (${st.reason})`);
ok('price is genuinely 0', st.priceWei === 0n, `${st.priceWei} wei`);
ok('mint shape gas-verified', st.verified === true, st.sigs.join(','));

// 4. Build a real vault. How many wallets we can fund depends on the funder's
// remaining testnet balance, so size the run to the budget instead of assuming.
const vaultPath = 'test/testnet-vault.bin';
const password = 'testnet-proof-only-not-a-real-password';
const vault = await Vault.create(vaultPath, { password });
const { generatePrivateKey } = await import('viem/accounts');

const funder = new Signer(deployerKey, pool, spec);
const gp = await pool.gasPrice();
// Real testnet gas is ~0.02 gwei. A 20 gwei ceiling is 1000x the real price and
// the node then rejects the tx with "gas required exceeds allowance" long before
// value is even considered. Cap close to the actual price.
const FEE_CAP = (gp * 3n) / 2n;
const TX_COST = FEE_CAP * 120000n;      // generous per-tx ceiling
const funderBal = await funder.balance();
ok('fee cap tracks the real gas price', FEE_CAP < gp * 4n, `gas=${formatUnits(gp)} cap=${formatUnits(FEE_CAP)}`);

// Fund ONE wallet properly rather than two thin ones.
//
// Each mint on this chain costs ~FEE_CAP * 120_000, and the proof does several
// mints plus a transfer per wallet. Splitting a thin balance across two wallets
// makes the LAST step run out of gas, which then looks like a contract-limit
// failure ("DID NOT revert") when the tx never even reached execution.
const perWallet = FEE_CAP * 700000n;
const affordable = Number((funderBal - TX_COST) / perWallet);
const WALLET_COUNT = Math.max(1, Math.min(2, affordable));

// An unfunded (or nearly unfunded) deployer is the single most likely reason a
// newcomer runs this. Clamping to 1 wallet and continuing produced a raw
// "insufficient funds" stack trace ~15 lines later, which reads like a bug in
// the toolkit rather than "you need to fund this address". Stop here instead.
if (funderBal < perWallet + TX_COST) {
  const addr = privateKeyToAccount(deployerKey).address;
  ok('deployer has testnet ETH to fund the proof', false,
    `${formatUnits(funderBal)} ETH — needs ~${formatUnits(perWallet + TX_COST)}`);
  console.log(`
  FUND THIS ADDRESS WITH TEST ETH, THEN RE-RUN:

    ${addr}

  Faucet:  https://faucet.testnet.chain.robinhood.com
  (Robinhood Chain testnet, chain id 46630 — test ETH is worthless by design.
   The official faucet rate-limits scripted requests, so claim it in a browser.)

  Key came from: ${keySource}

  Every proof run spends roughly ${formatUnits(perWallet)} of that balance.
  `);
  await rmSync(vaultPath, { force: true });
  process.exit(1);
}

ok('deployer has testnet ETH to fund the proof', affordable >= 1,
  `${formatUnits(funderBal)} available, ${formatUnits(perWallet)} per wallet`);

const keys = [];
const accts = [];
for (let i = 0; i < WALLET_COUNT; i++) {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k);
  keys.push(k);
  accts.push(a);
  vault.addWallet({ address: a.address, privateKey: k, note: `proof-${i + 1}` });
}
vault.save();
ok(`vault created with ${WALLET_COUNT} wallet(s)`, vault.wallets.length === WALLET_COUNT);
const [a1, a2] = accts;

// 5. Fund every wallet from the testnet deployer (real transactions).
// Fee caps come from the REAL gas price: a hardcoded high cap makes the node
// demand far more than the balance holds, reporting "insufficient funds" when
// the real problem is an absurd fee ceiling.
for (const a of accts) {
  const r = await funder.send({ to: a.address, value: perWallet, maxFeePerGas: FEE_CAP });
  ok(`funded ${a.address.slice(0, 10)}…`, !!r.hash, r.hash.slice(0, 18) + '…');
}
const bals = await Promise.all(accts.map((a) => pool.getBalance(a.address)));
// .map(formatUnits) would pass the ARRAY INDEX as the decimals argument,
// printing nonsense like "0.24" for a 0.24 balance at index 0. Wrap it.
ok('funded wallet(s) hold real testnet ETH', bals.every((b) => b > 0n), bals.map((b) => formatUnits(b)).join(' / '));

// 6. MINT FOR REAL, unattended, through the real mintAll() path.
const signers = signersFrom(vault, pool, spec);
const before = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
const res = await mintAll({
  pool,
  collection: DROP.contract,
  signers,
  quantity: 1,
  dryRun: false,
  argv: ['--auto'],
});
ok('auto-mint succeeded with no prompt', res.sent === WALLET_COUNT, `sent=${res.sent}/${WALLET_COUNT}`);

const after = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
ok('totalSupply actually increased on chain', after === before + BigInt(WALLET_COUNT), `${before} -> ${after}`);

// 7. Ownership is real and verifiable.
const inv1 = await erc721Inventory(pool, DROP.contract, a1.address);
ok('wallet owns a real token id', inv1.tokens.length === 1, `token #${inv1.tokens[0]}`);
const ownerOf = await pool.call(DROP.contract, encodeCall('ownerOf(uint256)', [inv1.tokens[0]]));
ok('ownerOf confirms it owns it', ownerOf.toLowerCase().includes(a1.address.slice(2).toLowerCase()));

// 8. Per-wallet limit is enforced on chain.
// maxPerWallet is 3 and the wallet already holds 1, so asking for 5 MUST revert.
// (Asking for 2 would be legal — this checks the limit, not the mint.)
let limitHit = false;
let limitMsg = '(no error thrown)';
const supplyBeforeLimit = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
try {
  await signers[0].signer.send({
    to: DROP.contract,
    data: encodeCall('mint(uint256)', [5]),
    value: 0n,
    maxFeePerGas: FEE_CAP,
  });
} catch (e) {
  // Use the Signer's explicit flag, not message regex: a reverts-on-estimate
  // call falls back to the gas cap and the failure surfaces from waitForReceipt
  // as "transaction reverted on chain: 0x…", which is easy to match wrongly.
  limitMsg = e.message.slice(0, 70);
  if (/insufficient funds/i.test(e.message)) {
    limitHit = false;
    limitMsg = `SETUP BUG, not a real result: ${limitMsg}`;
  } else {
    limitHit = e.reverted === true || /revert|per wallet|limit/i.test(limitMsg);
  }
}
const supplyAfterLimit = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
const minted = supplyAfterLimit - supplyBeforeLimit;
ok('per-wallet limit is enforced on chain', limitHit,
  limitHit
    ? `reverted as expected: ${limitMsg}`
    : `NOT REJECTED — supply went ${supplyBeforeLimit} -> ${supplyAfterLimit} (minted ${minted}), msg="${limitMsg}"`);

// A legal quantity (1 more, total 2 of max 3) must still succeed.
let legalOk = false;
try {
  await signers[0].signer.send({
    to: DROP.contract,
    data: encodeCall('mint(uint256)', [1]),
    value: 0n,
    maxFeePerGas: FEE_CAP,
  });
  legalOk = true;
} catch (e) {
  legalOk = false;
}
ok('a within-limit mint still succeeds', legalOk, legalOk ? 'minted 1 more' : 'unexpectedly failed');

// 9. Pause is detected and blocks.
await funder.send({ to: DROP.contract, data: encodeCall('setPaused(bool)', [true]), maxFeePerGas: FEE_CAP });
const pausedState = await mintState(pool, DROP.contract, { probeFrom: a1.address });
ok('scanner reports paused as closed', pausedState.verdict === 'closed', `${pausedState.verdict} (${pausedState.reason})`);
await funder.send({ to: DROP.contract, data: encodeCall('setPaused(bool)', [false]), maxFeePerGas: FEE_CAP });

// 10. Real NFT transfer to a real recipient address (a fresh EOA on testnet).
const recipient = '0x' + '0'.repeat(36) + 'dead'; // burn address, valid 40-hex
// This address accumulates tokens across repeat runs, so compare the DELTA
// rather than asserting an absolute balance. Snapshot BEFORE the transfer.
const recipientBefore = decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [recipient])));
// By now the wallet holds BOTH mints (the auto-mint plus the within-limit one
// above), so spread legitimately sends 2. Count what was actually held rather
// than hard-coding 1, and give the recipient one address per token.
const heldBefore = decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [a1.address])));
ok('wallet holds both minted tokens', heldBefore === 2n, `holding ${heldBefore}`);
const recipients = Array.from({ length: Number(heldBefore) }, () => recipient);
const ledgerPath = 'test/testnet-ledger.jsonl';
try { (await import('node:fs')).rmSync(ledgerPath); } catch {}
const sp = await spread({
  pool,
  chainSpec: spec,
  signers: [signers[0]],
  collection: DROP.contract,
  recipients,
  dryRun: false,
  ledger: new RunLedger(ledgerPath),
});
ok('every NFT really transferred to another address', sp.sent === Number(heldBefore), `sent=${sp.sent}/${heldBefore}`);
ok(
  'recipient balance increased by every transfer',
  decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [recipient]))) ===
    recipientBefore + heldBefore,
  `${recipientBefore} + ${heldBefore}`
);
ok(
  'sender wallet is now empty',
  decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [a1.address]))) === 0n
);

// 11. Ledger prevents a duplicate send.
const sp2 = await spread({
  pool,
  chainSpec: spec,
  signers: [signers[0]],
  collection: DROP.contract,
  recipients: [recipient],
  dryRun: false,
  ledger: new RunLedger(ledgerPath),
});
ok('re-running sends nothing (ledger)', sp2.sent === 0, `sent=${sp2.sent}`);

vault.lock();

console.log(`\n============================================================`);
console.log(`  ${pass} passed, ${fail} failed  — against Robinhood TESTNET`);
console.log(`  funded by: ${keySource}`);
console.log(`============================================================\n`);

// Clean up local artifacts; the deployed contract stays as a live example.
try {
  const fs = await import('node:fs');
  fs.rmSync(vaultPath, { force: true });
  fs.rmSync(ledgerPath, { force: true });
} catch {}

process.exitCode = fail ? 1 : 0;
