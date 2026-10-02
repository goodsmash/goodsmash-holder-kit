// Chain + endpoint resolution. Merges committed defaults with the holder's own
// keyed providers, and refuses to boot if a URL still contains a placeholder.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PLACEHOLDER = /(YOUR-|YOUR_|CHANGEME|xxxx|<key>)/i;

function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Malformed JSON at ${p}: ${e.message}`);
  }
}

export function listChains() {
  const chains = readJson(join(ROOT, 'config', 'chains.json')) || {};
  return Object.entries(chains).map(([key, c]) => ({ key, ...c }));
}

/**
 * Resolve the endpoint pool for a chain.
 * Order: keyed providers first (higher limits), then public fallbacks.
 * Any endpoint still holding a placeholder is dropped with a warning, never booted.
 */
export function resolveChain(chainKey, opts = {}) {
  const chains = readJson(join(ROOT, 'config', 'chains.json')) || {};
  const chain = chains[chainKey];
  if (!chain) {
    throw new Error(
      `Unknown chain "${chainKey}". Known: ${Object.keys(chains).join(', ')}`
    );
  }

  const userCfgPath = opts.endpointsFile || join(ROOT, 'config', 'endpoints.json');
  const userCfg = readJson(userCfgPath) || {};
  const providers = userCfg.providers || {};
  const assignedNames = userCfg.assignments?.[chainKey] || [];

  const dropped = [];
  const accept = (ep, source) => {
    if (!ep?.url) return;
    if (PLACEHOLDER.test(ep.url)) {
      dropped.push({ url: redactUrl(ep.url), source });
      return;
    }
    endpoints.push({ ...ep, source });
  };

  const endpoints = [];
  for (const name of assignedNames) {
    if (providers[name]) accept({ ...providers[name], provider: name }, 'keyed');
  }
  for (const ep of chain.endpoints || []) accept(ep, 'builtin');

  // Explicit --rpc on the CLI wins and is prepended.
  if (opts.rpc) {
    endpoints.unshift({ url: opts.rpc, provider: 'cli', tier: 'custom' });
  }

  if (!endpoints.length) {
    throw new Error(
      `No usable RPC endpoint for "${chainKey}".\n` +
        `Every configured URL is still a placeholder.\n` +
        `Fix: copy config/endpoints.example.json -> config/endpoints.json and paste your provider URL.`
    );
  }

  // The committed config/endpoints.json is a TEMPLATE full of placeholders. Warn
  // about it once, clearly, and only when the holder has not yet added a real
  // provider — otherwise every command opens with alarming noise.
  if (dropped.length && !endpoints.some((e) => e.tier === 'keyed' || e.tier === 'custom')) {
    process.stderr.write(
      `[config] ${dropped.length} provider slot(s) in config/endpoints.json are still placeholders — skipped.\n` +
        `[config] add a real one for higher rate limits: cp config/endpoints.example.json config/endpoints.json\n` +
        `[config] (free tier: https://app.quicknode.com)\n`
    );
  }

  return { key: chainKey, ...chain, endpoints };
}

/** Strip anything key-shaped out of a URL before it is ever printed. */
export function redactUrl(url) {
  return String(url)
    .replace(/\/\/([^@/]*)@/, '//***@')
    .replace(/([?&](?:key|apikey|api_key|token|auth|secret)=)[^&]*/gi, '$1***')
    .replace(/\/v[0-9a-f]{8,}(?=\/|$|\?)/gi, '/v***')
    .replace(/\/(?:[A-Za-z0-9_-]{24,})(?=\/|$|\?)/g, '/***');
}

export function assertLiveChain(spec) {
  if (spec.testnet && !process.env.HOLDER_KIT_ALLOW_TESTNET) {
    // Testnets are allowed but loudly marked, not blocked.
    return { testnet: true, warning: 'TESTNET — these assets have no value.' };
  }
  return {};
}
