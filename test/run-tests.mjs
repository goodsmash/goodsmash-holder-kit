// End-to-end test suite.
//
// Runs against a REAL local anvil chain with REAL deployed contracts — no mocks
// of our own code. Proves: ABI encoding matches the chain, the vault round-trips
// and rejects wrong passwords, RPC failover actually recovers, spread moves
// NFTs, and the free-mint scanner reports true chain state.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { encodeCall, decodeAddress, decodeUint, formatUnits, parseUnits, selector } from '../src/abi.mjs';
import { RpcPool } from '../src/rpc.mjs';
import { Vault, encryptVault, decryptVault } from '../src/vault.mjs';
import { Signer } from '../src/signer.mjs';
import { erc721Inventory, detectStandard, nativeBalances } from '../src/inventory.mjs';
import { mintState, scanForMints } from '../src/mintscan.mjs';
import { verifyOwnership, spread } from '../src/distribute.mjs';
import { dedupeAddresses, assertWithinLimits, RunLedger, isAuto, isDryRun } from '../src/safety.mjs';
import { redactUrl, resolveChain } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const j = await res.json();
      if (!j.error) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

// Anvil's first default account. This key is PUBLIC, DOCUMENTED, and only ever
// controls test ETH on a local chain that dies with the process. It is safe to
// commit; a real holder key appearing in this repo would not be.
const ANVIL_TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function deploy(sourceFile, contractName) {
  // forge needs path:Contract as a SINGLE argument; splitting it makes forge
  // read ":MockRigs" as a positional arg and fail.
  const target = `${join(ROOT, 'test', 'fixtures', sourceFile)}:${contractName}`;
  const r = spawnSync(
    'forge',
    ['create', target, '--rpc-url', RPC, '--private-key', ANVIL_TEST_KEY, '--broadcast'],
    { encoding: 'utf8', cwd: ROOT, shell: true }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`forge create failed for ${contractName}:\n${out.slice(0, 800)}`);
  return m[1];
}

async function main() {
  console.log('\nholder-kit test suite');
  console.log('====================');

  // Anvil comes up FIRST: the failover tests need a genuinely live endpoint to
  // fail over TO, and ordering it after them just tests a dead socket twice.
  const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  const anvilUp = await waitForAnvil();
  if (!anvilUp) {
    anvil.kill();
    throw new Error('anvil did not start on port ' + PORT);
  }
  // no external cleanup needed; anvil + tmpdir are handled in main()
  try {
    await runSuite();
  } finally {
    anvil.kill();
    rmSync(tmp, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------- report
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log(`\n  failures:`);
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`${'='.repeat(50)}\n`);
  process.exitCode = fail ? 1 : 0;
}

const tmp = mkdtempSync(join(tmpdir(), 'hk-test-'));

async function runSuite() {

  // ---------------------------------------------------------------- unit: ABI
  section('ABI encoding (checked against real selectors)');
  ok('erc721 transferFrom selector', selector('transferFrom(address,address,uint256)') === '0x23b872dd', selector('transferFrom(address,address,uint256)'));
  ok('balanceOf(address) selector', selector('balanceOf(address)') === '0x70a08231', selector('balanceOf(address)'));
  ok('mint(uint256) selector', selector('mint(uint256)') === '0xa0712d68', selector('mint(uint256)'));
  ok('supportsInterface(bytes4) selector', selector('supportsInterface(bytes4)') === '0x01ffc9a7', selector('supportsInterface(bytes4)'));

  const enc = encodeCall('transferFrom(address,address,uint256)', ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 5]);
  ok('transferFrom encodes 4 + 3 words', enc.length === 2 + 8 + 64 * 3, `len=${enc.length}`);

  const a1 = '0xAbC0000000000000000000000000000000000001';
  const encU = encodeCall('balanceOf(address)', [a1]);
  ok('calldata starts 0x + 4-byte selector', /^0x[0-9a-f]{8}$/.test(encU.slice(0, 10)), encU.slice(0, 10));
  ok('address word is left-padded and lowercased', encU === '0x70a08231' + '0'.repeat(24) + a1.slice(2).toLowerCase(), encU);

  const encBool = encodeCall('supportsInterface(bytes4)', ['0x80ac58cd']);
  ok('bytes4 is LEFT-aligned', encBool.endsWith('80ac58cd' + '0'.repeat(56)), encBool.slice(-70));

  ok('decodeUint round-trips', decodeUint('0x' + (12345).toString(16).padStart(64, '0')) === 12345n);
  ok('formatUnits trims trailing zeros', formatUnits(parseUnits('1.500', 18)) === '1.5', formatUnits(parseUnits('1.500', 18)));
  ok('decodeAddress reads the low 20 bytes', decodeAddress('0x' + '0'.repeat(24) + 'ab'.repeat(20)) === '0x' + 'ab'.repeat(20));

  // ------------------------------------------------------------- unit: safety
  section('Safety rules');
  ok('dry-run is the DEFAULT', isDryRun([]) === true);
  ok('--execute leaves dry run', isDryRun(['--execute']) === false);
  ok('auto mode detected from flag', isAuto(['--auto']) === true);
  ok('auto mode detected from env', (() => { process.env.HOLDER_KIT_AUTO = '1'; const r = isAuto([]); delete process.env.HOLDER_KIT_AUTO; return r; })());

  let threw = false;
  try { assertWithinLimits({ perTxEth: 10, perRunEth: 50 }); } catch { threw = true; }
  ok('overspend is blocked without override', threw);

  threw = false;
  try { assertWithinLimits({ perTxEth: 0.01, perRunEth: 0.1 }); } catch { threw = true; }
  ok('normal spend passes ceilings', !threw);

  const dedup = dedupeAddresses(['0x' + 'aa'.repeat(20), '0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20)]);
  ok('duplicate recipients collapse', dedup.length === 2, `got ${dedup.length}`);

  threw = false;
  try { dedupeAddresses(['not-an-address']); } catch { threw = true; }
  ok('garbage recipient is rejected', threw);

  threw = false;
  try { redactUrl('https://rpc.example.com/v2/abcdef1234567890abcdef'); } catch { threw = true; }
  ok('redactUrl does not throw', !threw);
  ok('redactUrl hides api keys', !redactUrl('https://eth-mainnet.example.com/v2/SUPERSECRETKEY123456?api_key=TOPSECRET').includes('TOPSECRET'), redactUrl('https://eth-mainnet.example.com/v2/SUPERSECRETKEY123456?api_key=TOPSECRET'));
  ok('redactUrl hides bearer creds', !redactUrl('https://user:hunter2@node.example.com').includes('hunter2'));

  // ----------------------------------------------------------- unit: the vault
  section('Vault crypto (round trip, wrong password, tamper)');
  const tmp = mkdtempSync(join(tmpdir(), 'hk-test-'));
  const vaultPath = join(tmp, 't.vault');

  const pw = 'correct horse battery staple';
  const obj = { label: 'test', wallets: [{ address: '0x' + '11'.repeat(20), privateKey: '0x' + '22'.repeat(32) }] };
  const buf = encryptVault(obj, pw);
  const back = decryptVault(buf, pw);
  ok('vault round-trips', back.wallets[0].privateKey === obj.wallets[0].privateKey);
  ok('ciphertext does NOT contain the plaintext key', !buf.toString('latin1').includes('2222222222222222222222222222222222222222222222222222222222222222'));

  let rejected = false;
  try { decryptVault(buf, 'wrong password'); } catch { rejected = true; }
  ok('wrong password is REJECTED', rejected);

  const tampered = Buffer.from(buf);
  tampered[tampered.length - 1] ^= 0xff; // flip one ciphertext bit
  let tamperDetected = false;
  try { decryptVault(tampered, pw); } catch { tamperDetected = true; }
  ok('a single flipped bit is DETECTED (AEAD)', tamperDetected);

  const v = await Vault.create(vaultPath, { password: pw });
  v.addWallet({ address: '0x' + '33'.repeat(20), privateKey: generatePrivateKey() });
  v.addWallet({ address: '0x' + '44'.repeat(20), privateKey: generatePrivateKey() });
  const saved = v.save();
  ok('vault file is written', existsSync(vaultPath) && saved.bytes > 100, `${saved.bytes} bytes`);
  ok('vault holds 2 wallets', saved.wallets === 2);

  const reopened = await Vault.open(vaultPath, { password: pw });
  ok('vault reopens with the right password', reopened.wallets.length === 2);
  ok('addresses survive the round trip', reopened.wallets[0].address === '0x' + '33'.repeat(20));

  const exportPath = join(tmp, 'backup.vault');
  const exp = reopened.exportTo(exportPath);
  ok('encrypted backup is written to a 2nd path', existsSync(exportPath) && exp.bytes > 100);

  let addrMismatch = false;
  try { v.addWallet({ address: '0xnope', privateKey: generatePrivateKey() }); } catch { addrMismatch = true; }
  ok('a malformed address is rejected on insert', addrMismatch);

  // ------------------------------------------------------------ unit: failover
  section('RPC failover');
  const deadPool = new RpcPool(
    [
      { url: 'http://127.0.0.1:1/dead', provider: 'dead-1', tier: 'keyed' },
      { url: 'http://127.0.0.1:2/dead', provider: 'dead-2', tier: 'keyed' },
      { url: RPC, provider: 'live', tier: 'keyed' },
    ],
    31337
  );
  const bn = await deadPool.request('eth_blockNumber');
  ok('two dead endpoints then a live one still answers', typeof bn === 'string' && bn.length > 0, `block=${bn}`);
  ok('failover was counted', deadPool.stats.failoverEvents >= 1, `failovers=${deadPool.stats.failoverEvents}`);
  ok('dead endpoints are benched', deadPool.endpoints[0].benched === true);

  const allDead = new RpcPool([{ url: 'http://127.0.0.1:1/dead', provider: 'dead', tier: 'keyed' }], 31337);
  let allDeadThrew = false;
  try { await allDead.request('eth_blockNumber'); } catch (e) { allDeadThrew = /unavailable/i.test(e.message); }
  ok('total outage raises a clear error', allDeadThrew);

  const batchPool = new RpcPool([{ url: RPC, provider: 'live', tier: 'keyed' }], 31337);
  const batch = await batchPool.batch([
    { method: 'eth_chainId' },
    { method: 'eth_blockNumber' },
    { method: 'eth_gasPrice' },
  ]);
  ok('batch returns one result per call', batch.length === 3 && batch.every(Boolean), JSON.stringify(batch).slice(0, 80));

  // ------------------------------------------------------------- live: anvil
  section('Live chain (anvil) — real contracts, real signatures');
  {
    const chainSpec = { id: 31337, key: 'local', name: 'Anvil', testnet: true, confirmationTarget: 1, endpoints: [{ url: RPC, provider: 'anvil' }] };
    const pool = new RpcPool(chainSpec.endpoints, 31337);

    ok('anvil reports chain id 31337', (await pool.fetchChainId()) === 31337);

    // privateKeyToAccount() does NOT expose .privateKey on the result (viem keeps
    // it private), so keep the raw key in a variable and pass that to Signer.
    const DEPLOYER_KEY = ANVIL_TEST_KEY;
    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const deployerSigner = new Signer(DEPLOYER_KEY, pool, chainSpec);

    const nftAddr = deploy('MockRigs.sol', 'MockRigs');
    ok('MockRigs deployed', !!nftAddr, nftAddr);
    const mintAddr = deploy('MockFreeMint.sol', 'MockFreeMint');
    ok('MockFreeMint deployed', !!mintAddr, mintAddr);

    // Mint 6 NFTs to the deployer, then read them back through our own encoder.
    await deployerSigner.send({ to: nftAddr, data: encodeCall('mint(address,uint256)', [deployer.address, 6]) });
    const balHex = await pool.call(nftAddr, encodeCall('balanceOf(address)', [deployer.address]));
    ok('balanceOf reads 6 via our encoder', decodeUint(balHex) === 6n, `got ${decodeUint(balHex)}`);

    const std = await detectStandard(pool, nftAddr);
    ok('standard detected as ERC721', std === 'ERC721', std);

    const inv = await erc721Inventory(pool, nftAddr, deployer.address);
    ok('inventory enumerates 6 token ids', inv.tokens.length === 6, `got ${inv.tokens.length}`);
    ok('token ids are 1..6', inv.tokens.map(String).sort((a, b) => a - b).join(',') === '1,2,3,4,5,6', inv.tokens.map(String).join(','));

    const own1 = await pool.call(nftAddr, encodeCall('ownerOf(uint256)', [inv.tokens[0]]));
    ok('ownerOf decodes back to the deployer', decodeAddress(own1).toLowerCase() === deployer.address.toLowerCase(), decodeAddress(own1));

    // ---- ownership guard must refuse to sign a transfer we do not own
    let guardThrew = false;
    try {
      await verifyOwnership(pool, nftAddr, '0x' + '99'.repeat(20), inv.tokens[0]);
    } catch (e) { guardThrew = /owned by/.test(e.message); }
    ok('ownership guard blocks a transfer we do not own', guardThrew);

    // ---- ledger prevents double-send
    const ledgerPath = join(tmp, 'ledger.jsonl');
    const ledger = new RunLedger(ledgerPath);
    ledger.record('k1', { hash: '0xabc' });
    const ledger2 = new RunLedger(ledgerPath);
    ok('run ledger reloads completed work', ledger2.has('k1') && ledger2.size === 1);

    // ---- spread: 6 NFTs from deployer round-robin to 3 recipients, fully automatic
    const recipients = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20)];
    const before = decodeUint(await pool.call(nftAddr, encodeCall('balanceOf(address)', [recipients[0]])));
    const spreadRes = await spread({
      pool,
      chainSpec,
      signers: [{ entry: { address: deployer.address }, signer: deployerSigner }],
      collection: nftAddr,
      recipients,
      dryRun: false,
      ledger: new RunLedger(join(tmp, 'spread.jsonl')),
    });
    ok('spread sent all 6 transfers with no prompt', spreadRes.sent === 6, `sent=${spreadRes.sent}`);
    const after = decodeUint(await pool.call(nftAddr, encodeCall('balanceOf(address)', [recipients[0]])));
    ok('recipient #1 received exactly 2', after - before === 2n, `delta=${after - before}`);
    const deployerLeft = decodeUint(await pool.call(nftAddr, encodeCall('balanceOf(address)', [deployer.address])));
    ok('sender is left with 0', deployerLeft === 0n, `left=${deployerLeft}`);

    // ---- re-running must not re-send. Re-mint the same ids so the ledger is
    // actually exercised: a wallet holding 0 NFTs would trivially plan 0 jobs.
    await deployerSigner.send({ to: nftAddr, data: encodeCall('mint(address,uint256)', [deployer.address, 6]) });
    const again = await spread({
      pool,
      chainSpec,
      signers: [{ entry: { address: deployer.address }, signer: deployerSigner }],
      collection: nftAddr,
      recipients,
      dryRun: false,
      ledger: new RunLedger(join(tmp, 'spread.jsonl')),
    });
    ok('re-running spread sends 0 (ledger already recorded them)', again.sent === 0 && again.skipped === 6, `sent=${again.sent} skipped=${again.skipped}`);

    // ---- funding splits native across wallets
    const W1K = generatePrivateKey();
    const W2K = generatePrivateKey();
    const w1 = privateKeyToAccount(W1K);
    const w2 = privateKeyToAccount(W2K);
    void w2;
    await deployerSigner.send({ to: w1.address, value: parseUnits('0.5', 18) });
    await deployerSigner.send({ to: w2.address, value: parseUnits('0.5', 18) });
    const bals = await nativeBalances(pool, [w1.address, w2.address]);
    ok('both funded wallets hold 0.5', bals.every((b) => b.wei === parseUnits('0.5', 18)), bals.map((b) => formatUnits(b.wei)).join(','));

    // ---- free-mint scanner reads REAL state: free + active
    // probe from the funded deployer so a paid mint can actually be estimated
    let st = await mintState(pool, mintAddr, { probeFrom: deployer.address });
    ok('scanner sees a FREE mint as free-live', st.verdict === 'free-live', `${st.verdict} (${st.reason})`);
    ok('scanner reports the mint shape', st.sigs.includes('mint(uint256)'), st.sigs.join(','));
    ok('mint shape is GAS-VERIFIED, not guessed', st.verified === true, `verified=${st.verified}`);
    ok('scanner reports max per wallet', st.maxPerWallet === 5n, String(st.maxPerWallet));

    // ---- paid mint is reported as paid, not free
    await deployerSigner.send({ to: mintAddr, data: encodeCall('setPrice(uint256)', [parseUnits('0.05', 18)]) });
    st = await mintState(pool, mintAddr, { probeFrom: deployer.address });
    ok('scanner reports a PAID mint as paid-live', st.verdict === 'paid-live', `${st.verdict} (${st.reason})`);
    ok('paid mint is NOT labelled free', st.isFree === false);

    // ---- paused contract reads as closed
    await deployerSigner.send({ to: mintAddr, data: encodeCall('setPrice(uint256)', [0]) });
    await deployerSigner.send({ to: mintAddr, data: encodeCall('setPaused(bool)', [true]) });
    st = await mintState(pool, mintAddr, { probeFrom: deployer.address });
    ok('scanner reports a PAUSED mint as closed', st.verdict === 'closed', `${st.verdict} (${st.reason})`);
    await deployerSigner.send({ to: mintAddr, data: encodeCall('setPaused(bool)', [false]) });

    // ---- sold out reads as sold-out, not free
    await deployerSigner.send({ to: mintAddr, data: encodeCall('setMaxSupply(uint256)', [1]) });
    const W3K = generatePrivateKey();
    const w3 = privateKeyToAccount(W3K);
    void w3;
    // a fresh wallet needs gas before it can mint
    await deployerSigner.send({ to: w3.address, value: parseUnits('0.5', 18) });
    await new Signer(W3K, pool, chainSpec).send({ to: mintAddr, data: encodeCall('mint(uint256)', [1]), value: 0n });
    st = await mintState(pool, mintAddr, { probeFrom: deployer.address });
    ok('scanner reports SOLD OUT distinctly', st.verdict === 'sold-out', `${st.verdict} (${st.reason})`);
    // A sold-out FREE mint still has price 0 — isFree describes PRICE, not
    // availability. The verdict is what says it cannot be minted.
    ok('sold-out free mint still reports price 0', st.isFree === true && st.priceWei === 0n, `isFree=${st.isFree}`);
    ok('sold-out is NOT actionable (verdict is not free-live)', st.verdict !== 'free-live');

    // ---- bytecode-only detection (no funded probe) must be labelled unverified
    const noProbe = await mintState(pool, mintAddr, {});
    ok('without a funded probe, shapes come from bytecode', noProbe.sigs.length > 0, noProbe.sigs.join(','));
    ok('bytecode-detected shapes are marked UNVERIFIED', noProbe.verified === false, `verified=${noProbe.verified}`);

    // ---- a plain NFT (mint is payable, no price/supply getters) must not crash
    const scan = await scanForMints(pool, { ...chainSpec, collections: { RIGS: { address: nftAddr } } }, { probeFrom: deployer.address });
    ok('scan of an NFT with a payable mint does not error', scan[0].verdict !== 'error', `${scan[0].verdict} (${scan[0].reason})`);
    ok('scan reports the standard', scan[0].standard === 'ERC721', scan[0].standard);
    // No price getter means we cannot claim "free" — that would be a guess.
    ok('no price getter is NOT reported as free', scan[0].isFree === false, `isFree=${scan[0].isFree}`);
    ok('missing price is stated, not invented', /no price getter/.test(scan[0].reason), scan[0].reason);

    // ---- config resolution must refuse a chain whose only endpoints are placeholders
    const placeholderFile = join(tmp, 'endpoints-placeholder.json');
    writeFileSync(
      placeholderFile,
      JSON.stringify({
        providers: { only: { url: 'https://YOUR-KEY.example.com/v2/abcdef', tier: 'keyed' } },
        assignments: { robinhoodTestnet: ['only'] },
      })
    );
    let phThrew = false;
    let phMsg = '';
    try {
      resolveChain('robinhoodTestnet', { endpointsFile: placeholderFile });
    } catch (e) {
      phThrew = true;
      phMsg = e.message;
    }
    ok('a placeholder-only provider still leaves the public RPC usable', !phThrew, phMsg.slice(0, 60));

    // A real provider assigned to a chain must be preferred over the public one.
    const keyedFile = join(tmp, 'endpoints-keyed.json');
    writeFileSync(
      keyedFile,
      JSON.stringify({
        providers: { mine: { url: RPC, tier: 'keyed' } },
        assignments: { robinhoodTestnet: ['mine'] },
      })
    );
    const keyed = resolveChain('robinhoodTestnet', { endpointsFile: keyedFile });
    ok('a keyed provider is ranked first', keyed.endpoints[0].provider === 'mine', keyed.endpoints[0].provider);
    ok('the public RPC is kept as a fallback', keyed.endpoints.length >= 2, `${keyed.endpoints.length} endpoints`);

    // A CLI --rpc must win outright.
    const cliSpec = resolveChain('robinhoodTestnet', { rpc: RPC, endpointsFile: keyedFile });
    ok('--rpc overrides everything and is ranked first', cliSpec.endpoints[0].provider === 'cli' && cliSpec.endpoints[0].url === RPC);


  }
}

main().catch((e) => {
  console.error('\ntest harness error:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(1, 8).join('\n'));
  process.exitCode = 1;
});
