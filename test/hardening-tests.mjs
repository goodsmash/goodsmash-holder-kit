// Regression tests for the hardening pass.
//
// Every test here pins a bug that existed before: each one fails on the old
// code. Runs against a real local anvil (no mocks of this codebase) and drives
// the real CLI as a subprocess, exactly the way the UI and Hermes do.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RpcPool, isRequestError } from '../src/rpc.mjs';
import { Signer } from '../src/signer.mjs';
import { Vault } from '../src/vault.mjs';
import { ship } from '../src/distribute.mjs';
import { encodeCall, decodeUint } from '../src/abi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'holder-kit.mjs');
const PORT = 8598;
const RPC = `http://127.0.0.1:${PORT}`;
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'hk-harden-'));
const VAULT = join(tmp, 'vault', 'holder.vault');
const PWFILE = join(tmp, 'vault', 'PASSWORD.txt');

/** Run the CLI with no TTY (like the UI and agents), isolated to the temp vault. */
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      HOLDER_KIT_VAULT: VAULT,
      HOLDER_KIT_PASSWORD: '',
      HOLDER_KIT_PASSWORD_FILE: '',
      HOLDER_KIT_AGENT: '',
      HOLDER_KIT_AGENT_BROADCAST: '',
      HOLDER_KIT_AUTO: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
const LOCAL = ['--chain', 'local', '--rpc', RPC, '--i-know-this-is-testnet'];

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const balance = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const ETH = 10n ** 18n;

async function walletsFromVault(password) {
  const v = await Vault.open(VAULT, { password });
  const out = v.wallets.map((w) => w.address);
  v.lock();
  return out;
}

async function main() {
  const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await rpc('eth_chainId');
      up = true;
    } catch {
      await sleep(500);
    }
  }
  if (!up) throw new Error('anvil did not start');
  try {
    await suite();
  } finally {
    anvil.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
  if (failures.length) failures.forEach((f) => console.log(`   - ${f}`));
  console.log(`${'='.repeat(50)}\n`);
  process.exitCode = fail ? 1 : 0;
}

async function suite() {
  // ------------------------------------------------------------ setup safety
  section('setup never locks a holder out of their own vault');

  const s1 = cli(['setup', '--wallets', '1', ...LOCAL]);
  ok('first setup succeeds with no terminal and no env password', s1.code === 0, `exit ${s1.code}`);
  ok('setup wrote vault/PASSWORD.txt (the name the docs promise)', existsSync(PWFILE));
  ok('setup wrote a verified first backup', existsSync(join(tmp, 'vault', 'holder.vault.backup.bin')));
  const pw1 = readFileSync(PWFILE, 'utf8');

  const s2 = cli(['setup', ...LOCAL]);
  ok('re-running setup succeeds', s2.code === 0, `exit ${s2.code}`);
  ok('re-running setup leaves PASSWORD.txt byte-identical', readFileSync(PWFILE, 'utf8') === pw1);
  const opened = await Vault.open(VAULT, { password: pw1.trim() });
  ok('vault still opens with the original password', opened.wallets.length === 1, `${opened.wallets.length} wallet(s)`);
  opened.lock();

  // Old behaviour: with the password file gone, a non-interactive setup minted
  // a NEW password and wrote it out — a password that can never open this vault.
  renameSync(PWFILE, `${PWFILE}.aside`);
  const s3 = cli(['setup', ...LOCAL]);
  ok('setup with an existing vault and no password FAILS loudly', s3.code !== 0 && /will NOT generate/i.test(s3.out), s3.out.split('\n').find((l) => /fail/i.test(l)) || '');
  ok('…and does not create a replacement password file', !existsSync(PWFILE));
  renameSync(`${PWFILE}.aside`, PWFILE);

  const s4 = cli(['setup', '--password', 'hunter2hunter2']);
  ok('setup refuses a password on argv (shell history)', s4.code !== 0 && /not accepted on the command line/.test(s4.out));
  const s5 = cli(['wallet', 'from-seed', '--phrase', 'test test test test test test test test test test test junk']);
  ok('from-seed refuses a phrase on argv', s5.code !== 0 && /--phrase is not accepted/.test(s5.out));

  // ------------------------------------------------------------ unlock + json
  section('password file is actually used, and --json is machine-readable');
  const chk = cli(['check', '--json', ...LOCAL]);
  let chkJson = null;
  try {
    chkJson = JSON.parse(chk.stdout);
  } catch {
    /* asserted below */
  }
  ok('check --json prints one parseable JSON object', !!chkJson, chk.stdout.slice(0, 80));
  const walletCheck = chkJson?.checks?.find((c) => c.name === 'wallets');
  ok('check unlocks via vault/PASSWORD.txt with no env var', walletCheck?.ok === true, walletCheck?.detail || '');
  ok('check --json reports READY against anvil', chkJson?.ok === true);

  const wn = cli(['wallet', 'new', '3']);
  const addrs = await walletsFromVault(pw1.trim());
  ok('`wallet new 3` makes three wallets (positional count was ignored)', wn.code === 0 && addrs.length === 4, `${addrs.length} total`);

  const wl = cli(['wallet', 'list', '--json', ...LOCAL]);
  let wlJson = null;
  try {
    wlJson = JSON.parse(wl.stdout);
  } catch {
    /* asserted below */
  }
  ok('wallet list --json lists addresses and never keys', wlJson?.wallets?.length === 4 && !/[0-9a-f]{64}/i.test(wl.stdout));

  const bad = cli(['scan', '--json', '--chain', 'nope']);
  let badJson = null;
  try {
    badJson = JSON.parse(bad.stdout);
  } catch {
    /* asserted below */
  }
  ok('errors in --json mode are JSON too', badJson?.ok === false && /Unknown chain/.test(badJson.error || ''));

  // ------------------------------------------------------------ fund
  section('fund: top-up semantics, ceilings, no silent drops');
  const [src, ...others] = addrs;
  await rpc('anvil_setBalance', [src, '0x' + (2n * ETH).toString(16)]);
  const external = '0x' + '7'.repeat(40);
  const recips = [...others, external].join(',');

  const dry = cli(['fund', '--each', '0.01', '--to', recips, ...LOCAL]);
  ok('fund dry run exits 0 with no terminal (used to abort with exit 2)', dry.code === 0, `exit ${dry.code}`);
  ok('dry run sent nothing', (await balance(others[0])) === 0n);

  const live = cli(['fund', '--each', '0.01', '--to', recips, '--execute', ...LOCAL]);
  const got = await Promise.all([...others, external].map(balance));
  ok('every recipient funded, incl. one outside the vault (was dropped)', live.code === 0 && got.every((b) => b === ETH / 100n), got.map((b) => b.toString()).join(','));

  const srcBefore = await balance(src);
  const again = cli(['fund', '--each', '0.01', '--to', recips, '--execute', ...LOCAL]);
  ok('re-running fund sends nothing (old code re-sent everything)', again.code === 0 && (await balance(src)) === srcBefore && /already holds the target/.test(again.out));

  const topup = cli(['fund', '--each', '0.015', '--to', others[0], '--execute', ...LOCAL]);
  ok('fund tops up only the difference', topup.code === 0 && (await balance(others[0])) === (15n * ETH) / 1000n);

  const ceil = cli(['fund', '--each', '0.3', '--to', recips, '--execute', ...LOCAL]);
  ok('per-tx ceiling is enforced (it was never called before)', ceil.code !== 0 && /ceiling exceeded/.test(ceil.out));
  ok('…and nothing moved', (await balance(others[1])) === ETH / 100n);

  // ------------------------------------------------------------ agent mode
  section('agent (Hermes) policy is enforced in code');
  const agentEnv = { HOLDER_KIT_AGENT: '1' };
  const ag1 = cli(['fund', '--each', '0.02', '--to', recips, '--execute', ...LOCAL], agentEnv);
  ok('agent mode (default none): broadcast refused, exit 2', ag1.code === 2 && /agent mode/.test(ag1.out));
  ok('…and nothing moved', (await balance(others[1])) === ETH / 100n);
  const ag2 = cli(['fund', '--each', '0.02', '--to', recips, ...LOCAL], agentEnv);
  ok('agent mode still allows the dry run', ag2.code === 0 && /DRY RUN/.test(ag2.out));
  const ag3 = cli(['fund', '--each', '0.3', '--to', recips, '--execute', '--override-ceilings', ...LOCAL], { ...agentEnv, HOLDER_KIT_AGENT_BROADCAST: 'all' });
  ok('agent mode never accepts --override-ceilings, even at level all', ag3.code === 2 && /override-ceilings/.test(ag3.out));
  const ag4 = cli(['wallet', 'remove', others[0]], agentEnv);
  ok('agent mode refuses wallet remove', ag4.code === 2 && (await walletsFromVault(pw1.trim())).length === 4);
  const ag5 = cli(['fund', '--each', '0.02', '--to', recips, '--execute', ...LOCAL], { ...agentEnv, HOLDER_KIT_AGENT_BROADCAST: 'free-mints' });
  ok('free-mints level still refuses a fund', ag5.code === 2);

  // ------------------------------------------------------------ auto
  section('auto is a dry run unless asked, and respects agent level');
  const dep = spawnSync('forge', ['create', `${join(ROOT, 'test', 'fixtures', 'MockFreeMint.sol')}:MockFreeMint`, '--rpc-url', RPC, '--private-key', ANVIL_KEY, '--broadcast'], { encoding: 'utf8', cwd: ROOT });
  const coll = ((dep.stdout || '') + (dep.stderr || '')).match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  ok('MockFreeMint deployed', !!coll, coll || (dep.stderr || '').slice(0, 120));
  if (coll) {
    const minted = async () => decodeUint(await rpc('eth_call', [{ to: coll, data: encodeCall('totalMinted()') }, 'latest']));
    const a0 = cli(['auto', '--collection', coll, ...LOCAL]);
    ok('`auto` with no flag is a DRY RUN now (it used to broadcast)', a0.code === 0 && (await minted()) === 0n, `exit ${a0.code}`);
    ok('`auto --collection` targets that collection (the flag was ignored)', a0.out.includes(coll) || a0.out.toLowerCase().includes(coll.toLowerCase()));

    const a1 = cli(['auto', '--collection', coll, '--auto', ...LOCAL], agentEnv);
    ok('agent level none: auto --auto refused', a1.code === 2 && (await minted()) === 0n);

    const a2 = cli(['auto', '--collection', coll, '--auto', '--skip-underfunded', ...LOCAL], { ...agentEnv, HOLDER_KIT_AGENT_BROADCAST: 'free-mints' });
    const m2 = await minted();
    ok('agent level free-mints: free mint goes through', a2.code === 0 && m2 === 4n, `minted=${m2} exit=${a2.code}`);

    // Paid mint is refused at free-mints level.
    const setPrice = spawnSync('cast', ['send', coll, 'setPrice(uint256)', '1000000000000000', '--rpc-url', RPC, '--private-key', ANVIL_KEY], { encoding: 'utf8' });
    ok('price set to 0.001 for the paid-mint check', setPrice.status === 0);
    const a3 = cli(['mint', '--collection', coll, '--execute', '--skip-underfunded', ...LOCAL], { ...agentEnv, HOLDER_KIT_AGENT_BROADCAST: 'free-mints' });
    ok('agent level free-mints: a PAID mint is refused', a3.code === 2 && (await minted()) === 4n, `exit ${a3.code}`);
  }

  // ------------------------------------------------------------ RPC
  section('RPC: fail over on node problems, not on chain answers');
  ok('"header not found" (-32000) is a node problem', !isRequestError(Object.assign(new Error('-32000: header not found'), { rpcCode: -32000 })));
  ok('"insufficient funds" is a request error', isRequestError(Object.assign(new Error('-32000: insufficient funds for gas'), { rpcCode: -32000 })));
  ok('a revert string mentioning "rate limit" is still a revert', isRequestError(new Error('3: execution reverted: rate limit per wallet')));

  // A node that is behind: answers every call with -32000 header not found.
  const lagging = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const { id } = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } }));
    });
  });
  await new Promise((r) => lagging.listen(8597, '127.0.0.1', r));
  const pool = new RpcPool(
    [
      { url: 'http://127.0.0.1:8597', provider: 'lagging', tier: 'keyed' },
      { url: RPC, provider: 'anvil', tier: 'public' },
    ],
    31337
  );
  let bal = null;
  try {
    bal = await pool.getBalance(src);
  } catch (e) {
    bal = e.message;
  }
  ok('a lagging node (-32000) fails over instead of killing the run', typeof bal === 'bigint', String(bal).slice(0, 60));
  lagging.close();

  // Endpoint A accepts the tx, then the HTTP answer is lost (502). The pool
  // re-sends the SAME signed bytes to anvil, which says nonce too low / known.
  const flaky = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', async () => {
      const body = JSON.parse(b);
      const fwd = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b }).then((r) => r.text());
      if (!Array.isArray(body) && body.method === 'eth_sendRawTransaction') {
        res.writeHead(502);
        return res.end('bad gateway');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fwd);
    });
  });
  await new Promise((r) => flaky.listen(8596, '127.0.0.1', r));
  const pool2 = new RpcPool(
    [
      { url: 'http://127.0.0.1:8596', provider: 'flaky', tier: 'keyed' },
      { url: RPC, provider: 'anvil', tier: 'public' },
    ],
    31337
  );
  const signer = new Signer(ANVIL_KEY, pool2, { id: 31337, confirmationTarget: 1 });
  const dest = '0x' + '5'.repeat(40);
  const before = await balance(dest);
  let sendRes = null;
  try {
    sendRes = await signer.send({ to: dest, value: 12345n, quiet: true });
  } catch (e) {
    sendRes = e.message;
  }
  const after = await balance(dest);
  ok('a lost broadcast response is not reported as a failure', typeof sendRes === 'object' && !!sendRes?.receipt, String(typeof sendRes === 'string' ? sendRes : '').slice(0, 80));
  ok('…and the value moved exactly once', after - before === 12345n, `${after - before}`);
  flaky.close();

  // ------------------------------------------------------------ ship parsing
  section('ship refuses a half-understood plan');
  let shipErr = '';
  try {
    await ship({
      pool: null,
      signers: [],
      collection: '0x' + '1'.repeat(40),
      plan: ['# header comment', `${src} 42 ${'0x' + '2'.repeat(40)}`, `${src} 7 0xNOTANADDRESS`],
      dryRun: true,
      ledger: null,
    });
  } catch (e) {
    shipErr = e.message;
  }
  ok('a typo in one line rejects the whole plan, naming the line', /line 3: bad recipient/.test(shipErr), shipErr.split('\n')[0]);

  // ------------------------------------------------------------ password change
  section('change-password keeps vault and password file in step');
  const cp = cli(['wallet', 'change-password'], { HOLDER_KIT_NEW_PASSWORD: 'a-brand-new-long-password' });
  ok('change-password succeeds non-interactively', cp.code === 0, cp.out.split('\n')[0]);
  ok('PASSWORD.txt updated to the new password', readFileSync(PWFILE, 'utf8').trim() === 'a-brand-new-long-password');
  ok('vault opens with the new password', (await walletsFromVault('a-brand-new-long-password')).length === 4);
  const rs = cli(['wallet', 'restore', join(tmp, 'vault', 'holder.vault.backup.bin')], { HOLDER_KIT_BACKUP_PASSWORD: pw1.trim() });
  ok('restore merges from an old-password backup without duplicates', rs.code === 0 && /restored 0 wallet/.test(rs.out) && (await walletsFromVault('a-brand-new-long-password')).length === 4);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
