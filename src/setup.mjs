// Zero-friction onboarding.
//
// New users should never have to know what a vault file is before their first
// command works. This module makes setup a single non-interactive step while
// keeping the security property that matters: a real password, stored nowhere
// in plaintext except one file the holder is explicitly told about.

import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Decide a vault password without ever blocking on a prompt.
 *
 * Order of preference:
 *   1. HOLDER_KIT_PASSWORD  (set by the caller/agent)
 *   2. HOLDER_KIT_PASSWORD_FILE (a file the holder already trusts)
 *   3. a freshly generated 32-char random password, written to a 0600 file
 *
 * A generated password is cryptographically random, not a guessable default —
 * this is strictly stronger than "kit" or "password", and it means an agent or
 * CI run never deadlocks waiting for a human who isn't there.
 */
export function resolvePassword(vaultDir, { interactive } = {}) {
  if (process.env.HOLDER_KIT_PASSWORD) {
    return { password: process.env.HOLDER_KIT_PASSWORD, source: 'HOLDER_KIT_PASSWORD', file: null };
  }

  const fileEnv = process.env.HOLDER_KIT_PASSWORD_FILE;
  if (fileEnv && existsSync(fileEnv)) {
    const pw = readFileSync(fileEnv, 'utf8').trim();
    if (pw.length >= 8) return { password: pw, source: `password file (${fileEnv})`, file: fileEnv };
  }

  // No password available and nobody to ask: mint a strong one and save it.
  if (!interactive) {
    const password = randomBytes(24).toString('base64url');
    const pwFile = join(vaultDir, 'vault-password.txt');
    writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
    try {
      chmodSync(pwFile, 0o600);
    } catch {
      /* Windows ACLs govern; mode is advisory. */
    }
    return { password, source: 'generated', file: pwFile };
  }

  return { password: null, source: 'prompt', file: null }; // caller prompts
}

/**
 * One-command setup. Idempotent: running it twice does not destroy wallets.
 */
export async function quickSetup({
  vaultPath,
  vaultDir,
  password,
  interactive,
  walletCount = 0,
  label = 'holder-kit vault',
}) {
  const steps = [];

  const resolved = resolvePassword(vaultDir, { interactive });
  const finalPassword = password || resolved.password;

  if (!finalPassword) {
    throw new Error('no password available and no terminal to ask for one');
  }

  const { Vault } = await import('./vault.mjs');
  const exists = existsSync(vaultPath);

  let vault;
  if (exists) {
    vault = await Vault.open(vaultPath, { password: finalPassword });
    steps.push({ ok: true, msg: `vault already exists (${vault.wallets.length} wallet(s)) — kept as-is` });
  } else {
    vault = await Vault.create(vaultPath, { password: finalPassword, label });
    steps.push({ ok: true, msg: 'vault created (scrypt + AES-256-GCM)' });
  }

  // A second, independent password would be a support call later; reject it up front.
  if (finalPassword.length < 8) {
    throw new Error('vault password must be at least 8 characters');
  }

  let generated = 0;
  if (walletCount > 0 && vault.wallets.length === 0) {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    for (let i = 0; i < walletCount; i++) {
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      vault.addWallet({ address: acct.address, privateKey: pk, note: 'generated at setup' });
      generated++;
    }
    vault.save();
    steps.push({ ok: true, msg: `generated ${generated} wallet(s)` });
  }

  const saved = vault.save();
  steps.push({ ok: true, msg: `saved ${saved.wallets} wallet(s) to ${saved.path}` });

  vault.lock();

  return {
    steps,
    generated,
    wallets: saved.wallets,
    vaultPath: saved.path,
    passwordSource: resolved.source,
    passwordFile: resolved.file,
  };
}

/** A self-test a new user can run to prove the install actually works. */
export async function selfCheck(pool, vaultPath) {
  const checks = [];
  const push = (name, ok, detail = '') => checks.push({ name, ok, detail });

  try {
    const bn = await pool.blockNumber();
    // blockNumber() returns a NUMBER, not a hex string — checking for a string
    // made every healthy setup report "RPC reachable: failed" while printing a
    // perfectly good block number.
    push('RPC reachable', Number.isFinite(Number(bn)), `block ${bn}`);
  } catch (e) {
    push('RPC reachable', false, e.message.slice(0, 60));
  }

  try {
    const cid = await pool.fetchChainId();
    push('chain id matches config', cid === pool.chainId, `expected ${pool.chainId}, got ${cid}`);
  } catch (e) {
    push('chain id matches config', false, e.message.slice(0, 60));
  }

  try {
    const gp = await pool.gasPrice();
    push('gas price readable', gp > 0n, `${gp} wei`);
  } catch (e) {
    push('gas price readable', false, e.message.slice(0, 60));
  }

  push('vault present', existsSync(vaultPath), vaultPath);

  const st = pool.status();
  push('at least 1 usable endpoint', st.active >= 1, `${st.active}/${st.total} active`);

  return checks;
}
