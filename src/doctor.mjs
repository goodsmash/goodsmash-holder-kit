// RPC / API doctor.
//
// The single most common holder failure is "the script said rate limited" and
// then gave up. This command proves the whole RPC layer is healthy, shows the
// failover actually working, and tells the holder exactly which provider to add.
import { resolveChain, redactUrl } from './config.mjs';
import { RpcPool } from './rpc.mjs';

const PROBE_CALLS = [
  { method: 'eth_chainId', label: 'chain id' },
  { method: 'eth_blockNumber', label: 'latest block' },
  { method: 'eth_gasPrice', label: 'gas price' },
];

/** Time each endpoint in isolation so a slow one is visible, not averaged away. */
async function timeEndpoint(ep) {
  const started = Date.now();
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` };
    const j = await res.json();
    if (j.error) return { ok: false, ms: Date.now() - started, error: `${j.error.code}` };
    return { ok: true, ms: Date.now() - started, chainId: Number(j.result) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 40) };
  }
}

export async function doctor(chainKey, opts = {}) {
  const spec = resolveChain(chainKey, opts);
  console.log(`\n== holder-kit doctor ==`);
  console.log(`chain      : ${spec.name} (id ${spec.id})${spec.testnet ? '  [TESTNET]' : ''}`);
  console.log(`explorer   : ${spec.explorer}`);
  console.log(`endpoints  : ${spec.endpoints.length}\n`);

  const results = [];
  for (const ep of spec.endpoints) {
    const r = await timeEndpoint(ep);
    results.push({ ep, r });
    const mark = r.ok ? 'OK  ' : 'FAIL';
    const chainNote = r.ok && r.chainId !== spec.id ? `  !! chainId mismatch (got ${r.chainId})` : '';
    console.log(`  ${mark} ${ep.provider.padEnd(20)} ${String(r.ms).padStart(6)}ms  ${r.error || ''}${chainNote}`);
    console.log(`       ${redactUrl(ep.url)}`);
  }

  const pool = new RpcPool(spec.endpoints, spec.id);
  console.log(`\n-- pooled reads through the failover layer --`);
  let healthy = true;
  for (const probe of PROBE_CALLS) {
    try {
      const out = await pool.request(probe.method);
      console.log(`  OK   ${probe.label.padEnd(14)} ${String(out).slice(0, 70)}`);
    } catch (e) {
      healthy = false;
      console.log(`  FAIL ${probe.label.padEnd(14)} ${e.message.slice(0, 70)}`);
    }
  }

  // Prove failover rather than assume it: kill the first endpoint in a throwaway
  // pool and confirm the read still lands.
  if (spec.endpoints.length > 1) {
    const dead = spec.endpoints[0].url.replace(/\/[^/]*$/, '/this-path-is-deliberately-broken-404');
    const probePool = new RpcPool(
      [{ url: dead, provider: 'deliberately-dead', tier: 'keyed' }, ...spec.endpoints],
      spec.id
    );
    try {
      const bn = await probePool.request('eth_blockNumber');
      console.log(`  OK   failover test   recovered to block ${bn} after the primary failed (${probePool.stats.failoverEvents} failover)`);
    } catch (e) {
      healthy = false;
      console.log(`  FAIL failover test   ${e.message.slice(0, 60)}`);
    }
  } else if (spec.endpoints.length === 1) {
    console.log(`  SKIP failover test   only one endpoint configured`);
    healthy = false;
  }

  const st = pool.status();
  console.log(`\n-- summary --`);
  console.log(`  usable endpoints : ${results.filter((x) => x.r.ok).length}/${spec.endpoints.length}`);
  console.log(`  requests         : ${st.requests}   retries: ${st.retries}   failovers: ${st.failovers}`);

  if (results.filter((x) => x.r.ok).length < 2) {
    console.log(`\n  ADVICE: you have fewer than 2 working endpoints, so a rate limit will stop you.`);
    console.log(`  Add a free keyed provider — this is the single highest-value fix:`);
    console.log(`    cp config/endpoints.example.json config/endpoints.json`);
    console.log(`    # then paste your URL from https://app.quicknode.com (free tier available)`);
  }

  const collections = Object.entries(spec.collections || {});
  if (collections.length) {
    console.log(`\n-- collections --`);
    for (const [name, c] of collections) {
      try {
        const code = await pool.getCode(c.address);
        const live = code && code !== '0x';
        console.log(`  ${live ? 'OK  ' : 'DEAD'} ${name.padEnd(10)} ${c.address}  ${c.label || ''}`);
      } catch (e) {
        console.log(`  FAIL ${name.padEnd(10)} ${c.address}  ${e.message.slice(0, 40)}`);
      }
    }
  }

  console.log('');
  return { healthy, spec, status: st };
}
