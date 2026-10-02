// Safety layer.
//
// The rule this file exists to enforce: nothing irreversible happens by
// accident. Dry-run is the DEFAULT for every money-moving command, an
// interactive confirmation is required to leave it, and there are hard ceilings
// that no flag can raise past an explicit --yes-i-am-sure double-confirm.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';

export const LIMITS = {
  // Per-transaction native outflow, in ETH. Raising requires DOUBLE_YES.
  maxPerTxEth: 0.05,
  // Total native outflow for one command run.
  maxPerRunEth: 0.5,
  // Max recipients in a single spread/ship.
  maxRecipients: 500,
};

export class Aborted extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'Aborted';
  }
}

export function isDryRun(argv) {
  // Dry run unless explicitly told otherwise.
  return !argv.includes('--execute') && !argv.includes('--yes');
}

/**
 * AUTO MODE — the holder signs nothing, ever.
 *
 * With `--auto` (or HOLDER_KIT_AUTO=1) every confirmation prompt is skipped and
 * transactions are signed locally from the vault. The holder's key never leaves
 * their machine and they never touch a hardware wallet or a popup.
 *
 * Safety survives auto mode: the per-tx and per-run ceilings still apply, and
 * the run ledger still prevents double-sending after a crash.
 */
export function isAuto(argv) {
  return argv.includes('--auto') || process.env.HOLDER_KIT_AUTO === '1';
}

export function wantsHelp(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

/** Read a yes/no from the terminal. Default is NO. */
export function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stderr.write('\n[abort] no interactive terminal; re-run with --execute to proceed non-interactively.\n');
      return resolve(false);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

export async function gateBroadcast({ dryRun, summary, argv, auto = false }) {
  if (!dryRun) return { proceeding: true, auto: true };

  console.log('\n================ DRY RUN — nothing was sent ================');
  console.log(summary);
  console.log('==============================================================');
  console.log('\nNothing has been broadcast. Re-run with --execute to send for real.\n');

  if (auto) {
    console.log('[auto] auto mode: proceeding without a prompt.\n');
    return { proceeding: true, auto: true };
  }
  if (argv.includes('--execute')) return { proceeding: true, auto: false };

  const ok = await confirm('Type y to actually send these transactions?');
  if (!ok) throw new Aborted('aborted at confirmation — no transaction was sent');
  return { proceeding: true, auto: false };
}

/** Ceiling check. Doubling past a limit needs an explicit override token. */
export function assertWithinLimits({ perTxEth, perRunEth, override }) {
  const problems = [];
  if (perTxEth > LIMITS.maxPerTxEth) problems.push(`single tx ${perTxEth} ETH > ${LIMITS.maxPerTxEth} ETH`);
  if (perRunEth > LIMITS.maxPerRunEth) problems.push(`run total ${perRunEth} ETH > ${LIMITS.maxPerRunEth} ETH`);
  if (!problems.length) return { ok: true };

  if (!override) {
    throw new Error(
      `safety ceiling exceeded:\n  - ${problems.join('\n  - ')}\n` +
        `Split the run, or pass --override-ceilings if you are certain.`
    );
  }
  process.stderr.write(`[safety] ceiling override accepted for: ${problems.join('; ')}\n`);
  return { ok: true, overridden: problems };
}

export function assertChainExpectation(chainSpec, argv) {
  if (!chainSpec.testnet) return { testnet: false };
  process.stderr.write(
    `[safety] chain "${chainSpec.key}" is a TESTNET. Assets on it have no value.\n`
  );
  if (!argv.includes('--i-know-this-is-testnet')) {
    throw new Aborted(
      `refusing to run against testnet "${chainSpec.key}" without --i-know-this-is-testnet`
    );
  }
  return { testnet: true };
}

export function validateAddress(addr, label = 'address') {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`invalid ${label}: ${addr}`);
  }
  return addr;
}

export function dedupeAddresses(list, label = 'address') {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const v = validateAddress(a, label);
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  if (out.length > LIMITS.maxRecipients) {
    throw new Error(`${out.length} ${label} values exceeds the ${LIMITS.maxRecipients} per-run ceiling`);
  }
  return out;
}

/** Resumable run log: never re-send something already confirmed. */
export class RunLedger {
  constructor(path) {
    this.path = path;
    this.done = new Map();
    try {
      if (existsSync(path)) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r.key && r.hash) this.done.set(r.key, r);
          } catch {
            /* skip a malformed line rather than abort a long run */
          }
        }
      }
    } catch {
      /* first run */
    }
  }

  has(key) {
    return this.done.has(key);
  }

  record(key, payload) {
    this.done.set(key, payload);
    appendFileSync(
      this.path,
      JSON.stringify({ key, ...payload, at: new Date().toISOString() }) + '\n'
    );
  }

  get size() {
    return this.done.size;
  }
}
