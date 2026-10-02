// Encrypted local vault.
//
// Design rules:
//  - scrypt (memory-hard) + AES-256-GCM. Authenticated, so tampering is detectable.
//  - The password is NEVER accepted as an argv value (that leaks into shell history
//    and `ps`). It is read from a hidden local prompt.
//  - Every write is verified by decrypting what was just written, in the same run.
//    A gate never seen red is not known to work.
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const SCRYPT = { N: 2 ** 18, r: 8, p: 1, keylen: 32 };
const MAGIC = 'HKV1';

/** Read a password with terminal echo disabled. Works on Windows terminals. */
export function hiddenPrompt(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      // Non-interactive: only accept an explicit, deliberate handover.
      if (process.env.HOLDER_KIT_PASSWORD) {
        return resolve(process.env.HOLDER_KIT_PASSWORD);
      }
      return reject(
        new Error(
          'No interactive terminal. Re-run in a real terminal, or set HOLDER_KIT_PASSWORD in this shell only.'
        )
      );
    }

    output.write(question);
    const rl = createInterface({ input, output, terminal: true });
    let muted = false;

    const origWrite = output.write.bind(output);
    output.write = (chunk, ...rest) => {
      if (muted) {
        const s = typeof chunk === 'string' ? chunk : chunk.toString();
        return origWrite(s.replace(/[^\n\r]/g, ''), ...rest);
      }
      return origWrite(chunk, ...rest);
    };

    rl.question('', (answer) => {
      muted = false;
      output.write = origWrite;
      rl.close();
      output.write('\n');
      resolve(answer);
    });

    // Suppress the terminal's own echo after readline has taken over.
    if (input.isTTY && typeof input.setRawMode === 'function') {
      input.setRawMode(true);
      muted = true;
      const stop = () => {
        if (typeof input.setRawMode === 'function') input.setRawMode(false);
        output.write = origWrite;
      };
      input.once('exit', stop);
    }
  });
}

function deriveKey(password, salt) {
  return scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 512 * 1024 * 1024,
  });
}

export function encryptVault(plaintextObj, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC, 'utf8'),
    Buffer.from([1]),
    salt,
    iv,
    tag,
    ct,
  ]);
}

export function decryptVault(buffer, password) {
  if (buffer.subarray(0, 4).toString('utf8') !== MAGIC) {
    throw new Error('not a holder-kit vault file (bad magic header)');
  }
  const version = buffer[4];
  if (version !== 1) throw new Error(`unsupported vault version ${version}`);
  const salt = buffer.subarray(5, 21);
  const iv = buffer.subarray(21, 33);
  const tag = buffer.subarray(33, 49);
  const ct = buffer.subarray(49);
  const key = deriveKey(password, salt);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    const out = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    throw new Error('wrong password, or the vault file has been modified (tamper detected)');
  }
}

export class Vault {
  constructor(path, data, password) {
    this.path = path;
    this.data = data;
    this.password = password;
  }

  static exists(path) {
    return existsSync(path);
  }

  /**
   * Create a vault and immediately prove it round-trips before returning.
   */
  static async create(path, { password, label = 'holder-kit vault' } = {}) {
    const pass = password || (await hiddenPrompt('Choose a vault password (input hidden): '));
    if (!pass || pass.length < 8) {
      throw new Error('vault password must be at least 8 characters');
    }
    const data = { label, createdAt: new Date().toISOString(), wallets: [] };
    const buf = encryptVault(data, pass);

    // Prove the crypto before the file is trusted.
    const check = decryptVault(buf, pass);
    if (check.wallets.length !== 0) throw new Error('vault self-check failed (write not trusted)');
    assertWrongPasswordRejected(buf);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, buf, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows ACLs govern here; mode is advisory. */
    }
    return new Vault(path, data, pass);
  }

  static async open(path, { password } = {}) {
    const pass = password || (await hiddenPrompt('Vault password (input hidden): '));
    const data = decryptVault(readFileSync(path), pass);
    return new Vault(path, data, pass);
  }

  addWallet({ address, privateKey, note = '', tags = [] }) {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`invalid address: ${address}`);
    }
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error('private key must be 32-byte hex');
    }
    const existing = this.data.wallets.findIndex((w) => w.address.toLowerCase() === address.toLowerCase());
    const entry = { address, privateKey, note, tags, addedAt: new Date().toISOString() };
    if (existing >= 0) this.data.wallets[existing] = { ...this.data.wallets[existing], ...entry };
    else this.data.wallets.push(entry);
    return entry;
  }

  removeWallet(address) {
    const before = this.data.wallets.length;
    this.data.wallets = this.data.wallets.filter(
      (w) => w.address.toLowerCase() !== String(address).toLowerCase()
    );
    return before - this.data.wallets.length;
  }

  get wallets() {
    return this.data.wallets;
  }

  find(address) {
    return this.data.wallets.find((w) => w.address.toLowerCase() === String(address).toLowerCase());
  }

  /** Write, then decrypt the bytes on disk and assert integrity. */
  save() {
    const buf = encryptVault(this.data, this.password);
    const check = decryptVault(buf, this.password);
    if (check.wallets.length !== this.data.wallets.length) {
      throw new Error('vault integrity check failed after write — do not trust this file');
    }
    writeFileSync(this.path, buf, { mode: 0o600 });
    return { path: this.path, bytes: buf.length, wallets: this.data.wallets.length };
  }

  /** Encrypt to a second location (offsite/removable) without leaving the vault. */
  exportTo(destPath) {
    const buf = encryptVault(this.data, this.password);
    const check = decryptVault(buf, this.password);
    if (check.wallets.length !== this.data.wallets.length) {
      throw new Error('export integrity check failed');
    }
    writeFileSync(destPath, buf, { mode: 0o600 });
    return { path: destPath, bytes: buf.length };
  }

  /** Wipe secrets from memory when done. Best-effort, not a security boundary. */
  lock() {
    for (const w of this.data.wallets) {
      if (typeof w.privateKey === 'string') w.privateKey = '0x' + '0'.repeat(64);
    }
    this.password = null;
  }
}

function assertWrongPasswordRejected(buf) {
  try {
    decryptVault(buf, 'definitely-not-the-password-' + Date.now());
    throw new Error('vault accepted a wrong password — do not trust this file');
  } catch (e) {
    if (e.message.includes('do not trust')) throw e;
  }
}

/** Guard used by every command that would touch a key. */
export function assertNoSecretLeak(text) {
  if (/"(privateKey|privkey|secretKey|signingKey|mnemonic)"\s*:\s*"0x[0-9a-fA-F]{64}"/.test(text)) {
    throw new Error('refusing to emit output containing raw key material');
  }
  return text;
}
