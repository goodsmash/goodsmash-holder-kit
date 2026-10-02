// NFT distribution: spread (round-robin over holders) and ship (explicit map).
//
// This is the "my holders can't send their NFTs to each other" fix. It is
// deliberately boring: one safeTransferFrom per NFT, resumable via a run ledger,
// dry-run by default, and it verifies ownership on-chain before it signs.
import { encodeCall, decodeAddress } from './abi.mjs';
import { erc721Inventory, detectStandard, tokenMeta } from './inventory.mjs';
import { RunLedger, gateBroadcast, dedupeAddresses } from './safety.mjs';

/** Confirm the vault wallet really owns the token right now. */
export async function verifyOwnership(pool, collection, owner, tokenId) {
  const out = await pool.call(collection, encodeCall('ownerOf(uint256)', [tokenId]));
  const actual = decodeAddress(out);
  if (!actual || actual.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `token ${tokenId} is owned by ${actual}, not ${owner} — refusing to sign a transfer that would revert`
    );
  }
  return true;
}

/**
 * Spread: deal a holder's NFTs round-robin to a recipient list.
 * Deterministic, so a re-run after a partial failure deals the same way.
 */
export async function spread({ pool, chainSpec, signers, collection, recipients, dryRun, ledger, limit, argv = [] }) {
  recipients = dedupeAddresses(recipients, 'recipient');
  if (!recipients.length) throw new Error('no recipients supplied');

  const std = await detectStandard(pool, collection);
  const meta = await tokenMeta(pool, collection);
  console.log(`\ncollection : ${meta.name || collection} (${meta.symbol || '?'})`);
  console.log(`standard   : ${std}`);
  console.log(`collection : ${collection}`);
  console.log(`recipients : ${recipients.length}`);

  if (std !== 'ERC721') {
    throw new Error(`${collection} is ${std}; this command handles enumerable ERC-721. ERC-1155 needs an explicit id list.`);
  }

  const jobs = [];
  for (const { entry, signer } of signers) {
    const inv = await erc721Inventory(pool, collection, entry.address, { limit: limit || 5000 });
    if (!inv.enumerable) {
      throw new Error(
        `${collection} is not enumerable, so holder ${entry.address} owns tokens this tool cannot list. ` +
          `Use the collection's own Transfer logs, or Blockscout, to find token ids.`
      );
    }
    inv.tokens.forEach((tokenId, i) => {
      const to = recipients[(jobs.length + i) % recipients.length];
      jobs.push({ from: entry.address, signer, tokenId: String(tokenId), to });
    });
  }

  console.log(`\nplan (${jobs.length} transfer${jobs.length === 1 ? '' : 's'}):`);
  const preview = jobs.slice(0, 15);
  for (const j of preview) console.log(`  RIG #${j.tokenId}  ${short(j.from)} -> ${short(j.to)}`);
  if (jobs.length > preview.length) console.log(`  ... and ${jobs.length - preview.length} more`);

  if (dryRun) {
    const summary =
      `Would transfer ${jobs.length} NFT(s) from ${new Set(jobs.map((j) => j.from)).size} wallet(s)\n` +
      `across ${recipients.length} recipient(s). Gas is paid by each sending wallet.`;
    await gateBroadcast({ dryRun: true, summary, argv });
    return { planned: jobs.length, sent: 0 };
  }

  let sent = 0;
  let skipped = 0;
  for (const j of jobs) {
    const key = `spread:${collection}:${j.tokenId}:${j.to}`;
    if (ledger.has(key)) {
      skipped++;
      continue;
    }
    try {
      await verifyOwnership(pool, collection, j.from, j.tokenId);
      const data = encodeCall('safeTransferFrom(address,address,uint256)', [j.from, j.to, j.tokenId]);
      const res = await j.signer.send({ to: collection, data });
      ledger.record(key, { hash: res.hash, tokenId: j.tokenId, to: j.to, from: j.from });
      sent++;
    } catch (e) {
      console.log(`   FAILED token ${j.tokenId}: ${e.message.slice(0, 90)}`);
    }
  }
  console.log(`\ndone: ${sent} sent, ${skipped} already done, ${jobs.length - sent - skipped} failed`);
  return { planned: jobs.length, sent, skipped };
}

/**
 * Ship: send specific tokens to specific recipients, from a specific wallet.
 * plan format, one per line: `<fromAddressOrIndex> <tokenId> <toAddress>`
 */
export async function ship({ pool, chainSpec, signers, collection, plan, dryRun, ledger, argv = [] }) {
  const byAddr = new Map(signers.map((s) => [s.entry.address.toLowerCase(), s]));
  const lines = plan
    .map((l) => l.replace(/#/g, '').split(/\s+/).filter(Boolean))
    .filter((p) => p.length >= 3);

  if (!lines.length) throw new Error('no valid plan lines. Expected: <from> <tokenId> <to>');

  console.log(`\nplan (${lines.length} transfer${lines.length === 1 ? '' : 's'}):`);
  for (const [from, tokenId, to] of lines.slice(0, 15)) {
    console.log(`  #${tokenId}  ${short(from)} -> ${short(to)}`);
  }
  if (lines.length > 15) console.log(`  ... and ${lines.length - 15} more`);

  if (dryRun) {
    const summary = `Would transfer ${lines.length} specific NFT(s) in ${collection}.`;
    await gateBroadcast({ dryRun: true, summary, argv });
    return { planned: lines.length, sent: 0 };
  }

  let sent = 0;
  for (const [from, tokenId, to] of lines) {
    const src = byAddr.get(String(from).toLowerCase());
    if (!src) {
      console.log(`   SKIP  ${short(from)} is not in your vault — add it with: holder-kit wallet add`);
      continue;
    }
    const key = `ship:${collection}:${tokenId}:${to}`;
    if (ledger.has(key)) continue;
    try {
      await verifyOwnership(pool, collection, src.entry.address, tokenId);
      const data = encodeCall('safeTransferFrom(address,address,uint256)', [src.entry.address, to, tokenId]);
      const res = await src.signer.send({ to: collection, data });
      ledger.record(key, { hash: res.hash, tokenId, to, from: src.entry.address });
      sent++;
    } catch (e) {
      console.log(`   FAILED #${tokenId}: ${e.message.slice(0, 90)}`);
    }
  }
  console.log(`\ndone: ${sent} sent of ${lines.length}`);
  return { planned: lines.length, sent };
}

/**
 * Split native gas across wallets so each can act on its own.
 * Sending native currency is irreversible, so it is dry-run by default and
 * ceiling-checked like everything else.
 */
export async function fund({ signers, recipients, amountEthEach, fromIndex, dryRun, argv }) {
  const { parseUnits, formatUnits } = await import('./abi.mjs');
  const amount = parseUnits(String(amountEthEach), 18);
  const from = signers[fromIndex || 0];
  if (!from) throw new Error(`no wallet at index ${fromIndex || 0}`);

  const targets = recipients.map((a, i) => ({ address: a, signer: signers[i] })).filter((t) => t.signer);
  const total = amount * BigInt(targets.length);
  const totalEth = formatUnits(total);

  console.log(`\nsource   : ${from.signer.address}`);
  console.log(`each     : ${amountEthEach} ${chainSymbol()}`);
  console.log(`recipients: ${targets.length}`);
  console.log(`total    : ${totalEth} ${chainSymbol()}`);

  if (dryRun) {
    await gateBroadcast({
      dryRun: true,
      summary: `Would send ${amountEthEach} to each of ${targets.length} wallets (${totalEth} total) from ${from.signer.address}.`,
      argv,
    });
    return { planned: targets.length, sent: 0, totalEth };
  }

  let sent = 0;
  for (const t of targets) {
    try {
      const res = await from.signer.send({ to: t.address, value: amount });
      sent++;
      void res;
    } catch (e) {
      console.log(`   FAILED ${short(t.address)}: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`\ndone: ${sent}/${targets.length} funded`);
  return { planned: targets.length, sent, totalEth };
}

function chainSymbol() {
  return process.env.HOLDER_KIT_SYMBOL || 'ETH';
}

function short(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

export { RunLedger };
