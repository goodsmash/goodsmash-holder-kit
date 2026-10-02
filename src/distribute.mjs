// NFT distribution: spread (round-robin over holders) and ship (explicit map).
//
// This is the "my holders can't send their NFTs to each other" fix. It is
// deliberately boring: one safeTransferFrom per NFT, resumable via a run ledger,
// dry-run by default, and it verifies ownership on-chain before it signs.
import { encodeCall, decodeAddress } from './abi.mjs';
import { erc721Inventory, detectStandard, tokenMeta } from './inventory.mjs';
import { RunLedger, gateBroadcast, dedupeAddresses, validateAddress, assertWithinLimits, assertAgentMayBroadcast, LIMITS } from './safety.mjs';

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
    for (const tokenId of inv.tokens) {
      // jobs.length is the global deal position. The old `(jobs.length + i)`
      // counted every token twice (push already grows jobs.length), so with an
      // EVEN number of recipients every NFT went to only half of them.
      const to = recipients[jobs.length % recipients.length];
      jobs.push({ from: entry.address, signer, tokenId: String(tokenId), to });
    }
  }

  console.log(`\nplan (${jobs.length} transfer${jobs.length === 1 ? '' : 's'}):`);
  const preview = jobs.slice(0, 15);
  for (const j of preview) console.log(`  #${j.tokenId}  ${short(j.from)} -> ${short(j.to)}`);
  if (jobs.length > preview.length) console.log(`  ... and ${jobs.length - preview.length} more`);

  if (dryRun) {
    const summary =
      `Would transfer ${jobs.length} NFT(s) from ${new Set(jobs.map((j) => j.from)).size} wallet(s)\n` +
      `across ${recipients.length} recipient(s). Gas is paid by each sending wallet.`;
    await gateBroadcast({ dryRun: true, summary, argv });
    return { planned: jobs.length, sent: 0 };
  }

  assertAgentMayBroadcast('transfer');
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
  validateAddress(collection, 'collection');

  // Parse strictly. A typo'd recipient used to go straight into encodeCall; a
  // bad line is now reported with its line number and the whole plan refused,
  // because a plan that is half-understood should not be half-executed.
  const lines = [];
  const problems = [];
  plan.forEach((raw, idx) => {
    const text = String(raw).replace(/\/\/.*$/, '').trim();
    if (!text || text.startsWith(';') || /^#(?!\d)/.test(text)) return; // comments
    const parts = text.replace(/#/g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return problems.push(`line ${idx + 1}: expected "<from> <tokenId> <to>", got "${text}"`);
    const [from, tokenId, to] = parts;
    if (!/^0x[0-9a-fA-F]{40}$/.test(from)) return problems.push(`line ${idx + 1}: bad from address ${from}`);
    if (!/^\d+$/.test(tokenId)) return problems.push(`line ${idx + 1}: token id must be a whole number, got ${tokenId}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return problems.push(`line ${idx + 1}: bad recipient address ${to}`);
    if (/^0x0{40}$/i.test(to)) return problems.push(`line ${idx + 1}: refusing to send to the zero address`);
    lines.push([from, tokenId, to]);
  });
  if (problems.length) throw new Error(`plan has ${problems.length} problem(s):\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  if (!lines.length) throw new Error('no valid plan lines. Expected: <from> <tokenId> <to>');
  if (lines.length > LIMITS.maxRecipients) throw new Error(`${lines.length} transfers exceeds the ${LIMITS.maxRecipients} per-run ceiling`);

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

  assertAgentMayBroadcast('transfer');
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const [from, tokenId, to] of lines) {
    const src = byAddr.get(String(from).toLowerCase());
    if (!src) {
      console.log(`   SKIP  ${short(from)} is not in your vault — add it with: holder-kit wallet add`);
      failed++;
      continue;
    }
    const key = `ship:${collection}:${tokenId}:${to}`;
    if (ledger.has(key)) {
      skipped++;
      continue;
    }
    try {
      await verifyOwnership(pool, collection, src.entry.address, tokenId);
      const data = encodeCall('safeTransferFrom(address,address,uint256)', [src.entry.address, to, tokenId]);
      const res = await src.signer.send({ to: collection, data });
      ledger.record(key, { hash: res.hash, tokenId, to, from: src.entry.address });
      sent++;
    } catch (e) {
      failed++;
      console.log(`   FAILED #${tokenId}: ${e.message.slice(0, 90)}`);
    }
  }
  console.log(`\ndone: ${sent} sent, ${skipped} already done, ${failed} failed (of ${lines.length})`);
  return { planned: lines.length, sent, skipped, failed };
}

/**
 * Top every recipient up to AT LEAST `amountEthEach` of native gas.
 *
 * Top-up, not blind send: a recipient that already holds the target is skipped,
 * and one that holds part of it receives only the difference. That makes `fund`
 * safe to re-run after a crash — the old version re-sent the full amount to
 * everyone on every run — and it silently dropped every recipient beyond the
 * number of wallets in the vault. Pass --exact to always send the full amount.
 *
 * Ceilings (per-tx and per-run) are enforced here; they used to be defined but
 * never called by any command.
 */
export async function fund({ pool, signers, recipients, amountEthEach, fromIndex, dryRun, argv = [] }) {
  const { parseUnits, formatUnits } = await import('./abi.mjs');
  if (!/^\d*\.?\d+$/.test(String(amountEthEach))) throw new Error(`--each must be a positive number, got ${amountEthEach}`);
  const target = parseUnits(String(amountEthEach), 18);
  if (target <= 0n) throw new Error('--each must be greater than 0');
  const from = signers[fromIndex || 0];
  if (!from) throw new Error(`no wallet at index ${fromIndex || 0}`);
  const exact = argv.includes('--exact');

  const list = dedupeAddresses(recipients, 'recipient').filter(
    (a) => a.toLowerCase() !== from.signer.address.toLowerCase()
  );
  if (!list.length) throw new Error('no recipients (other than the source wallet) supplied');

  const balances = exact
    ? list.map(() => 0n)
    : await Promise.all(list.map((a) => pool.getBalance(a)));
  const targets = list
    .map((address, i) => ({ address, have: balances[i], send: exact ? target : target > balances[i] ? target - balances[i] : 0n }))
    .filter((t) => t.send > 0n);
  const total = targets.reduce((a, t) => a + t.send, 0n);
  const totalEth = formatUnits(total);
  const maxTx = targets.reduce((m, t) => (t.send > m ? t.send : m), 0n);

  console.log(`\nsource    : ${from.signer.address}`);
  console.log(`target    : ${exact ? 'send exactly' : 'top up to'} ${amountEthEach} ${chainSymbol()} each`);
  console.log(`recipients: ${list.length} (${list.length - targets.length} already funded)`);
  console.log(`total     : ${totalEth} ${chainSymbol()}`);

  assertWithinLimits({
    perTxEth: Number(formatUnits(maxTx)),
    perRunEth: Number(totalEth),
    override: argv.includes('--override-ceilings'),
  });

  if (!targets.length) {
    console.log('\nevery recipient already holds the target. Nothing to send.');
    return { planned: 0, sent: 0, totalEth: '0' };
  }

  // Can the source actually pay for all of it (plus gas for each transfer)?
  const gasPrice = await pool.gasPrice();
  const gasEach = gasPrice * 21_000n * 2n;
  const srcBal = await pool.getBalance(from.signer.address);
  const needed = total + gasEach * BigInt(targets.length);
  if (srcBal < needed) {
    console.log(`\n  source holds ${formatUnits(srcBal)}, this run needs ~${formatUnits(needed)} incl. gas — it will run out part way.`);
  }

  if (dryRun) {
    await gateBroadcast({
      dryRun: true,
      summary: `Would send ${totalEth} ${chainSymbol()} in ${targets.length} transfer(s) from ${from.signer.address}.`,
      argv,
    });
    return { planned: targets.length, sent: 0, totalEth };
  }

  assertAgentMayBroadcast('fund');
  if (srcBal < needed && !argv.includes('--allow-partial')) {
    throw new Error('source wallet cannot cover this run. Top it up, lower --each, or pass --allow-partial.');
  }

  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      await from.signer.send({ to: t.address, value: t.send });
      sent++;
    } catch (e) {
      failed++;
      console.log(`   FAILED ${short(t.address)}: ${e.message.slice(0, 80)}`);
    }
  }
  console.log(`\ndone: ${sent}/${targets.length} funded, ${failed} failed`);
  return { planned: targets.length, sent, failed, totalEth };
}

function chainSymbol() {
  return process.env.HOLDER_KIT_SYMBOL || 'ETH';
}

function short(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

export { RunLedger };
