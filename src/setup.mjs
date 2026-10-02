// Zero-friction onboarding.
//
// New users should never have to know what a vault file is before their first
// command works. This module makes setup a single non-interactive step while
// keeping the security property that matters: a real password, stored nowhere
// in plaintext except one file the holder is explicitly told about.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { findPassword, generatePasswordFile } from './password.mjs';
import { hiddenPrompt } from './vault.mjs';

/**
 * Decide the vault password for setup.
 *
 *  - vault EXISTS: unlock it with whatever password source is available
 *    (env, password file, prompt). Never generate a new one — a new random
 *    password cannot open an existing vault, and the old setup overwrote the
 *    password file with exactly that, locking holders out for good.
 *  - vault MISSING: use env / an existing password file, otherwise generate a
 *    strong random password into PASSWORD.txt (written with 'wx', so it can
 *    never replace a file that is already there).
 */
export async function resolveSetupPassword(vaultPath, { interactive } = {}) {
  const found = findPassword(vaultPath);
  if (found.password) return found;

  if (existsSync(vaultPath)) {
    if (interactive) {
      const pw = await hiddenPrompt('Vault password (input hidden): ');
      return { password: pw, source: 'prompt', file: null };
    }
    throw new Error(
      `a vault already exists at ${vaultPath} but no password was found.\n` +
        `  Set HOLDER_KIT_PASSWORD or HOLDER_KIT_PASSWORD_FILE, or restore ${join(dirname(vaultPath), 'PASSWORD.txt')}.\n` +
        `  Setup will NOT generate a new password: it could never open this vault.`
    );
  }
  return generatePasswordFile(vaultPath);
}

/**
 * One-command setup. Idempotent: running it twice does not destroy wallets,
 * and never touches an existing password file.
 */
export async function quickSetup({
  vaultPath,
  interactive,
  walletCount = 0,
  label = 'holder-kit vault',
  backup = true,
}) {
  const steps = [];
  const resolved = await resolveSetupPassword(vaultPath, { interactive });
  const finalPassword = resolved.password;
  if (!finalPassword || finalPassword.length < 8) {
    throw new Error('vault password must be at least 8 characters');
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

  let generated = 0;
  if (walletCount > 0 && vault.wallets.length === 0) {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    for (let i = 0; i < walletCount; i++) {
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      vault.addWallet({ address: acct.address, privateKey: pk, note: 'generated at setup' });
      generated++;
    }
    steps.push({ ok: true, msg: `generated ${generated} wallet(s)` });
  }

  const saved = vault.save();
  steps.push({ ok: true, msg: `saved ${saved.wallets} wallet(s) to ${saved.path}` });

  // First backup, proven by decrypting it again before we call it a backup.
  let backupPath = null;
  if (backup) {
    backupPath = join(dirname(vaultPath), 'holder.vault.backup.bin');
    const res = vault.exportTo(backupPath);
    await Vault.open(backupPath, { password: finalPassword }).then((b) => {
      if (b.wallets.length !== saved.wallets) throw new Error('backup verification failed — wallet count mismatch');
      b.lock();
    });
    steps.push({ ok: true, msg: `backup written and re-opened OK (${res.bytes} bytes) -> ${backupPath}` });
  }

  vault.lock();

  return {
    steps,
    generated,
    wallets: saved.wallets,
    vaultPath: saved.path,
    backupPath,
    passwordSource: resolved.source,
    passwordFile: resolved.source === 'generated' ? resolved.file : null,
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
