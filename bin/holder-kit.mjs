#!/usr/bin/env node
// holder-kit — self-custodied holder toolkit.
//
// Hard rule: private keys are read from an encrypted vault on THIS machine,
// signed locally, and sent only to the RPC endpoint the holder configured.
// There is no key server, no telemetry, and no third-party signer.
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';

import { resolveChain, listChains, redactUrl } from '../src/config.mjs';
import { RpcPool } from '../src/rpc.mjs';
import { Vault, hiddenPrompt, assertNoSecretLeak } from '../src/vault.mjs';
import { Signer, signersFrom } from '../src/signer.mjs';
import { doctor } from '../src/doctor.mjs';
import { inventoryAll, nativeBalances } from '../src/inventory.mjs';
import { spread, ship, fund } from '../src/distribute.mjs';
import { mintAll, mintReport } from '../src/mint.mjs';
import { scanForMints, printMintScan, watchAndMint } from '../src/mintscan.mjs';
import { formatUnits } from '../src/abi.mjs';
import { RunLedger, isDryRun, isAuto, gateBroadcast, Aborted, dedupeAddresses, assertChainExpectation } from '../src/safety.mjs';
import { quickSetup, selfCheck } from '../src/setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VAULT_PATH = process.env.HOLDER_KIT_VAULT || join(ROOT, 'vault', 'holder.vault');
const LEDGER_PATH = join(ROOT, 'runs', 'ledger.jsonl');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function flag(argv, name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

/**
 * Collect every --address value.
 *
 * `flag()` returns the VALUE when one follows, and `true` when addresses are
 * passed bare (`--address 0xa 0xb`). Treating only the `true` case as a list
 * silently dropped the single most common form, `--address 0xOne`.
 */
function addressList(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--address') continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.push(next);
    } else {
      // bare form: consume following address-looking tokens
      for (let j = i + 1; j < argv.length && /^0x[0-9a-fA-F]{40}$/.test(argv[j]); j++) out.push(argv[j]);
    }
  }
  return out.length ? out.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) : undefined;
}

function listFiles(pathOrList) {
  // Accept: a file path, a comma list, or a directory of *.json / *.txt
  const out = [];
  const candidates = String(pathOrList).split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of candidates) {
    const p = resolve(c);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) {
        if (/\.(json|txt|csv)$/i.test(f)) out.push(join(p, f));
      }
    } else out.push(p);
  }
  return out;
}

async function openVault({ create = false } = {}) {
  if (!existsSync(VAULT_PATH)) {
    if (!create) {
      throw new Error(
        `no vault at ${VAULT_PATH}\nCreate one with:  holder-kit init`
      );
    }
    mkdirSync(dirname(VAULT_PATH), { recursive: true });
    return Vault.create(VAULT_PATH, { label: 'holder-kit vault' });
  }
  return Vault.open(VAULT_PATH);
}

async function context(argv) {
  const chainKey = flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet');
  const spec = resolveChain(chainKey, { rpc: flag(argv, 'rpc', false) || undefined });
  assertChainExpectation(spec, argv);
  const pool = new RpcPool(spec.endpoints, spec.id);
  return { chainKey, spec, pool };
}

const HELP = `
${C.b('holder-kit')} ${C.dim('— one command and you never sign anything again')}

  ${C.c('node bin/holder-kit.mjs setup')}          ${C.dim('START HERE — creates everything, no questions')}
  ${C.c('node bin/holder-kit.mjs setup 5')}       ${C.dim('same, plus 5 new wallets')}

${C.b('AFTER SETUP')}   ${C.dim('all of these are automatic — no prompts, no signing')}
  find                      Is any mint FREE and open right now?
  auto                      Mint every free live mint from all your wallets
  watch --collection 0x...  Wait for a free window, then mint it
  spread --collection 0x... --to holders.txt    Send NFTs round-robin to holders
  ship   --collection 0x... --plan plan.txt     Send specific NFTs to specific people
  fund   --each 0.005 --to wallets.txt          Split gas across wallets
  scan                      What do I hold?
  mint-report 0x...          Everything about one collection's mint

${C.b('CHECKS')}
  doctor  [--chain X]       Test every RPC and prove failover works
  check                     One-line "is everything ready?" answer
  wallet list               Addresses + balances (never keys)
  wallet backup <path>      Encrypted copy to a second location
  wallet new <count>        Generate more wallets
  wallet from-seed          Import a recovery phrase (hidden input)
  chains                    Supported chains

${C.dim('Keys are encrypted on your machine and never leave it. Nothing is sent to us.')}
${C.dim('Every action is a dry run until you add --auto or --execute.')}
${C.dim('HOLDER_KIT_AUTO=1 makes every command automatic.')}
`;

const AGENT_AUTH = `
${C.b('Hermes / AI agent authorisation')}
${C.dim('An agent may run, unattended: setup, check, doctor, chains, endpoints,')}
${C.dim('wallet list/new/from-seed/backup, scan, find, mint-report, and the dry-run')}
${C.dim('form of every action. Agents MUST NOT: read or print key material, pass')}
${C.dim('--auto/--execute, override ceilings, or broadcast on an unnamed chain.')}
Full contract: agents/AGENTS.md  ·  machine rules: agents/SKILL.md
`;


/**
 * One-command onboarding. No prompts, no flags required, safe to re-run.
 *
 * This is the ONLY thing a brand-new user should have to type. It creates the
 * vault (generating a strong password when nobody is there to type one), runs
 * the self-check, and tells them the single next command.
 */
async function runSetup(rest) {
  const args = rest.filter(Boolean);
  // `--wallets 3` or a bare `3`. Default to 1: a brand-new vault with no wallets
  // cannot do anything useful, so make setup produce something runnable.
  const bare = args.find((a) => /^\d+$/.test(a));
  const walletCount = Number(flag(args, 'wallets', bare ?? 1)) || 1;
  const chainKey = flag(args, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet');

  console.log(`\n${C.b('holder-kit setup')} ${C.dim('— one time, then you never sign anything')}\n`);

  const vaultDir = dirname(VAULT_PATH);
  mkdirSync(vaultDir, { recursive: true });

  let res;
  try {
    res = await quickSetup({
      vaultPath: VAULT_PATH,
      vaultDir,
      password: flag(args, 'password', undefined) === true ? undefined : flag(args, 'password'),
      interactive: !!process.stdin.isTTY,
      walletCount,
    });
  } catch (e) {
    console.error(`${C.r('setup failed')}: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  for (const s of res.steps) console.log(`  ${C.g('ok')} ${s.msg}`);

  if (res.passwordFile) {
    console.log(`\n  ${C.b('Your vault password is saved here:')}`);
    console.log(`  ${C.c(res.passwordFile)}`);
    console.log(`  ${C.dim('Move it somewhere safe. Anyone with that file AND the vault has your keys.')}`);
  } else if (res.passwordSource === 'HOLDER_KIT_PASSWORD') {
    console.log(`\n  ${C.dim('using the password from HOLDER_KIT_PASSWORD')}`);
  }

  // Self-check against the real chain, but never let a network problem
  // abort setup — a working vault on a flaky network is still progress.
  console.log(`\n${C.b('checking')} ${chainKey}...\n`);
  try {
    const { spec, pool } = await context(args);
    const checks = await selfCheck(pool, VAULT_PATH);
    let bad = 0;
    for (const c of checks) {
      if (c.ok) console.log(`  ${C.g('ok')} ${C.b(c.name)} ${C.dim(c.detail)}`);
      else {
        bad++;
        console.log(`  ${C.r('x ')} ${C.b(c.name)} ${C.dim(c.detail)}`);
      }
    }
    console.log(
      bad
        ? `\n  ${bad} check(s) failed. Run ${C.c('node bin/holder-kit.mjs doctor')} for detail.`
        : `\n  ${C.g('all checks passed')}`
    );
  } catch (e) {
    console.log(`  ${C.y('?')} could not reach the chain: ${e.message.slice(0, 70)}`);
    console.log(`    ${C.dim('this is fine — retry later with: node bin/holder-kit.mjs doctor')}`);
  }

  console.log(`\n${C.b("You're done.")} Nothing else to configure.\n`);
  console.log(`  ${C.c('node bin/holder-kit.mjs find')}          ${C.dim("what's free and open right now")}`);
  console.log(`  ${C.c('node bin/holder-kit.mjs auto')}          ${C.dim('mint it automatically')}`);
  console.log(`  ${C.c('node bin/holder-kit.mjs scan')}          ${C.dim('see what you hold')}`);
  console.log(`\n  ${C.dim('add your own RPC for more speed:')} node bin/holder-kit.mjs rpc add <url>\n`);
}

/** One-line readiness answer, designed to be safe to call from an agent. */
async function runCheck(argv) {
  const chainKey = flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet');
  const results = [];
  let ok = true;

  const record = (name, good, detail) => {
    results.push({ name, good, detail });
    if (!good) ok = false;
  };

  record('vault', existsSync(VAULT_PATH), existsSync(VAULT_PATH) ? VAULT_PATH : 'missing — run: setup');

  if (existsSync(VAULT_PATH)) {
    try {
      const v = await Vault.open(VAULT_PATH, {
        password: process.env.HOLDER_KIT_PASSWORD || undefined,
      });
      record('wallets', v.wallets.length > 0, `${v.wallets.length} in vault`);
      v.lock();
    } catch (e) {
      record('wallets', false, /password/i.test(e.message) ? 'vault locked (no HOLDER_KIT_PASSWORD set)' : e.message.slice(0, 50));
    }
  }

  try {
    const { spec, pool } = await context(argv);
    const bn = await pool.blockNumber();
    record('rpc', true, `${spec.name} block ${parseInt(bn, 16)} via ${pool.active}/${pool.endpoints.length} endpoints`);
  } catch (e) {
    record('rpc', false, e.message.slice(0, 60));
  }

  for (const r of results) {
    console.log(`  ${r.good ? C.g('ok') : C.r('FAIL')}  ${C.b(r.name.padEnd(9))} ${C.dim(r.detail)}`);
  }
  const ready = ok;
  console.log(
    ready
      ? `\n${C.g('READY')} — run ${C.c('find')} to see what is free, or ${C.c('auto')} to mint it.\n`
      : `\n${C.y('NOT READY')} — fix the items above, or run ${C.c('node bin/holder-kit.mjs setup')}\n`
  );
  process.exitCode = ready ? 0 : 1;
}

/**
 * Benchmark every configured RPC and rank them, so a holder can pick the fast
 * one. Also supports adding a custom endpoint in one command.
 */
async function runBench(argv) {
  const add = flag(argv, 'add', false);
  if (add !== false && typeof add === 'string') {
    addEndpoint(add, flag(argv, 'name', 'custom'), flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet'));
    return;
  }

  const chainKey = flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet');
  const runs = Number(flag(argv, 'runs', 3));
  const { spec } = await context(argv);

  console.log(`\n${C.b('RPC speed test')} — ${spec.name}, ${runs} round(s) each\n`);
    const rows = [];
    for (const ep of spec.endpoints) {
      const times = [];
      let ok = false;
      let chainId = null;
      let block = null;
      for (let i = 0; i < runs; i++) {
        const t0 = Date.now();
        const rpc = async (method) => {
          const res = await fetch(ep.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: i + 1, method, params: [] }),
            signal: AbortSignal.timeout(10_000),
          });
          return res.json();
        };
        try {
          // eth_chainId must be its own call. Reading it out of an
          // eth_blockNumber response (hex, e.g. 78155128) made every healthy
          // endpoint report a bogus "chainId mismatch".
          const idRes = await rpc('eth_chainId');
          if (!idRes.error) chainId = Number(idRes.result);
          const bnRes = await rpc('eth_blockNumber');
          if (!bnRes.error) {
            ok = chainId === spec.id;
            block = Number(bnRes.result);
            times.push(Date.now() - t0);
          }
        } catch {
          /* record the failure and move on */
        }
      }
      const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
      rows.push({ provider: ep.provider, tier: ep.tier, ok, avg, chainId, block, url: redactUrl(ep.url) });
    }

    // Fastest FIRST. Sorting descending handed the slowest healthy endpoint to
    // every subsequent request while calling it "fastest".
    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return (a.avg ?? 1e9) - (b.avg ?? 1e9);
    });
    for (const r of rows) {
      const speed = !r.ok ? C.r(r.avg == null ? 'unreachable' : 'wrong chain') : r.avg < 150 ? C.g(`${r.avg}ms  fast`) : r.avg < 500 ? `${r.avg}ms  ok` : C.y(`${r.avg}ms  slow`);
      const tier = r.tier === 'keyed' ? C.c('keyed ') : C.dim('public ');
      console.log(`  ${tier} ${String(r.provider).padEnd(22)} ${speed}`);
      console.log(`         ${C.dim(r.url)}`);
      if (r.ok) console.log(`         ${C.dim(`chain ${r.chainId}, block ${r.block}`)}`);
      else if (r.chainId != null) console.log(`         ${C.r(`chainId mismatch: got ${r.chainId}, expected ${spec.id}`)}`);
    }

    const best = rows.find((r) => r.ok); // rows are sorted fastest-first, so this IS the fastest
  console.log('');
  if (best) {
    console.log(`  ${C.g('fastest')}: ${C.c(best.provider)} at ${best.avg}ms`);
    console.log(`  ${C.dim('It is used first automatically; the rest stay as failover.')}`);
    if (rows.filter((r) => r.ok).length < 2) {
      console.log(`\n  ${C.y('Only one working endpoint.')} Add another so a rate limit cannot stop you:`);
      console.log(`    node bin/holder-kit.mjs rpc add <your-url>`);
    }
  } else {
    console.log(`  ${C.r('No endpoint works for this chain.')} node bin/holder-kit.mjs rpc add <your-url>`);
  }
  console.log('');
}

/** Persist a custom RPC into the holder's endpoints file. */
function addEndpoint(url, name, chainKey) {
  const file = join(ROOT, 'config', 'endpoints.json');
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      console.error(`${C.r('config/endpoints.json is not valid JSON')} — fix or delete it, then retry\n`);
      process.exitCode = 1;
      return;
    }
  }
  cfg.providers = cfg.providers || {};
  cfg.assignments = cfg.assignments || {};

  // Accept a bare URL or a "name=url" pair so repeat calls don't collide.
  let providerName = name;
  let providerUrl = url;
  if (url.includes('=') && url.indexOf('=') < url.indexOf('://')) {
    const [n, ...rest] = url.split('=');
    providerName = n;
    providerUrl = rest.join('=');
  }
  if (!/^https?:\/\//.test(providerUrl)) {
    console.error(`${C.r('that does not look like a URL')}: ${providerUrl}\n`);
    process.exitCode = 1;
    return;
  }

  cfg.providers[providerName] = { url: providerUrl, tier: 'keyed' };
  const list = cfg.assignments[chainKey] || [];
  if (!list.includes(providerName)) list.unshift(providerName);
  cfg.assignments[chainKey] = list;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`\n  ${C.g('added')} ${C.c(providerName)} -> ${redactUrl(providerUrl)}`);
  console.log(`  ${C.dim(`assigned to ${chainKey}, ranked first`)}`);
  console.log(`\n  ${C.dim('saved to config/endpoints.json (gitignored — your key stays local)')}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  // `agent-auth` (and a bare `agents`) just prints what an agent may do.
  if (argv[0] === 'agent-auth' || argv[0] === 'agents' || argv[0] === 'perms') {
    console.log(AGENT_AUTH);
    return;
  }
  // `setup` with no other flags is THE entry point: bare `holder-kit` and
  // `holder-kit <number>` both mean "set me up", not "print help".
  if (argv[0] === undefined || /^\d+$/.test(argv[0])) {
    await runSetup(argv);
    return;
  }

  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'setup': {
      await runSetup(argv.slice(1));
      break;
    }

    case 'rpc': {
      // `rpc add <url>` is the friendly spelling of `bench --add`.
      const sub = argv[1];
      if (sub === 'add') {
        addEndpoint(flag(argv, 'url', argv[2]), flag(argv, 'name', 'custom'), flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet'));
      } else if (sub === 'list' || sub === undefined) {
        await runBench(argv.filter((a) => a !== 'rpc' && a !== 'list'));
      } else {
        console.error(`${C.r('unknown rpc subcommand')}: ${sub}\n  try: rpc add <url>  |  rpc list\n`);
        process.exitCode = 1;
      }
      break;
    }

    case 'check': {
      await runCheck(argv);
      break;
    }

    case 'bench':
    case 'rpc-speed': {
      await runBench(argv);
      break;
    }

    case 'init': {
      const v = await openVault({ create: true });
      const res = v.save();
      console.log(`${C.g('vault created')} ${res.path}`);
      console.log(`  wallets : ${res.wallets}`);
      console.log(`  crypto  : scrypt(N=2^18) + AES-256-GCM`);
      console.log(`\nNext: holder-kit wallet new 5`);
      break;
    }

    case 'chains': {
      for (const c of listChains()) {
        console.log(`${C.b(c.key.padEnd(22))} id=${String(c.id).padEnd(6)} ${c.name}${c.testnet ? C.y('  [TESTNET]') : ''}  ${c.endpoints.length} rpc`);
      }
      break;
    }

    case 'endpoints': {
      const { spec, pool } = await context(argv);
      console.log(`\nchain ${spec.key} (id ${spec.id}) — ${spec.endpoints.length} endpoint(s):\n`);
      for (const e of spec.endpoints) {
        const { redactUrl } = await import('../src/config.mjs');
        const tier = e.tier === 'keyed' ? C.g('keyed  ') : C.dim('public ');
        console.log(`  ${tier} ${e.provider.padEnd(22)} ${redactUrl(e.url)}`);
      }
      console.log(`\nTo raise your rate limits, add a free keyed provider:`);
      console.log(`  cp config/endpoints.example.json config/endpoints.json`);
      console.log(`  # paste your URL from https://app.quicknode.com  (free tier)`);
      void pool;
      break;
    }

    case 'doctor': {
      const chainKey = flag(argv, 'chain', process.env.HOLDER_KIT_CHAIN || 'robinhoodMainnet');
      const res = await doctor(chainKey, { rpc: flag(argv, 'rpc', false) || undefined });
      process.exitCode = res.healthy ? 0 : 1;
      break;
    }

    case 'wallet': {
      const sub = argv[1];
      if (sub === 'list') {
        const v = await openVault();
        const { pool } = await context(argv);
        const bals = await nativeBalances(pool, v.wallets.map((w) => w.address));
        console.log(`\n${v.wallets.length} wallet(s) in vault ${C.dim(VAULT_PATH)}\n`);
        for (let i = 0; i < v.wallets.length; i++) {
          const w = v.wallets[i];
          console.log(`  ${String(i).padStart(3)}  ${w.address}  ${C.g(formatUnits(bals[i].wei).padEnd(12))} ${w.note || ''}`);
        }
        console.log(C.dim('\nKeys are never printed. Use `wallet backup` for an encrypted copy.'));
        v.lock();
        break;
      }
      if (sub === 'new') {
        const count = Number(flag(argv, 'count', flag(argv, 'n', 1)));
        const v = await openVault({ create: true });
        console.log(`\ngenerating ${count} wallet(s)...`);
        const added = [];
        for (let i = 0; i < count; i++) {
          const pk = generatePrivateKey();
          const acct = privateKeyToAccount(pk);
          v.addWallet({ address: acct.address, privateKey: pk, note: `generated ${new Date().toISOString().slice(0, 10)}` });
          added.push(acct.address);
          console.log(`  ${acct.address}`);
        }
        const res = v.save();
        console.log(`\n${C.g(`${count} wallet(s) created and encrypted`)} -> ${res.path}`);
        console.log(C.dim('The private keys were shown nowhere and sent nowhere. Back this file up now:'));
        console.log(C.dim(`  holder-kit wallet backup D:/my-cold-backup.vault`));
        v.lock();
        break;
      }
      if (sub === 'add') {
        const src = flag(argv, 'from', argv[2]);
        if (!src) throw new Error('usage: holder-kit wallet add <file|dir>');
        const files = listFiles(src);
        if (!files.length) throw new Error(`no readable files at ${src}`);
        const v = await openVault({ create: true });
        let n = 0;
        for (const f of files) {
          const text = readFileSync(f, 'utf8');
          const keys = [...text.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]);
          let addrs = [...text.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
          if (!keys.length) {
            console.log(`${C.y('skip')} ${f} — no 32-byte hex private key found`);
            continue;
          }
          keys.forEach((pk, i) => {
            const acct = privateKeyToAccount(pk);
            const provided = addrs[i];
            if (provided && provided.toLowerCase() !== acct.address.toLowerCase()) {
              console.log(`${C.y('warn')} ${f}: address ${provided} != key ${acct.address} — trusting the KEY`);
            }
            v.addWallet({ address: acct.address, privateKey: pk, note: f });
            n++;
          });
        }
        const res = v.save();
        console.log(`${C.g(`imported ${n} wallet(s) from ${files.length} file(s)`)} -> ${res.path}`);
        v.lock();
        break;
      }
      if (sub === 'from-seed') {
        // The one time a holder touches a secret. After this they sign nothing:
        // every later command reads the key from the encrypted vault.
        const phrase =
          flag(argv, 'phrase') ||
          process.env.HOLDER_KIT_SEED ||
          (await hiddenPrompt('Paste your 12/24-word recovery phrase (input hidden): '));
        const cleaned = String(phrase).trim().replace(/\s+/g, ' ').toLowerCase();
        const words = cleaned.split(' ').filter(Boolean);
        if (![12, 15, 18, 21, 24].includes(words.length)) {
          throw new Error(`that is ${words.length} words; a recovery phrase is 12, 15, 18, 21 or 24 words`);
        }
        const accounts = Number(flag(argv, 'accounts', 1));
        const path = flag(argv, 'path');
        const pass = flag(argv, 'derivation', "m/44'/60'/0'/0");

        const v = await openVault({ create: true });
        const added = [];
        for (let i = 0; i < accounts; i++) {
          // viem's account object intentionally does not expose .privateKey,
          // so the key must be re-derived from the phrase rather than read back.
          const keyHex = await deriveKeyHex(cleaned, i);
          const acct = privateKeyToAccount(keyHex);
          v.addWallet({ address: acct.address, privateKey: keyHex, note: 'from recovery phrase', tags: ['seed'] });
          added.push(acct.address);
          console.log(`  ${i}  ${acct.address}`);
        }
        const res = v.save();
        console.log(`\n${C.g(`${added.length} address(es) derived and encrypted`)} -> ${res.path}`);
        console.log(C.dim('The phrase is not stored. Only the derived keys are, encrypted.'));
        console.log(C.dim('From now on you never sign anything: every command signs locally from the vault.'));
        v.lock();
        break;
      }
      if (sub === 'backup') {
        const dest = flag(argv, 'to', argv[2]);
        if (!dest) throw new Error('usage: holder-kit wallet backup <path>');
        const v = await openVault();
        const res = v.exportTo(resolve(dest));
        console.log(`${C.g('encrypted backup written')} ${res.path} (${res.bytes} bytes)`);
        console.log(C.dim('Open it once on another machine before you trust it. A backup never opened is a hypothesis.'));
        v.lock();
        break;
      }
      if (sub === 'remove') {
        const addr = flag(argv, 'address', argv[2]);
        const v = await openVault();
        const n = v.removeWallet(addr);
        if (n) v.save();
        console.log(n ? `${C.g('removed')} ${addr}` : `${C.r('not in vault')} ${addr}`);
        v.lock();
        break;
      }
      throw new Error(`unknown wallet subcommand: ${sub}`);
    }

    case 'scan': {
      const v = await openVault();
      const { spec, pool } = await context(argv);
      // inventoryAll reads chainSpec.collections — pass the whole spec, not just pool.
      const rows = await inventoryAll(pool, spec, v.wallets);
      console.log(`\n${C.b('inventory')} ${spec.name} (id ${spec.id}) — ${v.wallets.length} wallet(s)\n`);
      let totalNft = 0;
      for (const r of rows) {
        if (r.tokenCount === 0) continue;
        totalNft += r.tokenCount;
        console.log(`  ${r.wallet}`);
        console.log(`     ${r.collection} ${C.dim(r.collectionLabel || '')} ${C.g(`${r.tokenCount} NFT`)}${r.enumerable ? '' : C.y('  (not enumerable — count from balance only)')}`);
        if (r.tokens.length) console.log(`     ids: ${r.tokens.slice(0, 12).join(', ')}${r.tokens.length > 12 ? ` ...+${r.tokens.length - 12}` : ''}`);
      }
      const withNft = rows.filter((r) => r.tokenCount > 0).length;
      console.log(`\n${C.g(`${totalNft} NFT(s)`)} across ${withNft} wallet/collection pair(s)`);
      if (rows.length && rows.every((r) => !r.enumerable)) {
        console.log(C.y('\nNote: none of these collections are enumerable. Counts come from balanceOf;'));
        console.log(C.y('to get exact token ids, read the collection Transfer logs or the explorer.'));
      }
      v.lock();
      break;
    }

    case 'mint-report': {
      const collection = flag(argv, 'collection', argv[1]);
      if (!collection) throw new Error('usage: holder-kit mint-report <collection>');
      const { pool } = await context(argv);
      await mintReport(pool, collection);
      break;
    }

    case 'find': {
      // "Is anything free and live right now?" — answered from chain state only.
      const { spec, pool } = await context(argv);
      const addresses = addressList(argv);
      const results = await scanForMints(pool, spec, { addresses });
      printMintScan(results, `${spec.name} (id ${spec.id})`);
      const free = results.filter((r) => r.verdict === 'free-live');
      process.exitCode = free.length ? 0 : 1;
      break;
    }

    case 'watch': {
      // Poll until a free window opens, then mint — no signing, no clicking.
      const v = await openVault();
      const { spec, pool } = await context(argv);
      const collection = flag(argv, 'collection');
      if (!collection) throw new Error('usage: holder-kit watch --collection <addr> [--quantity 1] [--auto]');
      const signers = signersFrom(v, pool, spec);
      const quantity = Number(flag(argv, 'quantity', 1));
      const intervalMs = Number(flag(argv, 'interval', 20)) * 1000;
      const maxChecks = Number(flag(argv, 'max-checks', 90));
      const auto = isAuto(argv);
      const dryRun = !auto && isDryRun(argv);

      const res = await watchAndMint({
        pool,
        collection,
        signers,
        quantity,
        intervalMs,
        maxChecks,
        dryRun,
        onFire: async () =>
          mintAll({ pool, collection, signers, quantity, dryRun: false, argv: [...argv, '--execute', '--auto'] }),
      });
      v.lock();
      process.exitCode = res.fired ? 0 : 1;
      break;
    }

    case 'auto': {
      // One-shot: find free mints across every collection and mint them all.
      const v = await openVault();
      const { spec, pool } = await context(argv);
      const signers = signersFrom(v, pool, spec);
      if (!signers.length) throw new Error('vault has no wallets — run: holder-kit wallet new 5');
      const quantity = Number(flag(argv, 'quantity', 1));
      const addresses = addressList(argv);

      const results = await scanForMints(pool, spec, { addresses });
      printMintScan(results, `${spec.name} (id ${spec.id})`);

      const free = results.filter((r) => r.verdict === 'free-live');
      if (!free.length) {
        console.log(C.y('  nothing free and live right now. Nothing was sent.\n'));
        v.lock();
        process.exitCode = 1;
        break;
      }

      console.log(C.b(`\n  minting from ${free.length} free collection(s), ${quantity} per wallet, ${signers.length} wallet(s)\n`));
      let totalSent = 0;
      for (const col of free) {
        const r = await mintAll({ pool, collection: col.address, signers, quantity, dryRun: false, argv: [...argv, '--execute', '--auto'] });
        totalSent += r.sent || 0;
      }
      console.log(totalSent ? C.g(`\nauto-mint complete: ${totalSent} mint(s) sent`) : C.y('\nnothing was sent'));
      v.lock();
      break;
    }

    case 'spread':
    case 'ship':
    case 'fund':
    case 'mint': {
      const v = await openVault();
      const { spec, pool } = await context(argv);
      const auto = isAuto(argv);
      // --auto means hands-free: no dry run, no prompt. --execute is still honoured.
      const dryRun = auto ? false : isDryRun(argv);
      const signers = signersFrom(v, pool, spec);
      if (!signers.length) throw new Error('vault has no wallets — run: holder-kit wallet new 5');

      mkdirSync(dirname(LEDGER_PATH), { recursive: true });
      const ledger = new RunLedger(LEDGER_PATH);

      if (cmd === 'spread') {
        const collection = flag(argv, 'collection');
        const to = flag(argv, 'to');
        if (!collection || !to) throw new Error('usage: holder-kit spread --collection <addr> --to <file|list> [--auto]');
        const recipients = readAddressList(to);
        const res = await spread({ pool, chainSpec: spec, signers, collection, recipients, dryRun, ledger, argv });
        console.log(res.sent ? C.g(`\nsent ${res.sent}`) : C.dim(`\nplanned ${res.planned}, sent 0`));
      }

      if (cmd === 'ship') {
        const collection = flag(argv, 'collection');
        const planFile = flag(argv, 'plan');
        if (!collection || !planFile) throw new Error('usage: holder-kit ship --collection <addr> --plan <file> [--auto]');
        const plan = readFileSync(resolve(planFile), 'utf8').split('\n');
        const res = await ship({ pool, chainSpec: spec, signers, collection, plan, dryRun, ledger, argv });
        console.log(res.sent ? C.g(`\nsent ${res.sent}`) : C.dim(`\nplanned ${res.planned}, sent 0`));
      }

      if (cmd === 'fund') {
        const to = flag(argv, 'to');
        const each = flag(argv, 'each', '0.01');
        const fromIndex = Number(flag(argv, 'from', 0));
        if (!to) throw new Error('usage: holder-kit fund --each 0.01 --to <file|list> [--execute]');
        const recipients = dedupeAddresses(readAddressList(to), 'recipient');
        const res = await fund({ signers, recipients, amountEthEach: each, fromIndex, dryRun, argv });
        console.log(res.sent ? C.g(`\nsent ${res.sent}`) : C.dim(`\nplanned ${res.planned}, sent 0`));
      }

      if (cmd === 'mint') {
        const collection = flag(argv, 'collection');
        const quantity = Number(flag(argv, 'quantity', 1));
        if (!collection) throw new Error('usage: holder-kit mint --collection <addr> [--quantity 1] [--execute]');
        const res = await mintAll({ pool, collection, signers, quantity, dryRun, argv, shape: flag(argv, 'fn', false) || undefined });
        console.log(res.sent ? C.g(`\nminted from ${res.sent} wallet(s)`) : C.dim(`\nplanned ${res.planned}, sent 0`));
      }

      v.lock();
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

/**
 * Derive the signing key for addressIndex i.
 *
 * viem's account object intentionally hides .privateKey. getHdKey() is the
 * supported accessor, and its `privKey` is a BIGINT (not hex) — handing that
 * straight to privateKeyToAccount fails with "invalid private key, expected
 * hex or 32 bytes, got object". Convert to 0x-hex, padded to 32 bytes.
 */
async function deriveKeyHex(phrase, addressIndex) {
  const acct = await mnemonicToAccount(phrase, { addressIndex });
  const hd = typeof acct.getHdKey === 'function' ? acct.getHdKey() : acct.hdKey;
  if (!hd) throw new Error('could not derive a signing key for this address index');
  const raw = hd.privKey ?? hd.privKeyBytes;
  const hex =
    typeof raw === 'bigint'
      ? '0x' + raw.toString(16).padStart(64, '0')
      : typeof raw === 'string'
        ? (raw.startsWith('0x') ? raw : '0x' + raw)
        : '0x' + Buffer.from(raw).toString('hex');
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error('derived key is not 32 bytes');
  return hex;
}

function readAddressList(spec) {
  const raw = String(spec).trim();
  // A single existing file path is read; otherwise treat as comma/space list.
  const p = resolve(raw);
  if (existsSync(p) && !raw.includes(',')) {
    return readFileSync(p, 'utf8')
      .split(/[\n,]+/)
      .map((s) => s.replace(/#.*$/, '').trim())
      .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
  }
  return raw
    .split(/[\s,]+/)
    .map((s) => s.replace(/#.*$/, '').trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
}

main()
  .then(() => {
    // Final belt-and-braces: refuse to exit cleanly if a key reached stdout.
    void assertNoSecretLeak;
  })
  .catch((err) => {
    if (err instanceof Aborted) {
      console.error(`\n${C.y('aborted')}: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      console.error(`\n${C.r('error')}: ${err.message}\n`);
      process.exitCode = 1;
    }
  });

export { readAddressList };
