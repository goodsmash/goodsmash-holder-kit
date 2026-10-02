// SCALE PROOF — launch a real free-mint drop on Robinhood testnet and mint it
// from MANY wallets, unattended, through the real CLI code path.
//
// Where test/testnet-proof.mjs proves one mint end to end, this proves the
// thing a holder actually cares about: does the toolkit mint from a whole
// fleet of wallets, unattended, and get every one of them on chain?
//
// Deploys test/fixtures/MultiMint.sol to chain 46630, funds N wallets from one
// deployer, runs the unattended auto-mint, then verifies EVERY wallet's
// ownership by reading the chain back.

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getCreateAddress, toHex } from 'viem';

import { RpcPool } from '../src/rpc.mjs';
import { Vault } from '../src/vault.mjs';
import { Signer, signersFrom } from '../src/signer.mjs';
import { encodeCall, decodeUint, formatUnits, parseUnits } from '../src/abi.mjs';
import { mintState } from '../src/mintscan.mjs';
import { mintAll } from '../src/mint.mjs';
import { spread } from '../src/distribute.mjs';
import { RunLedger } from '../src/safety.mjs';
import { resolveChain } from '../src/config.mjs';

const WALLET_COUNT = Number(process.env.PROOF_WALLETS || 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAILED  ${name}${detail ? '  ' + detail : ''}`); }
};

// --- key discovery (same order as the single-wallet proof) -----------------
function findDeployerKey() {
  const env = process.env.ROBINHOOD_TESTNET_DEPLOYER_KEY?.trim();
  if (env) return env.startsWith('0x') ? env : '0x' + env;
  const f = join(homedir(), 'Documents', 'rh-testnet-wallet', 'testnet-deployer.json');
  if (existsSync(f)) {
    const k = JSON.parse(readFileSync(f, 'utf8')).privateKey;
    return k.startsWith('0x') ? k : '0x' + k;
  }
  console.error('\nNo funded testnet key. Run: node test/make-testnet-wallet.mjs and fund it.\n');
  process.exit(1);
}
const deployerKey = findDeployerKey();

const spec = resolveChain('robinhoodTestnet', {});
const pool = new RpcPool(spec.endpoints, spec.id);
const DROP_FILE = 'test/multimint-drop.json';

console.log(`\n============================================================`);
console.log(`  SCALE PROOF — ${WALLET_COUNT} wallets, one unattended run`);
console.log(`============================================================`);
console.log(`  chain    : ${spec.name} (id ${spec.id})`);
console.log(`  rpc      : ${spec.endpoints[0].url}`);
console.log('');

const funder = new Signer(deployerKey, pool, spec);
const funderAddr = funder.address;
const gp = await pool.gasPrice();
const FEE_CAP = (gp * 3n) / 2n;
const TX_COST = FEE_CAP * 120000n;

console.log(`  gas      : ${formatUnits(gp)} per gas`);
console.log(`  funder   : ${funderAddr}`);
console.log(`  balance  : ${formatUnits(await funder.balance())} test ETH`);
console.log('');

// --- 1. deploy, or reuse an existing deployment ---------------------------
let DROP;
if (existsSync(DROP_FILE)) {
  DROP = JSON.parse(readFileSync(DROP_FILE, 'utf8'));
  const code = await pool.getCode(DROP.contract);
  if (code && code !== '0x') {
    console.log(`  reusing existing deployment ${DROP.contract}`);
    // A previous run's sold-out test permanently lowered MAX_SUPPLY. Restore it
    // BEFORE minting, or every wallet reverts "sold out" and the whole run
    // fails for a reason that has nothing to do with the toolkit.
    try {
      await funder.send({
        to: DROP.contract,
        data: encodeCall('resetSupply()', []),
        maxFeePerGas: FEE_CAP,
      });
    } catch {
      /* an older deployment without resetSupply() just gets redeployed */
    }
  } else {
    DROP = null; // stale record, redeploy
  }
}

if (!DROP) {
  console.log('  deploying MultiMint to testnet...');
  const { abi, bytecode } = JSON.parse(readFileSync('out/MultiMint.sol/MultiMint.json', 'utf8'));
  const deployData = bytecode.object || toHex(bytecode);
  const est = await pool.estimateGas({ from: funderAddr, data: deployData });
  const tx = await funder.send({ data: deployData, gas: est, maxFeePerGas: FEE_CAP });

  // Derive the CREATE address from sender nonce + init code. Reading it back
  // and refusing to continue if it has no bytecode is what makes this a proof
  // rather than an assumption.
  const nonce = await pool.getTransactionCount(funderAddr);
  const addr = getCreateAddress({ from: funderAddr, nonce: nonce - 1 }, deployData);

  // Prove the deployment is real before trusting the address.
  const code = await pool.getCode(addr);
  if (!code || code === '0x') {
    console.error(`\n  deploy reported success but ${addr} has no bytecode.\n`);
    process.exit(1);
  }
  DROP = {
    contract: addr,
    deployTx: tx.hash,
    deployer: funderAddr,
    abi,
    note: 'Testnet only. Worthless tokens.',
  };
  writeFileSync(DROP_FILE, JSON.stringify(DROP, null, 2));
  console.log(`  deployed at ${addr}`);
  console.log(`  tx         ${tx.hash}`);
}
console.log('');

// --- 2. the drop reads as FREE + LIVE from chain state ---------------------
const st = await mintState(pool, DROP.contract, { probeFrom: funderAddr });
ok('new drop scans as free-live', st.verdict === 'free-live', `${st.verdict} (${st.reason})`);
// The field is `priceWei`; `price` is not part of the returned state.
ok('price reads 0 from chain', st.priceWei === 0n, `${st.priceWei} wei`);
ok('a mint shape was gas-verified', st.verified === true, st.sigs?.[0] || '(none)');

// --- 3. build a vault of N wallets ----------------------------------------
const vaultPath = 'test/scale-vault.bin';
const vault = await Vault.create(vaultPath, { password: 'scale-proof-only' });
const accts = [];
for (let i = 0; i < WALLET_COUNT; i++) {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k);
  accts.push(a);
  vault.addWallet({ address: a.address, privateKey: k, note: `scale-${i + 1}` });
}
vault.save();
ok(`vault holds ${WALLET_COUNT} wallet(s)`, vault.wallets.length === WALLET_COUNT);

// --- 4. fund them all from the single deployer ----------------------------
const perWallet = FEE_CAP * 700000n;
const need = perWallet + TX_COST;
const bal = await funder.balance();
if (bal < need * BigInt(WALLET_COUNT)) {
  console.log(`
  NOT ENOUGH TEST ETH to fund ${WALLET_COUNT} wallets.

    have : ${formatUnits(bal)}
    need : ${formatUnits(need * BigInt(WALLET_COUNT))}  (${formatUnits(need)} each)

  Top up ${funderAddr} at https://faucet.testnet.chain.robinhood.com
  or lower the run:  PROOF_WALLETS=3 npm run test:scale
  `);
  rmSync(vaultPath, { force: true });
  process.exit(1);
}

let funded = 0;
for (const a of accts) {
  try {
    await funder.send({ to: a.address, value: perWallet, maxFeePerGas: FEE_CAP });
    funded++;
  } catch (e) {
    console.log(`    fund ${a.address.slice(0, 10)}… failed: ${e.message.slice(0, 60)}`);
  }
}
ok(`all ${WALLET_COUNT} wallets funded`, funded === WALLET_COUNT, `${funded}/${WALLET_COUNT}`);

// --- 5. unattended auto-mint across the whole fleet ------------------------
const signers = signersFrom(vault, pool, spec);
const supplyBefore = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
console.log(`\n  auto-minting from ${signers.length} wallet(s), no prompts...\n`);

const res = await mintAll({
  pool,
  collection: DROP.contract,
  signers,
  quantity: 1,
  dryRun: false,
  argv: ['--auto', '--skip-underfunded'],
});

ok('every wallet minted, unattended', res.sent === WALLET_COUNT, `sent=${res.sent}/${WALLET_COUNT}`);

// --- 6. verify EVERY wallet on chain, one by one --------------------------
const supplyAfter = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
ok('totalSupply rose by exactly the wallet count',
  supplyAfter === supplyBefore + BigInt(WALLET_COUNT),
  `${supplyBefore} -> ${supplyAfter}`);

let owned = 0;
const owners = [];
for (const a of accts) {
  const balN = decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [a.address])));
  if (balN === 1n) { owned++; owners.push(a); }
}
ok('every wallet independently verified as owner', owned === WALLET_COUNT, `${owned}/${WALLET_COUNT} own exactly 1`);

// tokensOfOwner returns uint256[], which ABI-encodes as
//     [offset=32][length][element 0][element 1]…
// so the ELEMENTS start at word index 2. Skipping only the offset word feeds
// the LENGTH into ownerOf() — it asked about token "1" for every wallet, which
// is a real token owned by someone else, so the check read 0/3 and looked like
// a product bug. Read the length, then take exactly that many elements.
let ownerOfOk = 0;
for (const a of accts.slice(0, 3)) {
  const raw = await pool.call(DROP.contract, encodeCall('tokensOfOwner(address)', [a.address]));
  const words = (raw.match(/[0-9a-f]{64}/g) || []);
  const len = words.length >= 2 ? Number(BigInt(`0x${words[1]}`)) : 0;
  const ids = words.slice(2, 2 + len).map((h) => BigInt(`0x${h}`)).filter((n) => n > 0n);
  if (ids.length) {
    const owner = await pool.call(DROP.contract, encodeCall('ownerOf(uint256)', [ids[0]]));
    if (owner.toLowerCase().includes(a.address.slice(2).toLowerCase())) ownerOfOk++;
  }
}
ok('ownerOf() confirms the token ids', ownerOfOk === Math.min(3, accts.length), `${ownerOfOk}/3 checked`);

// --- 7. fleet-wide spread to many distinct recipients ----------------------
const ledgerPath = 'test/scale-ledger.jsonl';
rmSync(ledgerPath, { force: true });
const recipientList = [];
for (let i = 0; i < WALLET_COUNT; i++) {
  recipientList.push('0x' + (i + 1).toString(16).padStart(40, '0'));
}
const ledger = new RunLedger(ledgerPath);
let spreadSent = 0;
for (const s of signers) {
  const sp = await spread({
    pool, chainSpec: spec, signers: [s], collection: DROP.contract,
    recipients: recipientList, dryRun: false, ledger,
  });
  spreadSent += sp.sent;
}
ok('one NFT from every wallet spread to distinct addresses', spreadSent === WALLET_COUNT, `sent=${spreadSent}`);

let drained = 0;
for (const a of accts) {
  if (decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [a.address]))) === 0n) drained++;
}
ok('all source wallets drained', drained === WALLET_COUNT, `${drained}/${WALLET_COUNT} empty`);

const received = decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [recipientList[0]])));
ok('recipient #1 received real tokens', received >= 1n, `balance=${received}`);

// --- 8. ledger prevents a duplicate fleet-wide send -----------------------
const again = await spread({
  pool, chainSpec: spec, signers: [signers[0]], collection: DROP.contract,
  recipients: recipientList, dryRun: false, ledger,
});
ok('re-running the spread sends nothing', again.sent === 0, `sent=${again.sent}`);

// --- 9. price change is detected from chain, not cached --------------------
await funder.send({ to: DROP.contract, data: encodeCall('setFreePrice(uint256)', [parseUnits('0.001', 18)]), maxFeePerGas: FEE_CAP });
const pricedState = await mintState(pool, DROP.contract, { probeFrom: funderAddr });
// The field is `priceWei` — `price` is not part of the returned state.
ok('scanner follows a live price change', pricedState.priceWei === parseUnits('0.001', 18),
  `price now ${formatUnits(pricedState.priceWei)} ETH`);
ok('a priced mint is no longer reported free', pricedState.verdict !== 'free-live', pricedState.verdict);

await funder.send({ to: DROP.contract, data: encodeCall('setFreePrice(uint256)', [0]), maxFeePerGas: FEE_CAP });

// --- 10. supply exhaustion is reported honestly ----------------------------
// Do this LAST, and always restore afterwards. Lowering MAX_SUPPLY is
// PERMANENT, so ending the run sold-out means the next run's wallets revert
// "sold out" during minting and the whole proof fails for a reason that has
// nothing to do with the toolkit. An ordering bug that cost several cycles.
const supplyNow = decodeUint(await pool.call(DROP.contract, encodeCall('totalSupply()')));
await funder.send({
  to: DROP.contract,
  data: encodeCall('setMaxSupply(uint256)', [supplyNow]),
  maxFeePerGas: FEE_CAP,
});
const soldState = await mintState(pool, DROP.contract, { probeFrom: funderAddr });
ok('sold-out is reported as sold-out', soldState.verdict === 'sold-out', `${soldState.verdict} (${soldState.reason})`);

// Restore, so the next run starts from a mintable contract.
await funder.send({ to: DROP.contract, data: encodeCall('resetSupply()', []), maxFeePerGas: FEE_CAP });
const restored = decodeUint(await pool.call(DROP.contract, encodeCall('MAX_SUPPLY()')));
ok('supply restored for the next run', restored > supplyNow, `MAX_SUPPLY back to ${restored}`);

console.log(`\n============================================================`);
console.log(`  ${pass} passed, ${fail} failed  — SCALE PROOF on Robinhood TESTNET`);
console.log(`  ${WALLET_COUNT} wallets, contract ${DROP.contract}`);
console.log(`============================================================\n`);

try {
  rmSync(vaultPath, { force: true });
  rmSync(ledgerPath, { force: true });
} catch {}

process.exitCode = fail === 0 ? 0 : 1;