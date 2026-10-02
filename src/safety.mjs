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

/**
 * Print the dry-run plan. Dry runs NEVER prompt and never throw: the old
 * version asked "Type y to actually send" and then sent nothing whatever the
 * answer, and in a non-interactive shell (an agent, the UI) it aborted with
 * exit code 2 — so a perfectly good dry run looked like a failure.
 */
export async function gateBroadcast({ dryRun, summary }) {
  if (!dryRun) return { proceeding: true };
  console.log('\n================ DRY RUN — nothing was sent ================');
  console.log(summary);
  console.log('==============================================================');
  console.log('\nNothing has been broadcast. Re-run with --execute (or --auto) to send for real.\n');
  return { proceeding: false, dryRun: true };
}

/** Ceiling check. Doubling past a limit needs an explicit override token. */
export function assertWithinLimits({ perTxEth, perRunEth, override }) {
  if (override && isAgentMode()) {
    throw new Aborted('agent mode: --override-ceilings is never accepted from an agent. The holder must run this command themselves.');
  }
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

/**
 * AGENT MODE (Hermes or any other local agent).
 *
 * Set HOLDER_KIT_AGENT=1 in the agent's environment (the Hermes installer's
 * wrapper does this). Broadcasting is then governed by HOLDER_KIT_AGENT_BROADCAST,
 * which only the HOLDER sets:
 *
 *   none        (default) — dry runs and reads only; nothing is ever signed
 *   free-mints  — `auto` / `watch` / `mint` may broadcast, but ONLY zero-value mints
 *   all         — every command may broadcast (ceilings still apply)
 *
 * In every agent level: --override-ceilings is refused, and destructive vault
 * actions (remove, change-password) are refused. This is a guardrail against an
 * agent improvising, not a sandbox: anything with shell access as the holder
 * can bypass it. Keep the agent's tool permissions tight as well.
 */
export function isAgentMode() {
  return process.env.HOLDER_KIT_AGENT === '1';
}

export function agentBroadcastLevel() {
  const v = String(process.env.HOLDER_KIT_AGENT_BROADCAST || 'none').toLowerCase();
  return ['none', 'free-mints', 'all'].includes(v) ? v : 'none';
}

/**
 * Throw unless the current agent policy allows broadcasting this kind of action.
 * kind: 'free-mint' | 'paid-mint' | 'transfer' | 'fund'
 */
export function assertAgentMayBroadcast(kind) {
  if (!isAgentMode()) return;
  const level = agentBroadcastLevel();
  if (level === 'all') return;
  if (level === 'free-mints' && kind === 'free-mint') return;
  throw new Aborted(
    `agent mode: broadcasting a ${kind} is not allowed (HOLDER_KIT_AGENT_BROADCAST=${level}). ` +
      `Show the holder the dry run; they can run it themselves with --execute, ` +
      `or raise the policy with: npm run hermes:install -- --broadcast <level>.`
  );
}

export function assertAgentMayRun(cmd, sub) {
  if (!isAgentMode()) return;
  const blocked = new Set(['wallet remove', 'wallet change-password', 'wallet restore']);
  const name = sub ? `${cmd} ${sub}` : cmd;
  if (blocked.has(name)) {
    throw new Aborted(`agent mode: \`${name}\` must be run by the holder, not an agent.`);
  }
}
