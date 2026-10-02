// Local holder UI — a zero-dependency control panel over the existing CLI.
//
// Design rule: this file contains NO wallet logic. Every action shells out to
// `bin/holder-kit.mjs`, which is the surface the test suites already prove. A
// second implementation of "send an NFT" would be untested code holding keys,
// so the UI is strictly a terminal with a nicer face.
//
// Security posture:
//   - binds 127.0.0.1 only; it is unreachable from the network
//   - every POST needs a per-launch token embedded in the page, a JSON content
//     type, a same-origin Origin (when sent) and a 127.0.0.1/localhost Host
//   - the vault password is handed to ONE child process and never written to
//     disk, logged, or returned to the browser
//   - only one value-moving command runs at a time (no nonce races)
//   - no telemetry, no outbound requests of any kind
//
//   node src/server.mjs [--open] [--port 7799]
//   HOLDER_KIT_UI_PORT=7800    pick a port (otherwise 7799, or the next free one)
//   HOLDER_KIT_UI_NO_OPEN=1    never open a browser, even with --open

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'holder-kit.mjs');
const ARGV = process.argv.slice(2);
const argVal = (name) => {
  const i = ARGV.indexOf(`--${name}`);
  return i === -1 ? undefined : ARGV[i + 1];
};
const EXPLICIT_PORT = argVal('port') || process.env.HOLDER_KIT_UI_PORT;
const START_PORT = Number(EXPLICIT_PORT || 7799);
const WANT_OPEN = ARGV.includes('--open') && process.env.HOLDER_KIT_UI_NO_OPEN !== '1';

// Commands the UI is allowed to run. An allowlist, not a denylist: a new
// dangerous CLI command is unreachable from the browser until added here.
const ALLOWED = new Set([
  'setup', 'check', 'doctor', 'chains', 'bench', 'rpc', 'wallet',
  'find', 'watch', 'auto', 'mint-report', 'scan', 'spread', 'ship', 'fund', 'mint',
]);

// Sub-actions allowed under `wallet`. `remove` and `change-password` are
// deliberately absent: both are destructive or lock-out risks and belong in the
// holder's own terminal.
const WALLET_SUBS = new Set(['list', 'new', 'from-seed', 'add', 'backup', 'restore']);

// Commands that can change state (vault, config, or the chain). Only one of
// these runs at a time: two sends from the same wallet in parallel would race
// for the same nonce.
const READ_ONLY = new Set(['check', 'doctor', 'chains', 'bench', 'find', 'mint-report', 'scan']);
function isMutating(argv) {
  const [cmd, sub] = argv;
  if (READ_ONLY.has(cmd)) return false;
  if (cmd === 'wallet' && sub === 'list') return false;
  if (cmd === 'rpc' && sub !== 'add') return false;
  return true;
}

function timeoutFor(cmd) {
  if (cmd === 'watch') return 3 * 60 * 60_000; // a watch can legitimately wait hours
  if (['auto', 'spread', 'ship', 'fund', 'mint'].includes(cmd)) return 45 * 60_000;
  return 5 * 60_000;
}

/** Validate the command and its args. Throws with a message safe to show a user. */
function validate(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('no command given');
  if (argv.length > 64) throw new Error('too many arguments');
  const cmd = String(argv[0]);
  if (!ALLOWED.has(cmd)) throw new Error(`command not allowed: ${cmd}`);

  if (cmd === 'wallet') {
    const sub = String(argv[1] || '');
    if (!WALLET_SUBS.has(sub)) throw new Error(`wallet action not allowed: ${sub || '(none)'}`);
  }

  return argv.map((a, i) => {
    const s = String(a);
    // No shell is used, but block control chars and absurd length anyway.
    // (\t \n \r are allowed: an inline ship plan is multi-line.) Only the
    // value of --to / --plan may be long: a 500-line plan is ~50 KB.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new Error('illegal character in argument');
    const big = i > 0 && (argv[i - 1] === '--to' || argv[i - 1] === '--plan');
    if (s.length > (big ? 60_000 : 2000)) throw new Error('argument too long');
    return s;
  });
}

/** Strip ANSI codes so the browser renders plain text. */
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const jobs = new Map(); // id -> { child, argv, mutating, startedAt }
let writer = null; // id of the running mutating job, if any

/**
 * Start one CLI command. The password goes to exactly this child via its
 * environment (never argv, never the parent's env, never logged).
 */
function startCli(argv, password, { onData, onEnd }) {
  const [cmd, ...args] = argv;
  const id = randomBytes(8).toString('hex');
  const child = spawn(process.execPath, [CLI, cmd, ...args], {
    cwd: join(HERE, '..'),
    env: {
      ...process.env,
      // Only set when supplied: an empty value would hide vault/PASSWORD.txt.
      ...(password ? { HOLDER_KIT_PASSWORD: password } : {}),
      HOLDER_KIT_UI: '1',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // No TTY: the CLI must use the password it already has, never prompt.
  child.stdin.end();

  const mutating = isMutating(argv);
  const job = { id, child, argv, mutating, startedAt: Date.now(), canceled: false };
  jobs.set(id, job);
  if (mutating) writer = id;

  const scrub = (s) => {
    let out = strip(s);
    if (password) out = out.split(password).join('(hidden)');
    return out;
  };
  child.stdout.on('data', (d) => onData('stdout', scrub(d.toString())));
  child.stderr.on('data', (d) => onData('stderr', scrub(d.toString())));

  const kill = setTimeout(() => {
    job.timedOut = true;
    child.kill();
  }, timeoutFor(cmd));

  let ended = false;
  const finish = (code, extra = {}) => {
    if (ended) return;
    ended = true;
    clearTimeout(kill);
    jobs.delete(id);
    if (writer === id) writer = null;
    onEnd({ code: code ?? 1, ms: Date.now() - job.startedAt, canceled: job.canceled, timedOut: !!job.timedOut, ...extra });
  };
  child.on('close', (code) => finish(code));
  child.on('error', (e) => finish(1, { error: `could not start: ${e.message}` }));
  return job;
}

// A fresh secret per launch. It is embedded in the page and required on every
// POST. Cross-origin pages cannot read the page (same-origin policy), so they
// cannot learn it; together with the Host check this also defeats DNS
// rebinding, where an attacker's domain is re-pointed at 127.0.0.1.
const TOKEN = randomBytes(24).toString('hex');
const PAGE = readFileSync(join(HERE, 'ui.html'), 'utf8').replace(
  '<head>',
  `<head>\n<meta name="hk-token" content="${TOKEN}">`
);
let ALLOWED_HOSTS = new Set();

function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };

  // DNS-rebinding guard: the browser sends the name it THINKS it is talking to.
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    return json(403, { error: `bad Host header — open the UI at http://127.0.0.1:${server.address()?.port}` });
  }

  // The UI is local-only; refuse anything that looks like a cross-origin request.
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return json(403, { error: 'cross-origin requests are not allowed' });
  }

  const path = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS);
    return res.end();
  }

  if (req.method !== 'POST' || (path !== '/run' && path !== '/cancel')) {
    return json(404, { error: 'not found' });
  }

  // A JSON content type forces a CORS preflight for any cross-site caller, and
  // the token proves the request came from the page this server just served.
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return json(415, { error: 'content-type must be application/json' });
  }
  if (!tokenOk(req.headers['x-holder-kit-token'])) {
    return json(403, { error: 'missing or invalid UI token — reload the page' });
  }

  let parsed;
  try {
    parsed = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return json(e.status || 400, { error: e.status ? e.message : 'malformed JSON' });
  }

  if (path === '/cancel') {
    const job = jobs.get(String(parsed.id || ''));
    if (!job) return json(404, { error: 'no such running command' });
    job.canceled = true;
    job.child.kill();
    return json(200, { ok: true });
  }

  let argv;
  try {
    argv = validate(parsed.argv);
  } catch (e) {
    return json(400, { error: e.message });
  }

  if (isMutating(argv) && writer) {
    const w = jobs.get(writer);
    return json(409, { error: `another command is still running (${w ? w.argv.slice(0, 2).join(' ') : 'busy'}). Wait for it or cancel it first.` });
  }

  // `setup` must NOT receive a browser-supplied password; it generates its own
  // or uses vault/PASSWORD.txt. chains/bench never touch the vault.
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  const usesPassword = !['setup', 'chains', 'bench'].includes(argv[0]);
  const pw = usesPassword ? password : '';

  if (parsed.stream) {
    // Newline-delimited JSON, flushed as the CLI prints — long runs (watch,
    // auto across 20 wallets) show progress live instead of a frozen spinner.
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    const send = (obj) => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
    };
    const job = startCli(argv, pw, {
      onData: (stream, d) => send({ t: stream, d }),
      onEnd: (r) => {
        send({ t: 'end', ...r });
        res.end();
      },
    });
    send({ t: 'start', id: job.id, mutating: job.mutating });
    // Tab closed or navigated away: don't leave a watch loop running unseen.
    res.on('close', () => {
      if (jobs.has(job.id)) {
        job.canceled = true;
        job.child.kill();
      }
    });
    return;
  }

  let out = '';
  let err = '';
  startCli(argv, pw, {
    onData: (stream, d) => {
      if (stream === 'stdout') out += d;
      else err += d;
    },
    onEnd: (r) => json(200, { code: r.code, output: (out + (err ? `\n${err}` : '')).trim(), stdout: out, ms: r.ms }),
  });
});

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => console.log(`  (could not open a browser automatically — open the link above)`));
    p.unref();
  } catch {
    /* printed URL is enough */
  }
}

function listen(port, attemptsLeft) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && !EXPLICIT_PORT && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  port ${port} is already in use. Try: HOLDER_KIT_UI_PORT=${port + 1} npm run ui\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    ALLOWED_HOSTS = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
    const url = `http://127.0.0.1:${actual}`;
    console.log(`\n  holder-kit  local UI`);
    console.log(`  ${'-'.repeat(46)}`);
    console.log(`  open:  ${url}`);
    console.log(`\n  This page runs on your machine only. Nothing leaves it.`);
    console.log(`  Your vault password is sent to the local process, never saved.`);
    console.log(`  Press Ctrl+C here to stop.\n`);
    if (WANT_OPEN) openBrowser(url);
  });
}

function shutdown() {
  for (const j of jobs.values()) {
    j.canceled = true;
    try {
      j.child.kill();
    } catch {
      /* already gone */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

listen(START_PORT, 10);
