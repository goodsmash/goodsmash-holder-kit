# holder-kit

**One-time setup. Then you never sign anything again.**

A self-custodied toolkit for NFT holders: back up your wallets, send your NFTs to
other wallets, split gas, and catch free mints on-chain — all without a hardware
wallet, a browser popup, or clicking "confirm" forty times.

Private keys are generated or imported **on your own machine**, encrypted with
AES-256-GCM, and signed locally. They are never sent to the project, to us, or
to any third-party signer. There is no key server and no telemetry in this repo.

---

## Why this exists

Holders kept hitting the same walls:

- "My NFTs won't send to another wallet." → `spread` / `ship`
- "I need 20 wallets with gas in each." → `wallet new` + `fund`
- "I have no idea if a mint is free and open." → `find`
- "Every run dies with 'rate limited'." → multi-RPC failover + `doctor`
- "Backing up keys is scary." → `wallet backup`, encrypted, verified

---

## Install

```bash
git clone https://github.com/goodsmash/goodsmash-holder-kit
cd goodsmash-holder-kit
npm install
```

Requires Node.js 20+.

---

## One-time setup

```bash
# 1. Create the encrypted vault (choose a password)
node bin/holder-kit.mjs init

# 2. Get your wallets in — pick ONE
node bin/holder-kit.mjs wallet from-seed      # paste a recovery phrase (hidden input)
node bin/holder-kit.mjs wallet new 20        # generate 20 fresh wallets
node bin/holder-kit.mjs wallet add keys.json # import existing keys

# 3. Back the vault up somewhere else, NOW
node bin/holder-kit.mjs wallet backup D:/my-cold-backup.vault
```

After step 2 you never sign anything by hand again. Every command below reads
the key from the vault and signs locally.

> **Back up the vault file.** It is the only thing standing between you and your
> wallets. Open the backup once on another machine before you trust it — a backup
> that has never been opened is a hypothesis, not a backup.

---

## Add an RPC (this is the single highest-value fix)

Public RPCs get rate limited. That is the #1 cause of "my run just stopped".

```bash
cp config/endpoints.example.json config/endpoints.json
# paste your URL — free tier available at https://app.quicknode.com
```

Then check it works:

```bash
node bin/holder-kit.mjs doctor --chain robinhoodMainnet
```

`doctor` times every endpoint, **proves failover by deliberately breaking the
first one**, and tells you how many usable endpoints you have. Fewer than two
working endpoints means one rate limit will stop you.

---

## Everyday commands

Everything below is **dry-run by default**. It prints exactly what it would do
and sends nothing. Add `--auto` to run it hands-free.

### What's free right now?

```bash
node bin/holder-kit.mjs find --chain robinhoodMainnet
node bin/holder-kit.mjs find --address 0xYourCollection
```

Reads real chain state — price, pause flag, sale-active, supply remaining — and
prints one of: `FREE LIVE`, `PAID LIVE`, `SOLD OUT`, `CLOSED`. Exit code is `0`
when something is free and live, so you can script on it.

### Mint it automatically

```bash
# find every free live mint and mint from all your wallets
node bin/holder-kit.mjs auto --quantity 1

# or watch one collection and fire the moment a free window opens
node bin/holder-kit.mjs watch --collection 0xYourCollection --interval 20
```

No prompts. It polls, detects the window from chain state, and mints from every
funded wallet in your vault.

### Send NFTs to other wallets

```bash
# deal your NFTs round-robin to a list of recipients
echo "0xaaa...  0xbbb...  0xccc..." > holders.txt
node bin/holder-kit.mjs spread --collection 0x1DFE1eE1BBa83152223e676f496feaE62406bB56 --to holders.txt --auto

# or send specific tokens to specific people
echo "0xFrom  42  0xTo" > plan.txt
node bin/holder-kit.mjs ship --collection 0x1DFE... --plan plan.txt --auto
```

`spread` verifies on-chain ownership before it signs anything, and records every
confirmed transfer in a run ledger — re-running after a crash never double-sends.

### Split gas across wallets

```bash
node bin/holder-kit.mjs fund --each 0.005 --to wallets.txt --auto
```

### See what you hold

```bash
node bin/holder-kit.mjs scan --chain robinhoodMainnet
```

NFT ids and native balance per wallet, per collection.

---

## Safety model

| Guard | Behaviour |
|---|---|
| Dry run | **Default.** Prints the plan, sends nothing. |
| `--auto` | Skips the prompt. Ceilings still apply. |
| Ownership check | Refuses to sign a transfer the wallet doesn't own. |
| Run ledger | Never re-sends a confirmed transfer. |
| Per-tx ceiling | 0.05 ETH by default; `--override-ceilings` to exceed. |
| Per-run ceiling | 0.5 ETH by default. |
| Testnet gate | Refuses testnet without `--i-know-this-is-testnet`. |
| Wrong password | Vault rejects it, and detects a single flipped bit. |

`HOLDER_KIT_AUTO=1` makes `--auto` the default for every command.

### What is NOT protected

Anyone with your vault password and your vault file has your keys. That is the
whole trust model — it is self-custody, not magic. Use a real password.

---

## Chains

Built in: **Robinhood Chain** (4663), Robinhood testnet (46630), Base (8453),
Ethereum (1), and local anvil (31337). Add more in `config/chains.json`.

```bash
node bin/holder-kit.mjs chains
```

---

## For AI agents

`agents/SKILL.md` and `agents/AGENTS.md` let any agent drive this toolkit
end-to-end. Point your agent at them and it can set up wallets, verify RPCs,
scan holdings, and run auto-mints without hand-holding.

---

## Tests

```bash
npm test
```

72 tests against a real local anvil chain with real deployed contracts —
covering ABI encoding against known selectors, vault round-trip/wrong-password/
tamper, RPC failover recovery, live NFT transfers, and mint-state detection.
No mocks of this codebase's own logic.

---

## License

MIT
