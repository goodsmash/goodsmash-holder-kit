// READ-ONLY proof that the toolkit reads a REAL mainnet mint contract
// correctly. Sends nothing. Signs nothing. Costs nothing.
//
//   node test/mainnet-read-proof.mjs [address]
//
// The point is NOT to mint here. It is to show that when a real, live,
// already-open mainnet collection is fed to the scanner, every field is read
// from chain and the verdict is honest — including refusing to call a paid
// mint "free" just because supply remains.

import { RpcPool } from '../src/rpc.mjs';
import { resolveChain } from '../src/config.mjs';
import { encodeCall, decodeUint, formatUnits } from '../src/abi.mjs';
import { detectStandard, isEnumerable, tokenMeta } from '../src/inventory.mjs';
import { mintState } from '../src/mintscan.mjs';

const ADDRESS = (process.argv[2] || '0x2676cbd9bba27864acf3d110fa3214f5c86fceaa').toLowerCase();
const CHAIN = process.argv[3] || 'robinhoodMainnet';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAILED  ${name}${detail ? '  ' + detail : ''}`); }
};

console.log(`\n=== READ-ONLY mainnet proof: ${ADDRESS} on ${CHAIN} ===`);
console.log('    no transactions are sent and no keys are used\n');

const spec = resolveChain(CHAIN, {});
const pool = new RpcPool(spec.endpoints, spec.id);

const code = await pool.getCode(ADDRESS).catch(() => null);
ok('contract has live bytecode', !!code && code !== '0x', code ? `${(code.length - 2) / 2} bytes` : 'no code');
if (!code || code === '0x') process.exit(1);

// fetchChainId() returns a number (and spec.id is a number too), so comparing
// against BigInt(spec.id) is ALWAYS false — a test bug that reads as a wrong
// chain. Compare like with like.
const chainOk = Number(await pool.fetchChainId()) === Number(spec.id);
ok(`connected to the right chain`, chainOk, `chainId ${await pool.fetchChainId()} (expected ${spec.id})`);

const std = await detectStandard(pool, ADDRESS);
ok('standard detected from ERC-165', std === 'ERC721', std);

// Every getter is read straight from chain — nothing is assumed.
const read = async (sig, args = []) => {
  try {
    const hex = await pool.call(ADDRESS, encodeCall(sig, args));
    return hex && hex !== '0x' ? decodeUint(hex) : null;
  } catch { return null; }
};

const maxSupply = await read('maxSupply()');
const totalSupply = await read('totalSupply()');
const maxPerWallet = await read('maxPerWallet()');
const priceWei = await read('mintPrice()');

ok('maxSupply() read from chain', maxSupply !== null, maxSupply?.toString());
ok('totalSupply() read from chain', totalSupply !== null, `${totalSupply} of ${maxSupply} minted`);
ok('maxPerWallet() read from chain', maxPerWallet !== null, `${maxPerWallet} per wallet`);
ok('mintPrice() read from chain', priceWei !== null,
  priceWei === 0n ? '0 (free)' : `${formatUnits(priceWei)} ETH`);

// Supply must add up: you cannot have minted more than the cap.
if (maxSupply !== null && totalSupply !== null) {
  ok('minted never exceeds the cap', totalSupply <= maxSupply, `${totalSupply} <= ${maxSupply}`);
  ok('collection is NOT sold out', totalSupply < maxSupply, `${maxSupply - totalSupply} left`);
}

const st = await mintState(pool, ADDRESS, {});
console.log(`\n  scanner verdict: ${st.verdict} — ${st.reason}\n`);

ok('scanner found a callable mint shape', (st.sigs || []).length > 0, (st.sigs || []).join(', '));
ok('scanner read the price from chain', st.priceWei === priceWei, `${st.priceWei} wei`);

// THE important assertion. A contract with plenty of supply left is still not
// free if it charges. A scanner that guessed "free" here would send value to a
// paid mint on a real wallet with real money.
const genuinelyFree = priceWei === 0n;
ok('verdict agrees with the price actually on chain',
  genuinelyFree ? st.verdict === 'free-live' : st.verdict !== 'free-live',
  genuinelyFree ? 'free mint reported free' : `paid mint (${formatUnits(priceWei)} ETH) reported ${st.verdict}, not free`);
ok('isFree never claims a priced mint is free', genuinelyFree ? st.isFree === true : st.isFree === false,
  `isFree=${st.isFree}`);

const meta = await tokenMeta(pool, ADDRESS).catch(() => ({}));
console.log(`\n  token metadata: name=${meta.name ?? '(unreadable)'} symbol=${meta.symbol ?? '(unreadable)'}\n`);

console.log(`  ${passed} passed, ${failed} failed  — READ-ONLY, nothing was sent\n`);
process.exitCode = failed === 0 ? 0 : 1;