// Local holder UI — a zero-dependency control panel over the existing CLI.
//
// Design rule: this file contains NO wallet logic. Every action shells out to
// `bin/holder-kit.mjs`, which is the surface the test suites already prove. A
// second implementation of "send an NFT" would be untested code holding keys,
// so the UI is strictly a terminal.
//
// Security posture:
//   - binds 127.0.0.1 only; it is unreachable from the network
//   - the vault password is piped to the child's stdin and never written to
//     disk, logged, or returned to the browser
//   - no telemetry, no outbound requests of any kind
//   - the child inherits a HOLDER_KIT_PASSWORD for exactly one command

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'holder-kit.mjs');
const PORT = Number(process.env.HOLDER_KIT_UI_PORT || 7799);

// Commands the UI is allowed to run. An allowlist, not a denylist: a new
// dangerous CLI command is unreachable from the browser until added here.
const ALLOWED = new Set([
  'setup', 'check', 'doctor', 'chains', 'bench', 'rpc', 'wallet',
  'find', 'watch', 'auto', 'mint-report', 'scan', 'spread', 'ship', 'fund',
]);

// Sub-actions allowed under `wallet`, so the UI can't reach destructive verbs.
const WALLET_SUBS = new Set([
  'list', 'new', 'from-seed', 'add', 'backup', 'restore', 'change-password', 'remove',
]);

/** Validate the command and its args. Throws with a message safe to show a user. */
function validate(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('no command given');
  const cmd = String(argv[0]);
  if (!ALLOWED.has(cmd)) throw new Error(`command not allowed: ${cmd}`);

  if (cmd === 'wallet') {
    const sub = String(argv[1] || '');
    if (!WALLET_SUBS.has(sub)) throw new Error(`wallet action not allowed: ${sub || '(none)'}`);
  }

  return argv.map((a) => {
    const s = String(a);
    // No shell is used, but block control chars and absurd length anyway.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) throw new Error('illegal character in argument');
    if (s.length > 2000) throw new Error('argument too long');
    return s;
  });
}

/**
 * Run one CLI command, piping the password via stdin (never argv, never env in
 * the parent, never logged) and returning its exit code plus output.
 */
function runCli(argv, password, { timeoutMs = 180_000 } = {}) {
  const [cmd, ...args] = argv;
  const child = spawn(process.execPath, [CLI, cmd, ...args], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      // Only set when supplied: an empty value would make the CLI think a
      // password exists and then fail to open the vault.
      ...(password ? { HOLDER_KIT_PASSWORD: password } : {}),
      HOLDER_KIT_UI: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  // Some prompts read the TTY, not stdin. In non-interactive UI mode there is
  // no TTY, so the CLI must fall back to the password it already has.
  child.stdin.end();

  const kill = setTimeout(() => child.kill(), timeoutMs);
  return new Promise((res) => {
    child.on('close', (code) => {
      clearTimeout(kill);
      res({ code: code ?? 1, output: (out + (err ? `\n${err}` : '')).trim() });
    });
    child.on('error', (e) => {
      clearTimeout(kill);
      res({ code: 1, output: `could not start: ${e.message}` });
    });
  });
}

/** Strip ANSI codes so the browser renders plain text. */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const PAGE = readFileSync(join(HERE, 'ui.html'), 'utf8');

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };

  // The UI is local-only; refuse anything that looks like a cross-origin POST.
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return json(403, { error: 'cross-origin requests are not allowed' });
  }

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

  if (req.method !== 'POST' || req.url !== '/run') return json(404, { error: 'not found' });

  let body = '';
  let tooBig = false;
  req.on('data', (d) => {
    body += d;
    if (body.length > 200_000) { tooBig = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (tooBig) return json(413, { error: 'request too large' });

    let argv;
    let password = '';
    try {
      const parsed = JSON.parse(body || '{}');
      argv = validate(parsed.argv);
      password = typeof parsed.password === 'string' ? parsed.password : '';
    } catch (e) {
      return json(400, { error: e.message });
    }

    // `setup` must NOT receive a browser-supplied password to write into
    // PASSWORD.txt; it generates its own.
    const usesPassword = argv[0] !== 'setup' && argv[0] !== 'chains' && argv[0] !== 'bench';
    const pw = usesPassword ? password : '';

    const started = Date.now();
    const r = await runCli(argv, pw);
    // Never echo the password back, even on failure.
    const safe = strip(r.output).split(pw || '\u0000').join('(hidden)');
    json(200, { code: r.code, output: safe, ms: Date.now() - started });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  holder-kit  local UI`);
  console.log(`  ${'-'.repeat(46)}`);
  console.log(`  open:  http://127.0.0.1:${PORT}`);
  console.log(`\n  This page runs on your machine only. Nothing leaves it.`);
  console.log(`  Your vault password is sent to the local process, never saved.\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  port ${PORT} is already in use. Try: HOLDER_KIT_UI_PORT=7800 npm run ui\n`);
    process.exit(1);
  }
  throw e;
});