// Failover RPC pool.
//
// Every read goes through here. Each endpoint carries a health score; when one
// 429s, errors, or stalls, it is benched and traffic moves to the next one.
// This is the difference between "the holder's script died" and "the script
// kept working while a provider rate-limited us".
import { redactUrl } from './config.mjs';
import { keccak256, toBytes } from 'viem/utils';

/**
 * EIP-55 checksum an address.
 *
 * Required, not cosmetic: several nodes (Robinhood Chain testnet among them)
 * decode `to` with a Go struct that rejects an all-lowercase hex string, so an
 * unchecksummed address fails with a confusing -32602 "cannot unmarshal hex
 * string of odd length". Checksumming sidesteps that entirely and is also what
 * explorers display, so logs match what a holder sees.
 */
export function toChecksum(addr) {
  if (typeof addr !== 'string') return addr;
  const a = addr.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) return addr; // not a plain address; pass through
  let hex = '';
  for (const b of toBytes(keccak256('0x' + a))) hex += b.toString(16).padStart(2, '0');
  // EIP-55: uppercase a hex digit when the matching hash nibble is >= 8.
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hex[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  }
  return out;
}

const BENCH_MS = 30_000;
const STALL_MS = 20_000;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Endpoint {
  constructor({ url, provider, tier, source }) {
    this.url = url;
    this.provider = provider || 'unknown';
    this.tier = tier || 'public';
    this.source = source || 'builtin';
    this.benchUntil = 0;
    this.failures = 0;
    this.successes = 0;
    this.lastLatency = null;
    this.lastError = null;
    this.totalRequests = 0;
  }

  get benched() {
    return Date.now() < this.benchUntil;
  }

  bench(reason) {
    // Backoff grows with consecutive failures, capped so a flapping endpoint
    // still returns to rotation quickly.
    const penalty = Math.min(BENCH_MS * Math.pow(2, Math.max(0, this.failures - 1)), 5 * 60_000);
    this.benchUntil = Date.now() + penalty;
    this.lastError = reason;
  }

  score() {
    if (this.benched) return -1;
    // Prefer tier, then reliability, then latency.
    const tierBonus = this.tier === 'keyed' ? 1000 : this.tier === 'custom' ? 900 : this.tier === 'local' ? 500 : 0;
    const total = this.successes + this.failures;
    const reliability = total ? this.successes / total : 0.5;
    const latency = this.lastLatency == null ? 400 : Math.min(this.lastLatency, 5000);
    return tierBonus + reliability * 500 - latency / 10 - this.failures * 40;
  }

  report() {
    return {
      provider: this.provider,
      tier: this.tier,
      url: redactUrl(this.url),
      state: this.benched ? 'benched' : 'active',
      ok: this.successes,
      fail: this.failures,
      lastLatencyMs: this.lastLatency,
      lastError: this.lastError,
      benchForMs: Math.max(0, this.benchUntil - Date.now()),
    };
  }
}

export class RpcPool {
  constructor(endpoints, chainId) {
    this.chainId = chainId;
    this.endpoints = endpoints.map((e) => new Endpoint(e));
    this.id = 0;
    this.stats = { requests: 0, retries: 0, failures: 0, failoverEvents: 0 };
  }

  get active() {
    return this.endpoints.filter((e) => !e.benched).length;
  }

  status() {
    return {
      chainId: this.chainId,
      active: this.active,
      total: this.endpoints.length,
      requests: this.stats.requests,
      retries: this.stats.retries,
      failovers: this.stats.failoverEvents,
      endpoints: this.endpoints.map((e) => e.report()),
    };
  }

  /** Endpoints ordered best-first, but never the one that just failed. */
  ranked(exclude = []) {
    return this.endpoints
      .filter((e) => !exclude.includes(e))
      .sort((a, b) => b.score() - a.score());
  }

  async raw(url, body, { timeout = STALL_MS } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 180)}`);
        err.status = res.status;
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        // execution reverted is a CONTRACT answer, not a transport failure — mark it
        // so the failover layer knows not to bench the endpoint.
        const isRevert = json.error.code === 3 || /execution reverted|revert/i.test(json.error.message || '');
        const err = new Error(`${json.error.code}: ${json.error.message}`);
        err.rpcCode = json.error.code;
        err.isRevert = isRevert;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Send one JSON-RPC call, failing over across endpoints until one answers.
   * `id` is incremented per attempt because some providers reject a replayed id.
   */
  async request(method, params = [], { allowStale = false } = {}) {
    const tried = [];
    let lastErr;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const pool = this.ranked(tried);
      if (!pool.length) {
        if (allowStale && this.endpoints.length) {
          lastErr = new Error(`all endpoints benched: ${lastErr?.message || 'unknown'}`);
          break;
        }
        throw new Error(
          `All ${this.endpoints.length} RPC endpoint(s) unavailable. Last error: ${lastErr?.message}`
        );
      }

      const ep = pool[0];
      tried.push(ep);
      this.stats.requests++;

      try {
        this.id++;
        const started = Date.now();
        const out = await this.raw(ep.url, {
          jsonrpc: '2.0',
          id: this.id,
          method,
          params,
        });
        ep.lastLatency = Date.now() - started;
        ep.successes++;
        if (tried.length > 1) this.stats.failoverEvents++;
        ep.lastError = null;
        return out.result;
      } catch (err) {
        lastErr = err;
        ep.failures++;
        this.stats.retries++;

        // A revert is the CONTRACT answering, not the endpoint failing. Benching
        // a healthy provider because a call reverted turns every failed eth_call
        // into a fake outage — reverts must never touch endpoint health.
        // -32003 (out of gas / insufficient funds) is likewise a property of the
        // request, not the transport.
        if (err.isRevert || err.rpcCode === 3 || err.rpcCode === -32000 || err.rpcCode === -32003) {
          ep.failures--; // undo the health penalty
          throw err;
        }

        const rateLimited = err.status === 429 || /rate|too many|capacity|429/i.test(err.message);
        const credit = rateLimited ? -3 : -1; // providers rarely recover instantly
        for (let i = 0; i < credit; i++) ep.failures = Math.max(1, ep.failures);
        ep.bench(rateLimited ? `rate limited: ${err.message}` : err.message);

        process.stderr.write(
          `[rpc] ${ep.provider} failed (${err.message.slice(0, 90)}); failing over\n`
        );

        // A 429 that names a retry window is worth honouring once.
        if (attempt === 0 && err.retryAfter && err.retryAfter <= 5) {
          await sleep(err.retryAfter * 1000);
        }
      }
    }

    this.stats.failures++;
    throw lastErr || new Error('RPC request failed with no endpoint attempted');
  }

  /** Batch several calls into one HTTP post; individual failures come back null. */
  async batch(calls) {
    if (!calls.length) return [];
    const payload = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: c.method,
      params: c.params || [],
    }));

    const tried = [];
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const pool = this.ranked(tried);
      if (!pool.length) throw lastErr || new Error('no endpoint available for batch');
      const ep = pool[0];
      tried.push(ep);
      this.stats.requests++;
      try {
        const started = Date.now();
        const out = await this.raw(ep.url, payload, { timeout: STALL_MS * 2 });
        ep.lastLatency = Date.now() - started;
        ep.successes++;
        if (tried.length > 1) this.stats.failoverEvents++;
        const byId = new Map(out.map((r) => [r.id, r]));
        return calls.map((c, i) => byId.get(i)?.result ?? null);
      } catch (err) {
        lastErr = err;
        ep.failures++;
        ep.bench(err.message);
        process.stderr.write(`[rpc] batch via ${ep.provider} failed (${err.message.slice(0, 90)}); failing over\n`);
      }
    }
    throw lastErr || new Error('batch failed on all endpoints');
  }

  /**
   * Named fetchChainId, not chainId: the constructor stores the expected chain
   * id on `this.chainId`, and an own property shadows a same-named method —
   * so `pool.chainId()` would have thrown "not a function".
   */
  async fetchChainId() {
    return Number(await this.request('eth_chainId'));
  }

  async blockNumber() {
    return Number(await this.request('eth_blockNumber'));
  }

  async getBalance(address) {
    const hex = await this.request('eth_getBalance', [address, 'latest']);
    return BigInt(hex);
  }

  async call(to, data, block = 'latest') {
    return this.request('eth_call', [{ to: toChecksum(to), data }, block]);
  }

  async getCode(address, block = 'latest') {
    return this.request('eth_getCode', [toChecksum(address), block]);
  }

  async getTransactionCount(address, tag = 'pending') {
    return Number(await this.request('eth_getTransactionCount', [toChecksum(address), tag]));
  }

  async gasPrice() {
    return BigInt(await this.request('eth_gasPrice'));
  }

  async estimateGas(tx) {
    // BigInt is not JSON-serialisable, so hex-encode numerics first.
    // Addresses are ALSO checksummed: some nodes (Robinhood testnet included)
    // run a Go JSON decoder that rejects lowercase hex for common.Address, so an
    // all-lowercase `to` fails with "-32602: cannot unmarshal hex string". An
    // odd-length address string fails the same way for a different reason.
    const payload = {};
    for (const [k, v] of Object.entries(tx)) {
      if (typeof v === 'bigint') payload[k] = '0x' + v.toString(16);
      // Robinhood Chain (and other Go-based nodes) type chainId and nonce as
      // hexutil.Big, so a JS NUMBER is rejected outright with
      // "cannot unmarshal non-string into Go struct field TransactionArgs.chainId".
      // This is not cosmetic: it made every gas estimate fail, forcing the
      // fallback gas cap and unpayable transactions.
      else if ((k === 'chainId' || k === 'nonce') && typeof v === 'number') payload[k] = '0x' + v.toString(16);
      else if ((k === 'to' || k === 'from') && typeof v === 'string') payload[k] = toChecksum(v);
      else if (v && typeof v === 'object' && typeof v.toHex === 'function') payload[k] = v.toHex();
      else payload[k] = v;
    }
    const hex = await this.request('eth_estimateGas', [payload]);
    return BigInt(hex);
  }

  async sendRawTransaction(signed) {
    return this.request('eth_sendRawTransaction', [signed]);
  }

  async getTransactionReceipt(hash) {
    return this.request('eth_getTransactionReceipt', [hash]);
  }

  /** Wait for a receipt by polling, with a live status line. */
  async waitForReceipt(hash, { confirmations = 1, timeoutMs = 180_000, onPoll } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      const rc = await this.getTransactionReceipt(hash);
      if (rc) {
        seen++;
        if (onPoll) onPoll({ hash, confirmations: seen, status: rc.status });
        if (BigInt(rc.status) === 0n) {
          const err = new Error(`transaction reverted on chain: ${hash}`);
          err.reverted = true;
          err.receipt = rc;
          throw err;
        }
        if (seen >= confirmations) return rc;
      } else if (onPoll) {
        onPoll({ hash, confirmations: 0, status: 'pending' });
      }
      await sleep(seen > 0 ? 1200 : 2000);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for receipt ${hash}`);
  }
}
