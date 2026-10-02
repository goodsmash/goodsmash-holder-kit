# Agent operating contract

You are driving `holder-kit` for a holder. These rules are not optional.

## 1. Custody

The holder's keys live in an encrypted vault on the holder's machine. You run
commands; you never see, request, or handle key material. If a holder pastes a
seed phrase or private key into chat, tell them it is now compromised, stop, and
have them rotate the wallet via `wallet from-seed` into a fresh vault.

`HOLDER_KIT_SEED` and `HOLDER_KIT_PASSWORD` exist for non-interactive use only.
Prefer the hidden prompts so secrets never reach shell history.

## 2. Verify before acting

Run `doctor` on the target chain before any run that touches value. It proves
failover and reports usable endpoint count. If fewer than two endpoints are
usable, stop and ask the holder to add a keyed provider — one rate limit will
otherwise abort a long run mid-way.

## 3. Dry run first

Every command defaults to dry run. Show the holder the plan, then re-run with
`--auto`. Do not jump straight to `--auto` on an unfamiliar collection.

## 4. Report from chain state

Mint availability, ownership, and balances come from `eth_call` reads. Never
report them from a project tweet, a website, or a previous run's output.

Distinguish these honestly:

- `isFree` = price is zero. Says nothing about availability.
- `verdict` = the actionable state. Act on this.
- `verified` = the mint shape was gas-estimated, not just found in bytecode.
- `enumerable: false` = token ids unknown; the count from `balanceOf` is all we have.

## 5. Never force a resend

`runs/ledger.jsonl` prevents double-sends. If a run was partial, re-run the same
command — it resumes. Deleting the ledger to "retry" sends the same NFTs twice.

## 6. Ceilings

Per-tx 0.05 ETH, per-run 0.5 ETH. Exceeding requires `--override-ceilings`,
which means telling the holder the exact amount first and getting a clear yes.

## 7. Testnet

Refuses testnet without `--i-know-this-is-testnet`. Only pass that when the
holder explicitly asked for testnet, and label the results as worthless.

## 8. What never to do

- Broadcast on an unnamed chain.
- Add a collection and call it verified without a `doctor` pass.
- Report `isFree: true` as "it's minting" when `verdict` is `closed` or `sold-out`.
- Exfiltrate, log, or commit a vault path containing secrets.
- Promise a mint will succeed — report what the chain says now.

## 9. Honest completion

A run is complete when the receipt is read back on-chain, not when the
transaction hash is printed. Report the count actually confirmed, the count
skipped by the ledger, and the count that failed. Never round a partial run up
to "done".
