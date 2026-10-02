# Agent operating contract

You are driving `holder-kit` for a holder. These rules are not optional.

## 1. Custody

The holder's keys live in an encrypted vault on the holder's machine. You run
commands; you never see, request, or handle key material. If a holder pastes a
seed phrase or private key into chat, tell them it is now compromised, stop, and
have them rotate the wallet via `wallet from-seed` into a fresh vault.

`HOLDER_KIT_SEED` and `HOLDER_KIT_PASSWORD` exist for non-interactive use only.
Prefer the hidden prompts so secrets never reach shell history. The CLI refuses
`--password` and `--phrase` on the command line for the same reason.

The vault unlocks itself from `vault/PASSWORD.txt` (written by `setup`), so an
agent never needs, and must never be given, the password.

### Never ask for a key

Do not ask a holder to paste a private key or seed phrase into chat, ever — not
"just to test", not "temporarily". The holder runs `setup` themselves; you then
drive the CLI, which reads the vault locally. If offered a key, decline once and
continue with the commands.

Never print, echo, or partially reveal `vault/PASSWORD.txt` or the contents of
`config/endpoints.json` (which holds the holder's RPC API keys). Both are
gitignored for exactly this reason.

## 1a. Agent mode — enforced in code, not just in this document

Agents run the CLI with `HOLDER_KIT_AGENT=1` (the Hermes wrapper from
`npm run hermes:install` does this). The holder picks what the agent may sign:

| `HOLDER_KIT_AGENT_BROADCAST` | Agent may broadcast |
|---|---|
| `none` (default) | nothing — reads and dry runs only |
| `free-mints` | zero-price mints only |
| `all` | anything, under the ceilings |

Refused at every level: `--override-ceilings`, `wallet remove`,
`wallet change-password`, `wallet restore`. A refusal exits with code **2** and
a message starting `agent mode:`. Treat it as final: show the dry run, tell the
holder the command, and stop. Never change the policy, the wrapper, or its
`policy.json` yourself.

This is a guardrail, not a sandbox. Anything with a shell as the holder could
bypass it, which is why rules 1, 7 and 10 still matter.

## 2. Onboarding a holder

The holder runs one command; you never do it for them:

```bash
node bin/holder-kit.mjs setup --wallets 20
```

It creates the vault, generates a password into `vault/PASSWORD.txt` (never
overwriting an existing one), makes the wallets, writes a verified backup,
checks the chain, and prints the next command. Then `check` proves the
install works. If `setup` reports a failed check, show the user that line and
the suggested fix rather than moving on.

## 3. RPC speed and reliability

Rate limits are the most common cause of a long run dying half way. Fix it once,
properly:

```bash
node bin/holder-kit.mjs rpc add <url> --name <label>   # as many as needed
node bin/holder-kit.mjs bench --chain robinhoodMainnet # real measured speed
```

Endpoints are ranked by live latency; the fastest healthy one is used first with
automatic failover. Two providers on different upstreams is the practical
minimum — one rate limit then cannot stop a run. `bench` reports chain id and
block per endpoint; an endpoint showing "wrong chain" must not be used.

Provider URLs contain API keys. Add them, never print them.

## 4. Verify before acting

Run `doctor` on the target chain before any run that touches value. It proves
failover and reports usable endpoint count. If fewer than two endpoints are
usable, stop and ask the holder to add a keyed provider — one rate limit will
otherwise abort a long run mid-way.

## 5. Dry run first

Every command defaults to dry run — including `auto`. Show the holder the plan,
then re-run with `--execute` / `--auto` only after a clear yes. Do not jump
straight to `--auto` on an unfamiliar collection. Dry runs never prompt and exit
0, so they are safe to run unattended.

Use `--json` on `check`, `find`, `scan`, `wallet list` and `chains` and parse
the result rather than scraping coloured text.

## 6. Report from chain state

Mint availability, ownership, and balances come from `eth_call` reads. Never
report them from a project tweet, a website, or a previous run's output.

Distinguish these honestly:

- `isFree` = price is zero. Says nothing about availability.
- `verdict` = the actionable state. Act on this.
- `verified` = the mint shape was gas-estimated, not just found in bytecode.
- `enumerable: false` = token ids unknown; the count from `balanceOf` is all we have.

## 7. Never force a resend

`runs/ledger.jsonl` prevents double-sends for `spread`/`ship`; `fund` tops up
to a target instead of sending blindly, so it is also safe to re-run. If a run was partial, re-run the same
command — it resumes. Deleting the ledger to "retry" sends the same NFTs twice.

## 8. Ceilings

Per-tx 0.05 ETH, per-run 0.5 ETH. Exceeding requires `--override-ceilings`,
which means telling the holder the exact amount first and getting a clear yes.

## 9. Testnet

Refuses testnet without `--i-know-this-is-testnet`. Only pass that when the
holder explicitly asked for testnet, and label the results as worthless.

## 10. What never to do

- Broadcast on an unnamed chain.
- Add a collection and call it verified without a `doctor` pass.
- Report `isFree: true` as "it's minting" when `verdict` is `closed` or `sold-out`.
- Exfiltrate, log, or commit a vault path containing secrets.
- Promise a mint will succeed — report what the chain says now.

## 11. Honest completion

A run is complete when the receipt is read back on-chain, not when the
transaction hash is printed. Report the count actually confirmed, the count
skipped by the ledger, and the count that failed. Never round a partial run up
to "done".
