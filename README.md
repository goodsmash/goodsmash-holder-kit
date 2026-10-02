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

## Setup — one command, no questions asked

```bash
node bin/holder-kit.mjs setup
```

That's it. `setup` is safe to re-run and never overwrites what you already have.
It will:

1. **create your encrypted vault** — it generates a strong random password,
   saves it to `vault/PASSWORD.txt`, and prints the path. Put that somewhere
   safe (not in the repo, not in a screenshot). You can replace it later with
   `wallet change-password`.
2. **generate a wallet** (or import a seed phrase if you pass one)
3. **check the chain** is reachable and print the block, chain id, and gas price
4. **verify your RPCs** are usable and report failover status
5. **write a first backup** of the vault to `vault/holder.vault.backup.bin`

Then confirm it all works with:

```bash
node bin/holder-kit.mjs check
```

If `setup` can't reach a chain, it still finishes and tells you what to run.
Nothing here is destructive.

### Non-interactive / agent mode

If you want no prompts at all, `setup` reads these environment variables and
never asks anything:

```bash
export HOLDER_KIT_PASSWORD='a strong password you choose'
node bin/holder-kit.mjs setup --wallets 20
```

Everything after that runs unattended: `--auto` skips per-transaction
confirmation (the vault still has to be unlocked, locally).

---

## Already have keys? Skip the vault setup

```bash
# Import a recovery phrase (hidden input, never echoed)
node bin/holder-kit.mjs wallet from-seed

# Or generate fresh wallets
node bin/holder-kit.mjs wallet new 20

# Or import existing keys from a JSON file
node bin/holder-kit.mjs wallet add keys.json

# Back the vault up somewhere else, NOW
node bin/holder-kit.mjs wallet backup D:/my-cold-backup.vault
```

After this you never sign anything by hand again. Every command below reads
the key from the vault and signs locally.

> **Back up the vault file.** It is the only thing standing between you and your
> wallets. Open the backup once on another machine before you trust it — a backup
> that has never been opened is a hypothesis, not a backup.

---

## Add your own RPCs (the single highest-value fix)

Public RPCs get rate limited. That is the #1 cause of "my run just stopped".
You can add **as many as you like** — they get ranked by measured speed, and the
fastest healthy one is used first with automatic failover to the rest.

### The easy way

```bash
# Add a provider (any EVM RPC — Alchemy, QuickNode, Infura, Chainstack, your own node…)
node bin/holder-kit.mjs rpc add https://…your-key…

# Name it and add a second, so one rate limit can't stop you
node bin/holder-kit.mjs rpc add https://…second-key… --name backup

# See every endpoint ranked by real measured speed
node bin/holder-kit.mjs bench --chain robinhoodMainnet
```

Your providers are written to `config/endpoints.json`, which is **gitignored** —
your API keys never leave your machine and never land in the repo.

### The manual way

```bash
cp config/endpoints.example.json config/endpoints.json
# paste your URLs — free tier at https://app.quicknode.com
```

### Which one gets used?

Endpoints are scored on live latency and recent failures. The fastest healthy
one wins; if it fails or rate-limits you, the next takes over transparently.

```bash
node bin/holder-kit.mjs doctor --chain robinhoodMainnet
```

`doctor` times every endpoint, **proves failover by deliberately breaking the
first one**, and tells you how many usable endpoints you have. Fewer than two
working endpoints means one rate limit will stop you.

### Going fast

`bench` prints real p50 latency per endpoint. For maximum throughput, add two
or three providers on different upstreams — even two free tiers on different
networks remove most rate limiting. Use `--rpc <url>` on any single command to
force one endpoint for that run and skip the pool entirely.

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

## Don't want a terminal? There's a UI

```bash
npm run ui
```

Then open **http://127.0.0.1:7799**.

Everything the CLI does is in the page: set up, check, add RPCs, speed-test them,
generate and back up wallets, find and auto-mint free NFTs, send NFTs to holders,
and fund wallets.

**It runs on your machine only.** It binds to `127.0.0.1`, so nothing on your
network — phone, other laptop, the internet — can reach it. There is no
account, no telemetry, and no outbound request of any kind.

Two things worth knowing:

- **The page contains no wallet logic.** Every button shells out to the same
  CLI the test suites prove, so the UI can't drift from what's verified.
- **Your password is piped to the local process for one command and then
  forgotten** — never written to disk, never logged, never sent back to the
  browser. `setup` ignores the field entirely and generates its own.

The UI only allows an explicit list of commands, refuses cross-origin requests,
and rejects unknown `wallet` sub-actions — `test/ui-tests.mjs` asserts all of
that, including that the port really is unreachable from your LAN address.

---

## Tests — both suites are real

```bash
npm test          # 72 tests: local anvil + Forge-deployed contracts
npm run test:ui   # 17 tests: the local UI's security boundary
npm run test:testnet   # 23 tests: LIVE Robinhood Chain TESTNET (46630)
npm run verify    # all three, in order
```

**`npm test` — 72 passing.** A real local anvil chain with real Forge-deployed
contracts. Covers ABI encoding against known selectors, vault
round-trip/wrong-password/tamper, RPC failover recovery, live NFT transfers,
and mint-state detection. No mocks of this codebase's own logic.

**`npm run test:testnet` — 23 passing against live chain state.** This is not a
simulation: it deploys a free-mint contract to Robinhood testnet and does real
transactions with real keys, asserting the result by reading the chain back.

```
PASS  contract has bytecode on testnet        7742 bytes
PASS  chain id is 46630                       got 46630
PASS  scanner verdict is FREE LIVE            free-live (free mint, callable now)
PASS  price is genuinely 0                    0 wei
PASS  mint shape gas-verified                 mint(uint256)
PASS  fee cap tracks the real gas price       gas=0.00000000001 cap=0.000000000015
PASS  vault created with 2 wallet(s)
PASS  funded wallet(s) hold real testnet ETH  0.0000105 / 0.0000105
PASS  auto-mint succeeded with no prompt      sent=2/2
PASS  totalSupply actually increased on chain 21 -> 23
PASS  wallet owns a real token id             token #22
PASS  ownerOf confirms it owns it
PASS  per-wallet limit is enforced on chain   reverted: call would revert, not broadcast
PASS  a within-limit mint still succeeds      minted 1 more
PASS  scanner reports paused as closed        closed (no mint function accepts a call)
PASS  wallet holds both minted tokens         holding 2
PASS  every NFT really transferred elsewhere  sent=2/2
PASS  recipient balance increased by every transfer
PASS  sender wallet is now empty
PASS  re-running sends nothing (ledger)       sent=0

23 passed, 0 failed  — against Robinhood TESTNET
```

The testnet run needs a funded testnet key. Create one, then fund it:

```bash
node test/make-testnet-wallet.mjs     # prints an address + key, saves them locally
```

It saves the wallet to `~/Documents/rh-testnet-wallet/testnet-deployer.json`
(deliberately outside the repo, so no source control can ever commit it) and
prints the private key once so you can back it up.

Then paste that address into the faucet — **in a browser**, not a script:

**https://faucet.testnet.chain.robinhood.com**

The official faucet returns HTTP 429 to scripted requests, so a `curl` or a
headless fetch will not work; it wants a real page load. Once funded, re-run
`npm run test:testnet`. The proof finds the key automatically and prints which
source it used, so you always know which wallet paid for the run.

Other faucets that work for Robinhood testnet, if the official one is busy:
QuickNode (`faucet.quicknode.com/robinhood/testnet`, no account needed, 12-hour
cooldown), Chainlink, and `faucet.trade`. Each needs a browser too.

Every run spends roughly 0.000011 test ETH, so a single claim covers dozens of
runs. If the balance runs short the proof stops and tells you the exact address
to top up instead of failing mid-way.

## Proving it against a REAL live mainnet collection — read-only

`npm run test:mainnet` points the scanner at a real, already-open mainnet drop
and verifies every field is read from chain. It sends nothing, signs nothing,
and costs nothing:

```bash
npm run test:mainnet                              # the default collection
node test/mainnet-read-proof.mjs 0x<address>      # or any collection you like
```

Against `0x2676cbd9bba27864acf3d110fa3214f5c86fceaa` on Robinhood mainnet
(17,776 bytes of live bytecode):

```
PASS  contract has live bytecode                  17776 bytes
PASS  connected to the right chain                chainId 4663
PASS  standard detected from ERC-165              ERC721
PASS  maxSupply() read from chain                 20000
PASS  totalSupply() read from chain               202 of 20000 minted
PASS  maxPerWallet() read from chain              2 per wallet
PASS  mintPrice() read from chain                 0.000368324125230204 ETH
PASS  minted never exceeds the cap                202 <= 20000
PASS  collection is NOT sold out                  19798 left
PASS  scanner found a callable mint shape         mint(uint256)
PASS  scanner read the price from chain           368324125230204 wei
PASS  verdict agrees with the price on chain      reported paid-live, not free
PASS  isFree never claims a priced mint is free   isFree=false

13 passed, 0 failed  — READ-ONLY, nothing was sent
```

**The assertion that matters most is the last two.** This collection had 19,798
of 20,000 supply left — every naive check says "mintable" — but it charges
0.000368 ETH. A scanner that inferred "free" from remaining supply would send
real value to a paid mint. This one reads the price and says `paid-live`.

That is why no mainnet mint is broadcast by any test in this repo. Proving a
*paid* mainnet mint costs real money from a real wallet, and that is the
holder's decision, not the toolkit's.

---

## The scale proof — a whole fleet of wallets, unattended

`npm run test:testnet` proves one mint end to end. `npm run test:scale` proves
the thing holders actually care about: **can the toolkit mint from many wallets
in one unattended run?**

```bash
npm run test:scale                   # 8 wallets
PROOF_WALLETS=20 npm run test:scale  # or 20
```

It deploys `test/fixtures/MultiMint.sol` — a deliberately realistic free-mint
drop with a per-wallet cap, an allowlist path, a paid path, pausable state, a
cappable supply and enumerable tokens — to testnet, then:

1. funds N wallets from one deployer
2. runs the unattended auto-mint across **all** of them
3. verifies **every single wallet** independently on chain via `balanceOf` and `ownerOf`
4. spreads one NFT from each wallet to distinct recipients
5. confirms the ledger blocks a duplicate fleet-wide resend
6. flips the price and confirms the scanner follows it from chain state
7. sells the drop out, confirms `sold-out`, then restores it for the next run

Latest run, 20 wallets, live testnet:

```
PASS  new drop scans as free-live              free-live (free mint, callable now)
PASS  price reads 0 from chain                 0 wei
PASS  a mint shape was gas-verified            mint(uint256)
PASS  all 20 wallets funded                    20/20
PASS  every wallet minted, unattended          sent=20/20
PASS  totalSupply rose by exactly the count    16 -> 36
PASS  every wallet independently verified      20/20 own exactly 1
PASS  ownerOf() confirms the token ids         3/3 checked
PASS  one NFT from every wallet spread         sent=20
PASS  all source wallets drained               20/20 empty
PASS  re-running the spread sends nothing      sent=0
PASS  scanner follows a live price change      price now 0.001 ETH
PASS  a priced mint is no longer free          paid-live
PASS  sold-out is reported as sold-out         sold-out (supply fully minted)
PASS  supply restored for the next run         MAX_SUPPLY back to 500

17 passed, 0 failed  — SCALE PROOF on Robinhood TESTNET
```

### This is how real bugs were found

Building a *realistic* fixture exposed failures a one-function mock never would:

| Bug | Why it mattered |
|---|---|
| Price getters too narrow | A drop naming its getter `freePrice()` read as "no price found", which the scanner treats as **paid** — so a genuinely free mint reported `paid-live`, and auto-mint would have tried to send value |
| Paren-less getter names | `encodeCall('maxSupply')` throws, and `read()` swallows it to `null` — it looked like extra coverage while probing nothing |
| Non-enumerable fixture | The toolkit **correctly refused** to spread; the fixture was missing `tokenOfOwnerByIndex` |
| Missing ERC-165 | `detectStandard` returned `UNKNOWN` and the spread guard blocked it, again correctly |
| Missing `safeTransferFrom` | `spread` uses `safeTransferFrom`, not `transferFrom` |

Two of those five are the safety guards refusing to act on a collection they
couldn't fully verify — exactly the behaviour you want when real NFTs are on
the line.

---

### Bugs this testing caught (and fixed)

Worth listing, because they're all silent-failure bugs — the kind that look like
"the chain is weird" rather than "our code is wrong":

| Bug | Symptom | Fix |
|---|---|---|
| `chainId` / `nonce` sent as JSON numbers | Every gas estimate failed with a Go unmarshal error; the signer fell back to an unpayable 3,000,000 gas cap | Hex-encode both — nodes type them as `hexutil.Big` |
| Revert during gas estimation silently fell through to the gas cap | A sold-out or limit-blocked mint reported **"insufficient funds"**, blaming the wallet instead of the contract | Reverts are now surfaced, never broadcast |
| `maxPriorityFeePerGas` above `maxFeePerGas` | Node rejected the tx outright | Priority fee capped below the max fee |
| `formatUnits` called via `.map()` | Printed `0.24` for a 0.24 balance — the array index became the decimals argument | Wrapped the callback |
| Gas budgeted at a flat 300k/mint | Correctly-funded wallets were reported underfunded | Budget from the real gas price |
| Addresses not EIP-55 checksummed | Rejected by strict nodes | Checksum all outbound addresses |

---

## License

MIT
