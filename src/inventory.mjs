// Chain reads: balances, NFT inventory, contract probing.
import { encodeCall, decodeAddress, decodeUint, decodeString, formatUnits, parseUnits } from './abi.mjs';

export async function nativeBalances(pool, addresses) {
  const res = await pool.batch(addresses.map((a) => ({ method: 'eth_getBalance', params: [a, 'latest'] })));
  return addresses.map((address, i) => ({ address, wei: res[i] ? BigInt(res[i]) : 0n }));
}

export async function isContract(pool, address) {
  const code = await pool.getCode(address);
  return code && code !== '0x' && code !== '0x0';
}

export async function tokenMeta(pool, address) {
  const [name, symbol, supply] = await Promise.all([
    pool.call(address, encodeCall('name()')).catch(() => '0x'),
    pool.call(address, encodeCall('symbol()')).catch(() => '0x'),
    pool.call(address, encodeCall('totalSupply()')).catch(() => null),
  ]);
  return {
    name: decodeString(name) || null,
    symbol: decodeString(symbol) || null,
    totalSupply: supply ? decodeUint(supply) : null,
  };
}

/**
 * Detect whether a contract is ERC-721 (enumerable or indexable) or ERC-1155.
 * Enumerable ERC-721s expose tokenOfOwnerByIndex; others need log scanning, which
 * we report honestly rather than pretending a balance is an inventory.
 */
export async function detectStandard(pool, address) {
  // supportsInterface returns empty data on a non-ERC contract; treat that as
  // "does not implement" rather than letting BigInt('') throw.
  const supports = async (id) => {
    try {
      const r = await pool.call(address, encodeCall('supportsInterface(bytes4)', [id]));
      return !!r && r !== '0x' && decodeUint(r) === 1n;
    } catch {
      return false;
    }
  };

  const [isErc721, isErc1155] = await Promise.all([
    supports('0x80ac58cd'),
    supports('0xd9b67a26'),
  ]);

  if (isErc1155 && !isErc721) return 'ERC1155';
  if (isErc721) return 'ERC721';
  if (isErc1155) return 'ERC1155';
  return 'UNKNOWN';
}

/**
 * True when the collection can enumerate an owner's tokens without log scanning.
 *
 * The probe MUST use a real owner: calling tokenOfOwnerByIndex on the zero
 * address reverts (empty array) even on a perfectly enumerable collection,
 * which made every ERC-721 look non-enumerable and hid all holder NFTs.
 */
export async function isEnumerable(pool, address, owner) {
  if (!owner) return false;
  const probeOwner = /^0x0{40}$/i.test(owner)
    ? '0x0000000000000000000000000000000000000001'
    : owner;
  return pool
    .call(address, encodeCall('tokenOfOwnerByIndex(address,uint256)', [probeOwner, 0]))
    .then((r) => !!r && r !== '0x')
    .catch(() => false);
}

/**
 * Full token list for an owner on an enumerable ERC-721.
 * Returns [] with `enumerable:false` when the collection is non-enumerable —
 * callers must treat that as "unknown", not "empty".
 */
export async function erc721Inventory(pool, collection, owner, { limit = 500 } = {}) {
  const balHex = await pool.call(collection, encodeCall('balanceOf(address)', [owner]));
  const balance = Number(decodeUint(balHex) ?? 0n);
  if (balance === 0) return { tokens: [], balance: 0, enumerable: true };

  if (!(await isEnumerable(pool, collection, owner))) {
    return { tokens: [], balance, enumerable: false };
  }

  const tokens = [];
  // Batch the index reads so a 500-token holder is a handful of requests, not 500.
  const CHUNK = 100;
  for (let start = 0; start < Math.min(balance, limit); start += CHUNK) {
    const size = Math.min(CHUNK, Math.min(balance, limit) - start);
    const calls = Array.from({ length: size }, (_, i) => ({
      method: 'eth_call',
      params: [{ to: collection, data: encodeCall('tokenOfOwnerByIndex(address,uint256)', [owner, start + i]) }, 'latest'],
    }));
    const res = await pool.batch(calls);
    res.forEach((r, i) => {
      // decodeUint returns null when a call yields empty data (e.g. the token
      // was burned mid-scan); skip rather than BigInt(null)-throwing.
      const v = r ? decodeUint(r) : null;
      if (v != null) tokens.push(v);
    });
  }
  return { tokens, balance, enumerable: true, truncated: balance > limit };
}

/** Sweep every wallet in the vault against every configured collection. */
// The options object needs a default: callers legitimately pass only
// (pool, chainSpec, wallets), and a bare `{ collections, limit }` pattern
// throws "Cannot destructure property of undefined" on the 3-arg call.
export async function inventoryAll(pool, chainSpec, wallets, { collections, limit = 500 } = {}) {
  const cols = collections || Object.entries(chainSpec.collections || {}).map(([name, c]) => ({ name, ...c }));
  const balances = await nativeBalances(pool, wallets.map((w) => w.address));
  const rows = [];

  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci];
    const standard = await detectStandard(pool, col.address);
    const meta = await tokenMeta(pool, col.address);

    for (let wi = 0; wi < wallets.length; wi++) {
      const w = wallets[wi];
      const inv =
        standard === 'ERC721'
          ? await erc721Inventory(pool, col.address, w.address, { limit })
          : { tokens: [], balance: 0, enumerable: false };
      rows.push({
        wallet: w.address,
        nativeWei: balances[wi].wei,
        native: formatUnits(balances[wi].wei),
        collection: col.name,
        collectionAddress: col.address,
        collectionLabel: col.label || null,
        standard,
        collectionName: meta.name,
        symbol: meta.symbol,
        tokenCount: inv.balance,
        enumerable: inv.enumerable,
        tokens: inv.tokens.map(String),
        truncated: !!inv.truncated,
      });
    }
  }
  return rows;
}

/**
 * Probe a collection for the mint shape it actually exposes.
 *
 * Delegates to mintscan.mjs, which owns the single source of truth for mint
 * state (price, pause, supply, and gas-verified vs bytecode-detected shapes).
 * Pass probeFrom — a FUNDED address — so a paid mint can actually be estimated.
 */
export async function probeMint(pool, address, { probeFrom } = {}) {
  const { mintState } = await import('./mintscan.mjs');
  const st = await mintState(pool, address, { probeFrom });
  return {
    address,
    mintShapes: st.sigs,
    verified: st.verified,
    mintPriceWei: st.priceWei,
    maxPerWallet: st.maxPerWallet,
    maxPerTx: st.maxPerTx,
    totalMinted: st.totalMinted,
    maxSupply: st.maxSupply,
    saleIsActive: st.saleActiveFlag,
    isPaused: st.isPausedFlag,
    verdict: st.verdict,
    reason: st.reason,
  };
}

export { formatUnits, parseUnits, decodeAddress };
