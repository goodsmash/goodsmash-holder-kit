// Free-mint discovery + auto-mint watcher.
//
// Holders do not want to sit refreshing a page to catch a free mint window.
// This scans configured collections on-chain for the actual state — price,
// sale flag, pause, supply remaining — and reports only what is genuinely
// mintable right now. Nothing is inferred from a project tweet.
import { encodeCall, decodeUint, formatUnits, selector } from './abi.mjs';
import { detectStandard, tokenMeta, isContract } from './inventory.mjs';

const ZERO = 0n;

/** Read every gate a mint can hide behind, tolerating absent functions. */
export async function mintState(pool, address, opts = {}) {
  const read = async (sig, args = []) => {
    try {
      const hex = await pool.call(address, encodeCall(sig, args));
      // decodeUint returns null for an absent function; 0 is a real value.
      return hex && hex !== '0x' ? decodeUint(hex) : null;
    } catch {
      return null; // function does not exist on this contract
    }
  };

  // Getter names vary widely between drops, and a miss is not neutral: with no
  // price found the scanner assumes "paid", so a genuinely free mint that calls
  // its getter `freePrice()` (or `publicPrice`, `mintCost`, …) reported
  // `paid-live` and auto-mint would try to send value. Probe the names real
  // drops actually use.
  const price =
    (await read('mintPrice()')) ??
    (await read('freePrice()')) ??
    (await read('price()')) ??
    (await read('cost()')) ??
    (await read('publicPrice()')) ??
    // A getter that takes an argument needs one: encodeCall throws on a missing
    // arg, which `read` would swallow into null — a silent dead probe.
    (await read('mintCost(uint256)', [1]));
  const active =
    (await read('saleIsActive()')) ??
    (await read('isActive()')) ??
    (await read('saleActive()')) ??
    (await read('mintActive()'));
  const paused = (await read('paused()')) ?? (await read('isPaused()'));
  // Only ever probe names WITH parentheses. `selector()` keccaks the literal
  // text, so a paren-less 'maxSupply' is a different hash — but
  // `encodeCall('maxSupply')` throws "unsupported ABI type", and read() turns
  // that throw into null. A paren-less entry looks like extra coverage while
  // silently probing nothing.
  const maxSupply =
    (await read('maxSupply()')) ??
    (await read('MAX_SUPPLY()')) ??
    (await read('collectionSize()'));
  const totalMinted = (await read('totalMinted()')) ?? (await read('mintedCount()'));
  const maxPerWallet = (await read('maxPerWallet()')) ?? (await read('maxPerAddress()'));
  const maxPerTx = (await read('maxPerTx()')) ?? (await read('maxMintAmount()'));

  // A shape that can actually be estimated is the only real proof of mintability.
  //
  // Estimating a PAID mint requires a FUNDED `from`: a random probe address has
  // no balance, so the estimate fails with "insufficient funds" and a genuinely
  // open paid sale reads as closed. So: estimate when we have a funded probeFrom,
  // otherwise fall back to scanning the deployed runtime bytecode for the 4-byte
  // selector, and label those entries as unverified rather than pretending.
  const shapes = [];
  const probeFrom = opts.probeFrom || null;
  const code = probeFrom ? null : await pool.getCode(address).catch(() => '0x');

  for (const sig of ['mint(uint256)', 'mint()', 'mint(address,uint256)', 'mintPublic(uint256)', 'publicMint(uint256)', 'purchase(uint256)']) {
    const args = sig === 'mint(address,uint256)' ? ['0x0000000000000000000000000000000000000001', 1] : sig === 'mint()' ? [] : [1];
    const data = encodeCall(sig, args);

    if (probeFrom) {
      const value = price != null ? price : ZERO;
      const ok = await pool
        .estimateGas({ from: probeFrom, to: address, data, value })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        shapes.push({ sig, verified: true });
        continue;
      }
      // A zero-value retry catches mints that are free or price-agnostic.
      if (value > ZERO) {
        const okFree = await pool
          .estimateGas({ from: probeFrom, to: address, data, value: ZERO })
          .then(() => true)
          .catch(() => false);
        if (okFree) {
          shapes.push({ sig, verified: true });
          continue;
        }
      }
      continue;
    }

    // Bytecode fallback: the selector must appear as a PUSH4 constant.
    if (code && code !== '0x') {
      const sel = selector(sig).replace(/^0x/, '');
      if (code.toLowerCase().includes(sel)) shapes.push({ sig, verified: false });
    }
  }

  const remaining = maxSupply != null && totalMinted != null ? maxSupply - totalMinted : null;
  const soldOut = remaining != null && remaining <= ZERO;
  const isPaused = paused === 1n;
  const isActive = active === null ? null : active === 1n;
  const isFree = price != null && price === ZERO;
  const gasPrice = await pool.gasPrice().catch(() => null);

  // Verdict is derived from chain state only.
  //
  // Order matters: supply exhaustion outranks "no callable shape". A sold-out
  // collection reverts every mint call, so shape probing alone would report it
  // as merely "closed" and hide the actual reason.
  let verdict;
  let reason;
  if (soldOut) {
    verdict = 'sold-out';
    reason = 'supply fully minted';
  } else if (!shapes.length) {
    verdict = 'closed';
    reason = 'no mint function accepts a call right now';
  } else if (isPaused) {
    verdict = 'closed';
    reason = 'contract is paused';
  } else if (isActive === false) {
    verdict = 'closed';
    reason = 'sale is not active';
  } else if (maxPerWallet === ZERO) {
    verdict = 'closed';
    reason = 'max per wallet is zero';
  } else {
    verdict = isFree ? 'free-live' : 'paid-live';
    // price can be null when the contract exposes no price getter at all —
    // never hand null to formatUnits; say what is actually known instead.
    reason = isFree
      ? 'free mint, callable now'
      : price != null
        ? `costs ${formatUnits(price)} each`
        : 'mint is payable (no price getter on this contract)';
  }

  return {
    address,
    verdict,
    reason,
    isFree,
    priceWei: price,
    maxSupply,
    totalMinted,
    remaining,
    maxPerWallet,
    maxPerTx,
    shapes,
    // Every shape must be gas-estimated (or a funded-wallet estimate) to be trusted.
    verified: shapes.length > 0 && shapes.every((s) => s.verified),
    sigs: shapes.map((s) => s.sig),
    // Raw on-chain flags, exposed so callers can distinguish "absent function"
    // (null) from "present and false" (0n).
    saleActiveFlag: active,
    isPausedFlag: paused,
    gasPrice,
  };
}

/** Scan every known collection on a chain and rank by how actionable it is. */
export async function scanForMints(pool, chainSpec, { addresses, probeFrom } = {}) {
  const cols = addresses?.length
    ? addresses.map((a) => ({ name: shortName(a), address: a }))
    : Object.entries(chainSpec.collections || {}).map(([name, c]) => ({ name, address: c.address }));

  const out = [];
  for (const col of cols) {
    try {
      if (!(await isContract(pool, col.address))) {
        out.push({ name: col.name, address: col.address, verdict: 'not-a-contract', reason: 'no bytecode at this address' });
        continue;
      }
      const [meta, std, state] = await Promise.all([
        tokenMeta(pool, col.address).catch(() => ({})),
        detectStandard(pool, col.address),
        mintState(pool, col.address, { probeFrom }),
      ]);
      out.push({ name: col.name, label: meta.name, symbol: meta.symbol, standard: std, ...state });
    } catch (e) {
      out.push({ name: col.name, address: col.address, verdict: 'error', reason: e.message.slice(0, 80) });
    }
  }

  const rank = { 'free-live': 0, 'paid-live': 1, 'sold-out': 2, closed: 3, 'not-a-contract': 4, error: 5 };
  return out.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
}

export function printMintScan(results, chainName) {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`mint scan — ${chainName}`);
  console.log(`${'='.repeat(64)}\n`);

  if (!results.length) {
    console.log('  no collections configured for this chain.');
    console.log('  add them to config/chains.json, or pass: find --address 0x...');
    return;
  }

  for (const r of results) {
    const tag =
      r.verdict === 'free-live' ? '\x1b[42m\x1b[30m FREE LIVE \x1b[0m'
      : r.verdict === 'paid-live' ? '\x1b[43m\x1b[30m PAID LIVE \x1b[0m'
      : r.verdict === 'sold-out' ? '\x1b[41m\x1b[30m SOLD OUT \x1b[0m'
      : '\x1b[100m\x1b[37m CLOSED   \x1b[0m';
    console.log(`  ${tag} ${r.name}${r.symbol ? ` (${r.symbol})` : ''}`);
    console.log(`     ${r.address}`);
    console.log(`     ${r.reason}`);
    if (r.remaining != null) console.log(`     remaining : ${formatUnits(r.remaining)}`);
    if (r.maxPerWallet != null && r.maxPerWallet > 0n) console.log(`     max/wallet: ${formatUnits(r.maxPerWallet)}`);
    if (r.sigs?.length) {
      const mark = r.verified ? 'gas-verified' : 'from bytecode (not gas-verified)';
      console.log(`     mint via  : ${r.sigs[0]}  \x1b[2m[${mark}]\x1b[0m`);
    }
    console.log('');
  }

  const free = results.filter((r) => r.verdict === 'free-live');
  if (free.length) {
    console.log(`\n  \x1b[32m${free.length} collection(s) are free and callable right now.\x1b[0m`);
    console.log(`  auto-mint them with:  holder-kit auto --collection ${free[0].address}`);
  }
}

/**
 * Watch loop: poll mint state and fire the moment a free window opens.
 * Bounded by maxChecks so it can never spin forever unattended.
 */
export async function watchAndMint({ pool, collection, signers, quantity, intervalMs, maxChecks, onFire, dryRun }) {
  console.log(`\nwatching ${collection} every ${Math.round(intervalMs / 1000)}s (up to ${maxChecks} checks)`);
  console.log(`  ${signers.length} wallet(s) ready, ${quantity} mint each\n`);

  for (let i = 1; i <= maxChecks; i++) {
    const st = await mintState(pool, collection);
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`  [${stamp}] check ${i}/${maxChecks}  ${st.verdict.padEnd(12)} ${st.reason}`);

    if (st.verdict === 'free-live' && !dryRun) {
      console.log(`\n  \x1b[42m\x1b[30m FREE WINDOW OPEN — minting now\x1b[0m\n`);
      const res = await onFire(st);
      return { fired: true, at: i, ...res };
    }
    if (i < maxChecks) await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log(`\n  no free window within ${maxChecks} checks. Nothing was sent.`);
  return { fired: false, checks: maxChecks };
}

function shortName(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
