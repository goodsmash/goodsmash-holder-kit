// Transaction signing + broadcast.
//
// viem's privateKeyToAccount is used directly: it signs locally and the raw
// transaction goes to the RPC and nowhere else. There is no key-server call, no
// telemetry, and no remote signer anywhere in this file.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem/utils';

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
      // maxPriorityFeePerGas must stay strictly BELOW maxFeePerGas or the node
      // rejects with "max priority fee per gas higher than max fee per gas".
      // gasPrice/10 only holds while maxFee is >= 1.1x gasPrice, which 1.5x is.
      fees = {
        maxFeePerGas: (gasPrice * 3n) / 2n,
        maxPriorityFeePerGas: gasPrice / 5n,
      };
    }

    const request = { to, data, value, nonce, chainId: this.chain.id, ...fees };

    // Estimate gas, but only let a TRANSPORT failure force the gas cap.
    //
    // An estimate that fails because the CONTRACT reverts is a real answer from
    // the chain: the call cannot succeed. Broadcasting anyway wastes the gas cap
    // and produces a misleading "insufficient funds" error, which looks like a
    // wallet problem instead of "this mint is closed / limited / sold out".
    if (gasLimit) {
      request.gas = gasLimit;
    } else {
      try {
        request.gas = await this.pool.estimateGas({ from: this.address, ...request });
      } catch (e) {
        // RpcPool tags contract reverts with isRevert; transport/parse failures
        // have no tag. Only the former means "this call cannot succeed".
        if (e.isRevert || e.reverted) {
          const err = new Error(`call would revert, not broadcast: ${e.message}`);
          err.reverted = true;
          err.isRevert = true;
          throw err;
        }
        if (!quiet) process.stderr.write(`[send] gas estimate failed (${e.message.slice(0, 70)}); using cap\n`);
        request.gas = 3_000_000n;
      }
    }

    const signed = await this.account.signTransaction(request);
    // The tx hash is a pure function of the signed bytes, so we know it before
    // broadcasting. That matters for failover: if endpoint A accepted the tx but
    // timed out answering, the pool retries on endpoint B, which correctly says
    // "already known" / "nonce too low". That is NOT a failure — the very same
    // transaction is in flight — so we wait on the hash we computed.
    const expected = keccak256(signed);
    let sent;
    try {
      sent = await this.pool.sendRawTransaction(signed);
    } catch (e) {
      if (/already known|known transaction|nonce too low|already imported/i.test(e.message)) {
        const rc = await this.pool
          .waitForReceipt(expected, { confirmations: 1, timeoutMs: 60_000 })
          .catch(() => null);
        if (!rc) throw e; // a DIFFERENT tx used this nonce; surface the original error
        sent = expected;
      } else {
        throw e;
      }
    }
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
