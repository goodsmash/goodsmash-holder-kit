---
name: holder-kit
description: Use when a holder wants to check RPC health, see what their wallets hold, find free on-chain NFT mints, or preview/run NFT sends, gas top-ups and free mints from their local encrypted holder-kit vault. Self-custodied; keys never leave the machine.
version: 1.1.0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    category: web3
    tags: [web3, evm, wallet, nft, rpc, mint, self-custody, holders]
    related_skills: [local-secret-material-handling, robinhood-chain, evm-nft-launch-hardening]
---

# holder-kit

Self-custodied NFT holder toolkit running on this machine. You drive it through
one command, written below as `hk`:

```bash
node {{HK_WRAPPER}} <command> [flags]
```

That wrapper runs the CLI in **agent mode** (`HOLDER_KIT_AGENT=1`). Always use
it — never call `bin/holder-kit.mjs` directly, which would skip the agent policy.
Repo: `{{HK_HOME}}`.

## Rules that outrank everything

1. **Never ask for, accept, print or store a private key, seed phrase or vault
   password.** If the holder pastes one into chat, tell them it is now exposed,
   stop, and have them move funds to a fresh wallet (`wallet from-seed` /
   `wallet new`, run by them in their own terminal).
2. **Never read or print** `vault/PASSWORD.txt`, `vault/*`, or
   `config/endpoints.json` (it holds RPC API keys). Do not `cat`, `grep`, copy,
   upload or summarise them. The CLI reads them itself.
3. **Never edit the agent policy.** Do not set or change `HOLDER_KIT_AGENT`,
   `HOLDER_KIT_AGENT_BROADCAST`, `HOLDER_KIT_PASSWORD*`, or `HOLDER_KIT_AUTO`, and
   never delete `runs/ledger.jsonl`. Those are the holder's controls.
4. **Report chain state, not guesses.** Availability, prices, balances and
   ownership come from the command output. Never from a tweet, website or a
   previous run.

## What you may do (agent mode enforces this)

| Policy (`HOLDER_KIT_AGENT_BROADCAST`, set by the holder) | You can broadcast |
|---|---|
| `none` (default) | nothing — reads and dry runs only |
| `free-mints` | zero-price mints via `auto` / `watch` / `mint` |
| `all` | any command, still under the 0.05 / 0.5 ETH ceilings |

Always refused in agent mode: `--override-ceilings`, `wallet remove`,
`wallet change-password`, `wallet restore`. If the CLI exits **2** with
`agent mode: …`, that is the policy working — show the holder the dry run and
tell them the exact command to run themselves. Do not look for a workaround.

Check the current policy any time: `hk agents`.

## Standard flow

```bash
hk check --json                     # vault unlocks? RPC up? policy?
hk doctor --chain robinhoodMainnet  # MUST pass before anything touching value
hk find --json                      # what is free and live right now
hk scan --json                      # what the wallets hold
```

If `check` says the vault is missing, the holder runs `setup` **themselves**
in their own terminal (`node bin/holder-kit.mjs setup`). Never run setup for them.

`doctor` with fewer than 2 working endpoints → stop and ask the holder to add a
keyed RPC (`rpc add`, run by them; the URL contains an API key).

## Doing things

Every value-moving command is a **dry run unless `--execute` or `--auto` is
passed**. Always run the dry run first, show the holder the plan, and only add
`--execute` after they say yes in this conversation.

| Intent | Dry run (always first) | Then, with a clear yes |
|---|---|---|
| Mint every free live mint | `hk auto [--collection 0x…]` | add `--auto` |
| Wait for a free window | `hk watch --collection 0x… --interval 20` | add `--auto` |
| Probe one collection | `hk mint-report 0x…` | — |
| Deal NFTs to holders | `hk spread --collection 0x… --to holders.txt` | add `--execute` |
| Specific token → person | `hk ship --collection 0x… --plan plan.txt` | add `--execute` |
| Top up gas | `hk fund --each 0.005 [--to list]` | add `--execute` |

`fund` tops each recipient **up to** `--each`; recipients already holding it are
skipped, so re-running is safe. `spread`/`ship` keep a ledger; re-running after a
crash resumes and never double-sends.

## Reading results honestly

- Act on `verdict`, never on `isFree`. `isFree` is about price; a sold-out free
  mint is still `isFree: true`.

  | verdict | meaning |
  |---|---|
  | `free-live` | price 0, open, supply left, callable |
  | `paid-live` | open but costs native — ask before spending |
  | `sold-out` / `closed` | nothing to do |
  | `not-a-contract` | wrong address |

- `verified: false` = mint shape found in bytecode, not gas-estimated.
- `enumerable: false` = token ids unknown; only the count is real.
- A run is done when receipts are confirmed. Report **confirmed / skipped /
  failed** counts exactly as printed. Never round a partial run up to "done".
- Exit codes: `0` ok, `1` error or nothing found (`find` exits 1 when nothing
  is free), `2` refused by a safety rule or agent policy.

## Failure modes

- `All N RPC endpoint(s) unavailable` — real outage or every provider throttled.
  Report it; don't loop.
- `call would revert, not broadcast` — the contract said no (closed, limit,
  sold out). Not an RPC problem.
- `vault is locked …` — no password source. The holder fixes it; never ask for
  the password.
- `safety ceiling exceeded` — split the run. Never suggest `--override-ceilings`
  to get around it; only the holder may choose that, in their own terminal.
