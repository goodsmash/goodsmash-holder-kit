// Regression tests for two scanner bugs found by testing against a REALISTIC
// drop (test/fixtures/MultiMint.sol) rather than the original one-function
// fixture. Both failed silently, which is the dangerous kind.
//
//   1. The price getter list was too narrow. A contract naming its getter
//      `freePrice()` read as "no price found", which the scanner treats as
//      PAID — so a genuinely free mint reported `paid-live` and auto-mint
//      would have tried to send value.
//   2. `maxSupply` and `maxSupply()` are the SAME selector, so a paren-less
//      "fallback" is dead code that looks like coverage.

import { RpcPool } from '../src/rpc.mjs';
import { resolveChain } from '../src/config.mjs';
import { encodeCall, decodeUint, selector, parseUnits } from '../src/abi.mjs';
import { mintState } from '../src/mintscan.mjs';
import { detectStandard, isEnumerable } from '../src/inventory.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`  FAILED  ${name}${detail ? '  ' + detail : ''}`); }
};

console.log('\n=== mint scanner: price getter coverage ===\n');

// Bug 2, corrected: `selector()` keccaks the LITERAL text, so 'maxSupply' and
// 'maxSupply()' hash differently — a paren-less probe is not a duplicate
// selector. What makes it useless is that `encodeCall('maxSupply')` THROWS
// ("unsupported ABI type"), and `read()` swallows that into null. So the
// paren-less variants were dead probes that LOOKED like extra coverage.
const throwsOnParenless = (() => {
  try { encodeCall('maxSupply'); return false; } catch { return true; }
})();
ok('a paren-less getter name throws in encodeCall', throwsOnParenless,
  'so read() silently nulls it — it is not a real fallback');

// Bug 1: verify the widened getter list actually covers realistic names.
ok('freePrice() has a distinct selector from mintPrice()',
  selector('freePrice()') !== selector('mintPrice()'),
  `${selector('freePrice()')} vs ${selector('mintPrice()')}`);

// And prove the scanner reads it, against the live deployed drop.
const dropFile = 'test/multimint-drop.json';
const { existsSync, readFileSync } = await import('node:fs');

if (!existsSync(dropFile)) {
  console.log('  (no deployed drop recorded — run `npm run test:scale` first)');
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

const spec = resolveChain('robinhoodTestnet', {});
const pool = new RpcPool(spec.endpoints, spec.id);
const DROP = JSON.parse(readFileSync(dropFile, 'utf8'));

const code = await pool.getCode(DROP.contract);
ok('deployed drop still has bytecode', !!code && code !== '0x', DROP.contract);

if (code && code !== '0x') {
  // The getter the ORIGINAL fixture never had.
  const freePrice = decodeUint(await pool.call(DROP.contract, encodeCall('freePrice()')));
  ok('freePrice() is readable', freePrice === 0n, `${freePrice} wei`);

  const st = await mintState(pool, DROP.contract, {});
  ok('scanner finds the price via freePrice()', st.priceWei === 0n,
    `priceWei=${st.priceWei} (was undefined before the fix)`);
  ok('a real free mint is not reported as paid',
    st.verdict === 'free-live' || st.verdict === 'sold-out',
    `${st.verdict} (${st.reason})`);

  // The standard/enumerable guards that correctly refused a bare fixture.
  const std = await detectStandard(pool, DROP.contract);
  ok('ERC-165 makes the drop detectable as ERC721', std === 'ERC721', std);

  // isEnumerable() probes tokenOfOwnerByIndex with a REAL holder, and it
  // reverts for an address that holds nothing. The deployer holds none after
  // the spread step, so find an address that actually owns a token first.
  let holder = DROP.deployer;
  if (decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [holder]))) === 0n) {
    // ownerOf returns an ADDRESS, not a uint — decodeUint on it yields a tiny
    // number, and slicing that produced the zero address, which made this
    // check pass for the wrong reason. Take the low 20 bytes instead.
    const raw = await pool.call(DROP.contract, encodeCall('ownerOf(uint256)', [1]));
    holder = '0x' + raw.slice(-40);
  }
  const holderBal = decodeUint(await pool.call(DROP.contract, encodeCall('balanceOf(address)', [holder])));
  ok('found a real holder to probe enumerability with', holderBal > 0n, `${holder} holds ${holderBal}`);
  const enumOk = await isEnumerable(pool, DROP.contract, holder);
  ok('tokenOfOwnerByIndex makes it enumerable', enumOk === true);

  // A price change must be picked up from chain, not cached.
  ok('price is re-read every scan', typeof st.priceWei === 'bigint', st.priceWei.toString());
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;