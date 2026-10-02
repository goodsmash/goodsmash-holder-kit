// End-to-end test of the local UI in a real browser, against a real local chain.
//
// Nothing is mocked: anvil runs the chain, forge deploys real contracts, the
// real server serves the real page, and a real Chromium clicks through every
// screen. Every value-moving action is then checked ON CHAIN, not in the UI.
//
//   npm run test:e2e                 # needs Foundry (anvil, forge, cast) + Playwright
//   E2E_ROUNDS=3 npm run test:e2e    # run the whole flow several times
//   E2E_SHOTS=/tmp/shots npm run test:e2e   # also save screenshots of every page
//
// Playwright is not a dependency of holder-kit (keep installs small). This test
// uses it if it can find it: `npm i -D playwright` or a global install.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_PORT = 8545; // the built-in `local` chain points here
const RPC = `http://127.0.0.1:${CHAIN_PORT}`;
const UI_PORT = 7861;
const UI = `http://127.0.0.1:${UI_PORT}`;
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ROUNDS = Number(process.env.E2E_ROUNDS || 1);
const SHOTS = process.env.E2E_SHOTS || '';

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

async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', 'playwright-core'];
  for (const t of tries) {
    try {
      return req(t);
    } catch {
      /* next */
    }
  }
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
  for (const base of [process.env.PLAYWRIGHT_PATH, npmRoot && join(npmRoot, 'playwright'), '/opt/node22/lib/node_modules/playwright'].filter(Boolean)) {
    if (existsSync(base)) return req(base);
  }
  return null;
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const balance = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const ETH = 10n ** 18n;
function cast(...args) {
  const r = spawnSync('cast', [...args, '--rpc-url', RPC], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cast ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const castUint = (...a) => BigInt(cast('call', ...a).split(/\s/)[0]);
function deploy(file, name) {
  const r = spawnSync('forge', ['create', `${join(ROOT, 'test', 'fixtures', file)}:${name}`, '--rpc-url', RPC, '--private-key', ANVIL_KEY, '--broadcast'], { encoding: 'utf8', cwd: ROOT });
  const m = ((r.stdout || '') + (r.stderr || '')).match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`deploy ${name} failed: ${(r.stderr || '').slice(0, 300)}`);
  return m[1];
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, ...env, HOLDER_KIT_UI_PORT: String(UI_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes(`127.0.0.1:${UI_PORT}`)) resolve(child);
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15000);
  });
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.log('\n  SKIPPED: Playwright not found. Install it with `npm i -D playwright && npx playwright install chromium`.\n');
    return;
  }
  for (const bin of ['anvil', 'forge', 'cast']) {
    if (spawnSync(bin, ['--version']).status !== 0) throw new Error(`${bin} not found — install Foundry: https://getfoundry.sh`);
  }
  try {
    await rpc('eth_chainId');
    throw new Error(`something is already listening on ${CHAIN_PORT}; stop it first (the e2e test starts its own anvil)`);
  } catch (e) {
    if (/already listening/.test(e.message)) throw e;
  }

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n\x1b[1m===== UI end-to-end, round ${round}/${ROUNDS} =====\x1b[0m`);
    await oneRound(pw, round);
  }
  console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed${ROUNDS > 1 ? ` (${ROUNDS} rounds)` : ''}`);
  if (failures.length) failures.forEach((f) => console.log(`   - ${f}`));
  console.log(`${'='.repeat(50)}\n`);
  process.exitCode = fail ? 1 : 0;
}

async function oneRound(pw, round) {
  const tmp = mkdtempSync(join(tmpdir(), 'hk-e2e-'));
  const env = {
    HOLDER_KIT_VAULT: join(tmp, 'vault', 'holder.vault'),
    HOLDER_KIT_ENDPOINTS: join(tmp, 'endpoints.json'),
    HOLDER_KIT_LEDGER: join(tmp, 'ledger.jsonl'),
    HOLDER_KIT_PASSWORD: '',
    HOLDER_KIT_PASSWORD_FILE: '',
    HOLDER_KIT_AGENT: '',
    HOLDER_KIT_AUTO: '',
    HOLDER_KIT_CHAIN: '',
  };
  const anvil = spawn('anvil', ['--port', String(CHAIN_PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch {
      await sleep(250);
    }
  }
  let server;
  let browser;
  try {
    const free = deploy('MockFreeMint.sol', 'MockFreeMint');
    const rigs = deploy('MockRigs.sol', 'MockRigs');
    const evil = deploy('EvilName.sol', 'EvilName');
    server = await startServer(env);
    browser = await pw.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

    const idle = () => page.waitForFunction(() => !document.querySelector('#conDot.spin') && !document.querySelector('.spinner') && !/Checking/.test(document.getElementById('statusText').textContent), null, { timeout: 120_000 });
    const conText = () => page.textContent('#conOut');
    const nav = async (p) => { await page.click(`#nav button[data-page="${p}"]`); await page.waitForSelector(`#page-${p}.on`); };
    const liveMode = async (on) => page.click(on ? '#modeLive' : '#modeDry');
    const confirmModal = async (accept) => {
      await page.waitForSelector('#scrim.on');
      await page.click(accept ? '#mYes' : '#mNo');
      await page.waitForSelector('#scrim.on', { state: 'detached' }).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('scrim').classList.contains('on'));
    };

    // ------------------------------------------------------------ onboarding
    section('first run: onboarding and one-click setup');
    await page.goto(UI);
    await page.waitForFunction(() => document.querySelectorAll('#chain option').length > 1);
    await page.selectOption('#chain', 'local');
    await idle();
    ok('onboarding card shows when there is no vault', await page.isVisible('#onboard'));
    ok('status says Not set up', (await page.textContent('#statusText')).includes('Not set up'));
    await page.fill('#setupN', '3');
    await page.click('#setupBtn');
    await page.waitForFunction(() => /Ready|Needs attention/.test(document.getElementById('statusText').textContent) && !document.querySelector('#conDot.spin'), null, { timeout: 120_000 });
    await idle();
    ok('setup creates the vault and the dashboard appears', !(await page.isVisible('#onboard')) && (await page.isVisible('#dash')));
    ok('status is Ready', (await page.textContent('#statusText')).trim() === 'Ready', await page.textContent('#statusText'));
    ok('dashboard counts 3 wallets', (await page.textContent('#tWallets')).trim() === '3');
    ok('vault unlocked from PASSWORD.txt with no password typed', /password file/.test(await page.textContent('#tVaultD')));
    ok('password file written', existsSync(join(tmp, 'vault', 'PASSWORD.txt')));

    // ------------------------------------------------------------ wallets
    section('wallets: table, balances, generate, backup, restore');
    await nav('wallets');
    await page.waitForSelector('#wBody tr td .addr');
    const addrs = await page.$$eval('#wBody .addr .full', (els) => els.map((e) => e.textContent));
    ok('wallet table lists 3 addresses', addrs.length === 3 && addrs.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)));
    ok('no private key anywhere in the page', !/0x[0-9a-fA-F]{64}/.test(await page.content()));
    await rpc('anvil_setBalance', [addrs[0], '0x' + (10n * ETH).toString(16)]);
    await page.click('#wRefresh');
    await page.waitForFunction(() => /10 ETH/.test(document.getElementById('wBody').textContent));
    ok('refresh shows the live 10 ETH balance', true);
    await page.fill('#wN', '2');
    await page.click('#wNew');
    await page.waitForFunction(() => document.querySelectorAll('#wBody .addr').length === 5, null, { timeout: 60_000 });
    ok('generate adds 2 wallets (5 total)', true);
    const bk = join(tmp, 'usb', 'holder.vault');
    mkdirSync(dirname(bk), { recursive: true });
    await page.click('#bkSave');
    ok('empty backup path is rejected in the page', await page.$eval('#bkPath', (e) => e.classList.contains('bad')));
    await page.fill('#bkPath', bk);
    await page.click('#bkSave');
    await idle();
    ok('backup written to the chosen path', existsSync(bk));
    await page.click('#bkRestore');
    await idle();
    ok('restore from that backup merges without duplicates', /restored 0 wallet/.test(await conText()) && (await page.$$('#wBody .addr')).length === 5);
    const allAddrs = await page.$$eval('#wBody .addr .full', (els) => els.map((e) => e.textContent));

    // ------------------------------------------------------------ gas
    section('gas: preview, cancel, live top-up, idempotent re-run');
    await nav('gas');
    await page.fill('#gEach', '0.01');
    await page.click('#gFund');
    await idle();
    ok('preview mode is a dry run', /DRY RUN/.test(await conText()) && (await balance(allAddrs[1])) === 0n);
    await liveMode(true);
    ok('live mode shows the red banner', await page.isVisible('.livebar'));
    ok('button relabels to "Send top-up"', (await page.textContent('#gFund')).includes('Send top-up'));
    await page.click('#gFund');
    await confirmModal(false);
    await sleep(300);
    ok('cancelling the confirm sends nothing', (await balance(allAddrs[1])) === 0n);
    await page.click('#gFund');
    await confirmModal(true);
    await idle();
    const funded = await Promise.all(allAddrs.slice(1).map(balance));
    ok('live top-up funded every other wallet to 0.01', funded.every((b) => b === ETH / 100n), funded.join(','));
    const srcBefore = await balance(allAddrs[0]);
    await page.click('#gFund');
    await confirmModal(true);
    await idle();
    ok('running it again sends nothing', (await balance(allAddrs[0])) === srcBefore && /already holds the target/.test(await conText()));
    await page.fill('#gEach', '0.2');
    await page.click('#gFund');
    await confirmModal(true);
    await idle();
    ok('ceiling refusal is surfaced', /ceiling exceeded/.test(await conText()));
    await page.fill('#gEach', 'abc');
    await page.click('#gFund');
    ok('bad amount is caught before anything runs', await page.$eval('#gEach', (e) => e.classList.contains('bad')));
    await page.fill('#gEach', '0.01');
    await liveMode(false);

    // ------------------------------------------------------------ mints
    section('free mints: scan, preview, live mint, XSS-safe rendering');
    await nav('mints');
    await page.fill('#mColl', 'not-an-address');
    await page.click('#mScan');
    ok('invalid collection address is flagged', await page.$eval('#mColl', (e) => e.classList.contains('bad')));
    await page.fill('#mColl', free);
    await page.click('#mScan');
    await page.waitForSelector('.mint');
    await idle();
    ok('scan renders a FREE · LIVE card', /FREE · LIVE/.test(await page.textContent('#mResults')));
    await page.click('.mint [data-mintbtn]');
    await idle();
    ok('preview mint sends nothing', castUint(free, 'totalMinted()(uint256)') === 0n);
    await liveMode(true);
    ok('mint card button relabels to "Mint now"', (await page.textContent('.mint [data-mintbtn]')).includes('Mint now'));
    await page.click('.mint [data-mintbtn]');
    await confirmModal(true);
    await idle();
    const minted = castUint(free, 'totalMinted()(uint256)');
    ok('live mint minted from all 5 wallets, verified on chain', minted === 5n, `totalMinted=${minted}`);
    await liveMode(false);

    await page.fill('#mColl', evil);
    await page.click('#mScan');
    await page.waitForSelector('.mint');
    await idle();
    const xss = await page.evaluate(() => window.__hkXss);
    ok('HTML in a token name is shown as text, never executed', xss === undefined && (await page.textContent('#mResults')).includes('<img src=x'));

    // watch + stop + write lock
    cast('send', free, 'setPrice(uint256)', '1000', '--private-key', ANVIL_KEY);
    await page.fill('#wColl', free);
    await page.fill('#wInt', '5');
    await page.fill('#wMax', '200');
    await page.click('#wStart');
    await page.waitForFunction(() => /check 1\//.test(document.getElementById('conOut').textContent), null, { timeout: 60_000 });
    ok('watch streams progress live', true);
    ok('other write actions are locked while it runs', await page.$eval('#wStart', (b) => b.disabled));
    await page.click('#conCancel');
    await page.waitForFunction(() => /stopped/.test(document.getElementById('conOut').textContent), null, { timeout: 30_000 });
    ok('Stop ends the watch', true);
    ok('write actions unlock after stopping', !(await page.$eval('#wStart', (b) => b.disabled)));
    ok('Stop button disappears once nothing is running', !(await page.isVisible('#conCancel')));

    // ------------------------------------------------------------ send
    section('send NFTs: spread and specific transfers, verified on chain');
    cast('send', rigs, 'mint(address,uint256)', allAddrs[0], '4', '--private-key', ANVIL_KEY);
    await nav('send');
    const r1 = '0x' + 'a1'.repeat(20);
    const r2 = '0x' + 'b2'.repeat(20);
    await page.fill('#sColl', rigs);
    await page.fill('#sTo', `${r1}\n${r2}\n${r1}\nnope`);
    ok('recipient counter flags duplicates and junk', /2 valid/.test(await page.textContent('#sToCount')) && /1 duplicate/.test(await page.textContent('#sToCount')) && /not an address/.test(await page.textContent('#sToCount')));
    await page.click('#sSpread');
    ok('spread refuses a list with junk in it', await page.$eval('#sTo', (e) => e.classList.contains('bad')));
    await page.fill('#sTo', `${r1}\n${r2}`);
    // keep one token back for the ship test: send 3 via spread? spread sends all; mint the ship token after.
    await page.click('#sSpread');
    await idle();
    ok('spread preview sends nothing', castUint(rigs, 'balanceOf(address)(uint256)', r1) === 0n);
    await liveMode(true);
    await page.click('#sSpread');
    await confirmModal(true);
    await idle();
    const b1 = castUint(rigs, 'balanceOf(address)(uint256)', r1);
    const b2 = castUint(rigs, 'balanceOf(address)(uint256)', r2);
    ok('spread dealt all 4 NFTs round-robin', b1 === 2n && b2 === 2n, `${b1}/${b2}`);
    await page.click('#sSpread');
    await confirmModal(true);
    await idle();
    ok('re-running spread sends nothing more', castUint(rigs, 'balanceOf(address)(uint256)', r1) === 2n);

    cast('send', rigs, 'mint(address,uint256)', allAddrs[1], '1', '--private-key', ANVIL_KEY);
    const tid = castUint(rigs, 'tokenOfOwnerByIndex(address,uint256)(uint256)', allAddrs[1], '0');
    await page.click('.tabs button[data-tab="ship"]');
    await page.fill('#sPlan', `# comment\n${allAddrs[1]} ${tid} ${r2}\n`);
    ok('plan counter understands the plan', /1 transfer/.test(await page.textContent('#sPlanCount')));
    await page.click('#sShip');
    await confirmModal(true);
    await idle();
    ok('specific transfer delivered, verified with ownerOf', cast('call', rigs, 'ownerOf(uint256)(address)', String(tid)).toLowerCase() === r2.toLowerCase());
    await liveMode(false);
    await page.click('.tabs button[data-tab="hold"]');
    await page.click('#sScan');
    await idle();
    ok('holdings scan renders (no watched collections on local → empty state)', /No NFTs found|Token ids/.test(await page.textContent('#sHold')));

    // ------------------------------------------------------------ rpc
    section('RPC: add, speed test, doctor');
    await nav('rpc');
    await page.fill('#rUrl', 'ftp://nope');
    await page.click('#rAdd');
    ok('non-http RPC rejected in the page', await page.$eval('#rUrl', (e) => e.classList.contains('bad')));
    await page.fill('#rUrl', `http://localhost:${CHAIN_PORT}`);
    await page.fill('#rName', 'second');
    await page.click('#rAdd');
    await page.waitForSelector('#rOut table');
    await idle();
    ok('added RPC appears in the speed test', /second/.test(await page.textContent('#rOut')) && existsSync(env.HOLDER_KIT_ENDPOINTS));
    ok('URL field cleared after adding (keys do not linger)', (await page.inputValue('#rUrl')) === '');
    await page.click('#rDoctor');
    await page.waitForSelector('#rOut .kv');
    await idle();
    ok('doctor proves failover with 2 endpoints', /Failover: proven/.test(await page.textContent('#rOut')));

    // ------------------------------------------------------------ activity, keys, theme, password
    section('activity, keyboard, theme, wrong password');
    await nav('activity');
    const items = await page.$$('.act-item');
    ok('activity lists the session\'s runs', items.length > 10, `${items.length} runs`);
    await items[items.length - 1].click();
    ok('clicking a run reopens its output', !(await page.$eval('#console', (c) => c.classList.contains('collapsed'))));
    await page.click('body');
    await page.keyboard.press('3');
    ok('pressing 3 opens Free mints', await page.isVisible('#page-mints.on'));
    await page.fill('#mColl', free);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForSelector('.mint');
    await idle();
    ok('Ctrl/⌘+Enter runs the page\'s main action', /PAID · LIVE/.test(await page.textContent('#mResults')));
    await page.click('#theme button[data-v="light"]');
    ok('light theme applies', (await page.getAttribute('html', 'data-theme')) === 'light');
    await page.click('#theme button[data-v="auto"]');

    await page.fill('#pw', 'definitely-wrong-password');
    await nav('home');
    await page.click('#recheck');
    await idle();
    ok('a wrong typed password is reported, not hidden', /Locked/.test(await page.textContent('#tVault')));
    await page.fill('#pw', '');
    await page.click('#recheck');
    await idle();
    await sleep(400); // the field's change event schedules one more refresh
    await idle();
    ok('clearing it falls back to PASSWORD.txt', (await page.textContent('#statusText')).trim() === 'Ready', `${await page.textContent('#statusText')} / ${await page.textContent('#tVault')} / ${await page.textContent('#tRpcD')}`);

    // ------------------------------------------------------------ layout on every screen size
    section('layout: no sideways scrolling, at phone to desktop sizes');
    for (const [w, hgt, label] of [[390, 844, 'phone'], [820, 1180, 'tablet'], [1280, 720, 'small laptop'], [1440, 900, 'MacBook'], [1920, 1080, 'desktop']]) {
      await page.setViewportSize({ width: w, height: hgt });
      let worst = 0;
      for (const p of ['home', 'wallets', 'mints', 'send', 'gas', 'rpc', 'activity']) {
        await page.evaluate((x) => { location.hash = x; }, p);
        await page.click(`#nav button[data-page="${p}"]`);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        worst = Math.max(worst, over);
        if (SHOTS && (w === 1440 || w === 390)) {
          mkdirSync(SHOTS, { recursive: true });
          await sleep(250); // let the page fade-in finish
          await page.screenshot({ path: join(SHOTS, `r${round}-${label}-${p}.png`), fullPage: w === 390 });
        }
      }
      ok(`${label} (${w}px): every page fits`, worst <= 1, `overflow ${worst}px`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    if (SHOTS) {
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const p of ['home', 'wallets', 'mints', 'rpc']) {
        await page.click(`#nav button[data-page="${p}"]`);
        await sleep(250);
        await page.screenshot({ path: join(SHOTS, `r${round}-dark-${p}.png`) });
      }
      await page.emulateMedia({ colorScheme: 'light' });
      for (const p of ['home', 'mints']) {
        await page.click(`#nav button[data-page="${p}"]`);
        await sleep(250);
        await page.screenshot({ path: join(SHOTS, `r${round}-light-${p}.png`) });
      }
    }

    // A fresh browser opening #wallets first loads the DEFAULT chain (offline
    // here), then the holder switches chain. The slow, stale answer must not
    // overwrite the fresh one (it used to show every balance as "unknown").
    section('chain switch race');
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => pageErrors.push(e.message));
    await p2.goto(`${UI}/#wallets`);
    await p2.waitForFunction(() => document.querySelectorAll('#chain option').length > 1);
    await p2.selectOption('#chain', 'local');
    await p2.waitForSelector('#wBody .addr');
    await sleep(25_000); // longer than the offline default chain takes to fail
    const txt = await p2.textContent('#wBody');
    ok('a stale chain answer never overwrites the current one', !/unknown/.test(txt) && /ETH/.test(txt));
    ok('phone layout shows short addresses', await p2.isVisible('#wBody .addr .sh'));
    await ctx2.close();

    ok('no JavaScript errors in the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
    anvil.kill();
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
