---
name: holder-kit
description: Use when a holder needs wallets backed up, NFTs sent to other wallets, gas split across wallets, or a free on-chain mint caught automatically. Runs fully hands-free from an encrypted local vault.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [web3, evm, wallet, nft, rpc, mint, self-custody, holders]
    related_skills: [local-secret-material-handling, robinhood-chain, evm-nft-launch-hardening]
---

# holder-kit

Self-custodied holder toolkit. One-time vault setup, then **zero signing prompts**.

## The rule that outranks everything

**Never accept, request, or handle a holder's private key or seed phrase in
conversation.** The holder pastes it once into a hidden local prompt inside the
tool; from then on the tool signs locally. If a holder offers you a key, tell
them to run `wallet from-seed` themselves and paste nothing to you.

Never print, log, echo, or commit key material. `assertNoSecretLeak()` in
`src/vault.mjs` is a backstop, not permission.

## Setup flow

Run these in order; do not skip `doctor`.

```bash
node bin/holder-kit.mjs init                    # encrypted vault, hidden password
node bin/holder-kit.mjs wallet from-seed        # holder pastes phrase THEMSELVES
node bin/holder-kit.mjs wallet backup <path>    # second location, immediately
cp config/endpoints.example.json config/endpoints.json   # holder adds their RPC
node bin/holder-kit.mjs doctor --chain <chain>  # MUST pass before anything else
```

`doctor` proves failover by breaking the first endpoint on purpose. Fewer than
two usable endpoints means one rate limit will stop a run — tell the holder to
add a keyed provider before doing anything at scale.

## Command reference

| Intent | Command |
|---|---|
| Is anything free/live? | `find [--address 0x...]` — exit 0 when free+live |
| Mint all free mints, no prompts | `auto [--quantity N]` |
| Wait for a free window, then mint | `watch --collection 0x... --interval 20` |
| Send NFTs round-robin to holders | `spread --collection 0x... --to <file> --auto` |
| Send specific NFTs to specific people | `ship --collection 0x... --plan <file> --auto` |
| Split gas across wallets | `fund --each 0.005 --to <file> --auto` |
| What do we hold? | `scan [--chain X]` |
| Probe one collection's mint rules | `mint-report 0x...` |

Dry run is the default everywhere. `--auto` skips the prompt; `--execute` sends
after a dry-run preview.

## Reading mint verdicts correctly

`find` / `auto` derive verdicts from chain state only. Never infer availability
from a tweet, a website, or a project claim.

| Verdict | Meaning | Action |
|---|---|---|
| `free-live` | price 0, not paused, supply left, callable | mint it |
| `paid-live` | open but costs native | ask the holder before spending |
| `sold-out` | `totalMinted >= maxSupply` | nothing to do |
| `closed` | paused, inactive, or no callable shape | nothing to do |
| `not-a-contract` | no bytecode at that address | wrong address |

`isFree` describes **price**, not availability — a sold-out free mint still
reports `isFree: true`. **Act on `verdict`, never on `isFree`.**

`verified: false` means the mint shape was detected from bytecode rather than
gas-estimated. Prefer a funded-wallet probe (`auto`/`watch` do this) before
minting on an unverified shape.

## Failure modes worth knowing

- **`All N RPC endpoint(s) unavailable`** — real outage or all providers
  rate-limited. Report it; do not retry blindly.
- **Reverts are not endpoint failures.** The failover layer does not bench a
  provider for a revert. If you see `[rpc] ... execution reverted`, the contract
  answered; read the reason instead of hunting for a bad RPC.
- **Non-enumerable collections** — `balanceOf` works but token ids cannot be
  listed. `scan` marks these `enumerable: false`. Do not claim a holder owns
  specific ids you could not read.
- **Unfunded wallets** — `mint`/`auto` list underfunded wallets and refuse to
  run unless `--skip-underfunded`. Fund them with `fund` first.
- **Run ledger** — a re-run after a crash skips anything already confirmed.
  Never delete `runs/ledger.jsonl` to "force" a resend; that double-sends.

## Never

- Broadcast on a chain the holder did not name.
- Add a collection to `config/chains.json` and call it verified without a
  `doctor` pass on that chain.
- Report a mint as free based on price alone when `verdict` is `closed`.
- Move native currency the holder did not ask to move. `fund` is opt-in only.
- Put a vault path, key, or seed anywhere public.

## Environment

- `HOLDER_KIT_VAULT` — override vault path.
- `HOLDER_KIT_CHAIN` — default chain key.
- `HOLDER_KIT_AUTO=1` — make `--auto` the default for every command.
- `HOLDER_KIT_SEED` — seed for non-interactive setup only; prefer the hidden
  prompt so it never lands in shell history.
