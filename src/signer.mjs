// Transaction signing + broadcast.
//
// viem's privateKeyToAccount is used directly: it signs locally and the raw
// transaction goes to the RPC and nowhere else. There is no key-server call, no
// telemetry, and no remote signer anywhere in this file.
import { privateKeyToAccount } from 'viem/accounts';
import { RpcPool } from './rpc.mjs';

export class Signer {
  constructor(privateKey, pool, chainSpec) {
    this.account = privateKeyToAccount(privateKey);
    this.pool = pool;
    this.chain = chainSpec;
  }

  get address() {
    return this.account.address;
  }

  /**
   * Sign and broadcast, then wait for the receipt.
   * `value` is in wei. Gas is capped by `maxFeePerGas` so a hostile base-fee
   * spike can never silently drain the wallet.
   */
  async send({ to, data, value = 0n, gasLimit, maxFeePerGas, maxPriorityFeePerGas, confirmations, quiet = false }) {
    const nonce = await this.pool.getTransactionCount(this.address, 'pending');
    let fees = { maxFeePerGas, maxPriorityFeePerGas };

    if (maxFeePerGas == null) {
      const gasPrice = await this.pool.gasPrice();
      fees = {
        // EIP-1559 shape; RH Chain accepts type-2 at low base fees.
        maxFeePerGas: (gasPrice * 3n) / 2n,
        maxPriorityFeePerGas: gasPrice / 10n,
      };
    }

    const request = { to, data, value, nonce, chainId: this.chain.id, ...fees };

    // Estimate gas, but never let a revert in estimation block a send that the
    // caller explicitly priced (some mints revert on estimate during a sale spike).
    if (gasLimit) {
      request.gas = gasLimit;
    } else {
      try {
        request.gas = await this.pool.estimateGas({ from: this.address, ...request });
      } catch (e) {
        if (!quiet) process.stderr.write(`[send] gas estimate failed (${e.message.slice(0, 70)}); using cap\n`);
        request.gas = 3_000_000n;
      }
    }

    const hash = await this.account.signTransaction(request);
    const sent = await this.pool.sendRawTransaction(hash);
    if (!quiet) process.stdout.write(`   sent ${sent} from ${this.address}\n`);

    const rc = await this.pool.waitForReceipt(sent, {
      confirmations: confirmations ?? this.chain.confirmationTarget ?? 1,
      quiet,
    });
    return { hash: sent, receipt: rc, nonce, gasUsed: rc.gasUsed };
  }

  async balance() {
    return this.pool.getBalance(this.address);
  }
}

/** Build one signer per vault wallet, all sharing a single failover pool. */
export function signersFrom(vault, pool, chainSpec, { filter } = {}) {
  const out = [];
  for (const w of vault.wallets) {
    if (filter && !filter(w)) continue;
    out.push({ entry: w, signer: new Signer(w.privateKey, pool, chainSpec) });
  }
  return out;
}
