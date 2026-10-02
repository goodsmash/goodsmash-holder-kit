// Vault password resolution — ONE place that decides where the password comes from.
//
// Order (first hit wins):
//   1. HOLDER_KIT_PASSWORD          (set for one shell / one child process)
//   2. HOLDER_KIT_PASSWORD_FILE     (a file the holder chose)
//   3. <vault dir>/PASSWORD.txt     (written by `setup`; legacy name vault-password.txt)
//   4. hidden interactive prompt    (only when a real terminal is attached)
//
// Rule this module exists to enforce: a password file that already exists is
// NEVER overwritten. The old setup generated a fresh random password on every
// non-interactive re-run and wrote it over the previous one — the vault then
// refused to open and the only copy of the real password was gone.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const PASSWORD_FILE_NAME = 'PASSWORD.txt';
const LEGACY_NAMES = ['vault-password.txt'];

export function passwordFileCandidates(vaultPath) {
  const dir = dirname(vaultPath);
  return [PASSWORD_FILE_NAME, ...LEGACY_NAMES].map((n) => join(dir, n));
}

function readPw(file) {
  try {
    const pw = readFileSync(file, 'utf8').replace(/\r?\n$/, '').trim();
    return pw.length >= 8 ? pw : null;
  } catch {
    return null;
  }
}

/**
 * Find a password without prompting. Returns { password, source, file } or
 * { password: null } when the caller must prompt (or fail).
 */
export function findPassword(vaultPath, { allowDefaultFile = true } = {}) {
  if (process.env.HOLDER_KIT_PASSWORD) {
    return { password: process.env.HOLDER_KIT_PASSWORD, source: 'HOLDER_KIT_PASSWORD', file: null };
  }
  const fileEnv = process.env.HOLDER_KIT_PASSWORD_FILE;
  if (fileEnv) {
    const pw = readPw(fileEnv);
    if (!pw) throw new Error(`HOLDER_KIT_PASSWORD_FILE is set but ${fileEnv} is missing or shorter than 8 characters`);
    return { password: pw, source: 'HOLDER_KIT_PASSWORD_FILE', file: fileEnv };
  }
  if (allowDefaultFile && process.env.HOLDER_KIT_NO_PASSWORD_FILE !== '1') {
    for (const f of passwordFileCandidates(vaultPath)) {
      if (!existsSync(f)) continue;
      const pw = readPw(f);
      if (pw) return { password: pw, source: 'password file', file: f };
    }
  }
  return { password: null, source: null, file: null };
}

/**
 * Generate a strong password and write it with O_EXCL semantics ('wx'): if a
 * file is already there this throws instead of clobbering it.
 */
export function generatePasswordFile(vaultPath) {
  const file = join(dirname(vaultPath), PASSWORD_FILE_NAME);
  const password = randomBytes(24).toString('base64url');
  writeFileSync(file, `${password}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ACLs govern; mode is advisory. */
  }
  return { password, source: 'generated', file };
}
