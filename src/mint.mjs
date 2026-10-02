// Mint helper: read a collection's real mint shape, then mint per wallet.
//
// The point is to STOP holders burning gas on failed mint attempts. This probes
// the contract first, reports price/limits/paused state, and refuses to send
// when the numbers say it will revert.
import { encodeCall, decodeUint, parseUnits, formatUnits } from './abi.mjs';
import { probeMint, detectStandard } from './inventory.mjs';
import { gateBroadcast } from './safety.mjs';

export async function mintReport(pool, collection) {
  const info = await probeMint(pool, collection);
  console.log(`\ncollection : ${collection}`);
  console.log(`standard   : ${await detectStandard(pool, collection)}`);
  console.log(`mint shapes: ${info.mintShapes.length ? info.mintShapes.join(', ') : 'NONE FOUND'}`);

  if (info.mintPriceWei != null) console.log(`price      : ${formatUnits(info.mintPriceWei)} per mint`);
  if (info.maxPerWallet != null) console.log(`max/wallet : ${formatUnits(info.maxPerWallet)}`);
  if (info.maxPerTx != null) console.log(`max/tx     : ${formatUnits(info.maxPerTx)}`);
  if (info.totalMinted != null) console.log(`minted     : ${formatUnits(info.totalMinted)}`);
  if (info.maxSupply != null) {
    const pct = info.maxSupply ? (Number(info.totalMinted || 0n) / Number(info.maxSupply)) * 100 : 0;
    console.log(`max supply : ${formatUnits(info.maxSupply)}  (${pct.toFixed(1)}% minted)`);
  }
  if (info.saleIsActive === 0n) console.log(`sale state : INACTIVE — minting will revert`);

  if (!info.mintShapes.length) {
    console.log(
      `\n  No mint function could be probed. That usually means the sale is closed,` +
        `\n  the contract is paused, or the mint takes arguments this tool does not model.` +
        `\n  Mint from the project's own site instead.`
    );
  }
  return info;
}

/**
 * Mint `quantity` per wallet across the vault, spending from each wallet itself.
 * Each wallet must already hold enough native currency; this never moves funds
 * between wallets on its own (use `fund` for that, deliberately).
 */
export async function mintAll({
  pool,
  collection,
  signers,
  quantity = 1,
  dryRun,
  argv,
  shape,
  valueOverrideEth,
}) {
  const info = await probeMint(pool, collection, { probeFrom: signers[0]?.signer?.address });

  const chosen =
    shape ||
    info.mintShapes.find((s) => s.includes('uint256') && !s.includes('address')) ||
    info.mintShapes[0];

  if (!chosen) {
    await mintReport(pool, collection);
    throw new Error('no usable mint function found — mint from the project site instead');
  }

  const price = info.mintPriceWei ?? 0n;
  const perWalletWei = price * BigInt(quantity);
  const hasValueArg = chosen.includes('uint256') || chosen === 'mint()';

  console.log(`\ncollection : ${collection}`);
  console.log(`function   : ${chosen}(${quantity})`);
  console.log(`price      : ${formatUnits(price)} each`);
  console.log(`per wallet : ${formatUnits(perWalletWei)}`);
  console.log(`wallets    : ${signers.length}`);
  console.log(`max supply : ${info.maxSupply != null ? formatUnits(info.maxSupply) : 'unknown'}`);

  if (info.saleIsActive === 0n) throw new Error('sale reports INACTIVE — minting would revert');
  if (info.maxSupply != null && info.totalMinted != null) {
    const remaining = info.maxSupply - info.totalMinted;
    const need = BigInt(quantity) * BigInt(signers.length);
    if (need > remaining) {
      throw new Error(
        `not enough supply left: ${formatUnits(remaining)} remaining, this run needs ${formatUnits(need)}`
      );
    }
  }

  const gasPrice = await pool.gasPrice();
  const gasCost = (gasPrice * 300_000n * BigInt(signers.length));

  console.log(`\neach wallet also needs ~${formatUnits(gasCost / BigInt(Math.max(1, signers.length)))} gas`);
  console.log(`total native required : ${formatUnits(perWalletWei * BigInt(signers.length) + gasCost)}`);

  const value = valueOverrideEth != null ? parseUnits(String(valueOverrideEth), 18) : perWalletWei;

  // Preflight balances so a dry run tells the truth about what will work.
  const balances = await Promise.all(signers.map((s) => s.signer.balance()));
  const need = value + gasCost / BigInt(Math.max(1, signers.length));
  const shortList = signers.filter((s, i) => balances[i] < need);

  if (shortList.length) {
    console.log(`\n  ${shortList.length} wallet(s) are underfunded and WILL fail:`);
    for (const s of shortList.slice(0, 10)) {
      const b = balances[signers.indexOf(s)];
      console.log(`    ${s.signer.address}  has ${formatUnits(b)}, needs ${formatUnits(need)}`);
    }
    console.log(`  Fix with: holder-kit fund --each 0.01 --to <underfunded addresses>`);
  }

  if (dryRun) {
    await gateBroadcast({
      dryRun: true,
      summary: `Would mint ${quantity} per wallet from ${collection} via ${chosen} across ${signers.length} wallet(s).\n` +
        `Total native spend: ${formatUnits(value * BigInt(signers.length) + gasCost)} (paid by each wallet).`,
      argv,
    });
    return { planned: signers.length, sent: 0, underfunded: shortList.length };
  }

  if (shortList.length && !argv.includes('--skip-underfunded')) {
    throw new Error(
      `${shortList.length} wallet(s) underfunded. Fund them with \`fund\`, or pass --skip-underfunded to mint only what can succeed.`
    );
  }

  let sent = 0;
  for (const s of signers) {
    const i = signers.indexOf(s);
    if (balances[i] < need) {
      console.log(`   SKIP ${s.signer.address} — underfunded`);
      continue;
    }
    try {
      let data;
      if (chosen === 'mint()') data = encodeCall('mint()', []);
      else if (chosen === 'mint(address,uint256)') data = encodeCall('mint(address,uint256)', [s.signer.address, quantity]);
      else if (chosen === 'mint(uint256)') data = encodeCall('mint(uint256)', [quantity]);
      else {
        const name = chosen.slice(0, chosen.indexOf('('));
        data = encodeCall(chosen, [quantity]);
        void name;
      }
      if (!hasValueArg && value > 0n) value = 0n;
      const res = await s.signer.send({ to: collection, data, value });
      sent++;
      void res;
    } catch (e) {
      console.log(`   FAILED ${s.signer.address}: ${e.message.slice(0, 90)}`);
    }
  }
  console.log(`\ndone: ${sent}/${signers.length} minted`);
  return { planned: signers.length, sent };
}

export { decodeUint };
