# DFArchon Billboard

The current independent billboard lives in `df-billboard/` and
`apps/src/df-billboard-test/`. Its React client provides a public feed, sponsored
Aztec posting, personal reading preferences and optional Ethereum publication.

**[Current product design, setup and test results → df-billboard/README.md](df-billboard/README.md)**

The former `/reports` web page has moved to that README. The local
`/l1-post-lab` route verifies per-post MetaMask L1 gas payment with sponsored
L2 execution, without prepayment. It uses a separate deployment from the homepage.

## Original upstream experiment (historical reference)

The remainder of this file documents the original deposit-and-censor prototype,
not the independent DFBillboard client. Its deployment addresses, validation
claims and privacy descriptions must not be treated as verification of the
current fork.

### Billboard — Anonymous Message Board on Aztec

An anonymous billboard on Aztec v5 mainnet. Users deposit ETH on L1, post messages anonymously on L2, and withdraw their ETH back to L1. Posts are fully anonymous — no sender address appears in public call data, and there is no link to the L1 deposit.

Features:
- **Censorship mechanism**: A censor (set at deploy time) can flag posts as "immoral". Flagged posts are hidden from the default feed and impose a time-lock penalty on the poster's next post. The censor can transfer rights to another address.
- **Automated censorship bot**: A local-LLM daemon (`censor-daemon/`) watches the billboard, evaluates posts against the on-chain moderation policy, and automatically flags violations.
- **Moderation policy**: The censor can set a text moderation policy on-chain (up to 1488 bytes), shown in the UI and CLI. The daemon reads it as the source of truth.
- **Partial formal verification**: Security properties (rate limits, censorship screening, privacy, deposit safety) are formally verified in Lean 4 / Verity — 70 proven theorems, zero `sorry`s. See [fv/](fv/).

## Architecture

```
L1 (Ethereum)                     L2 (Aztec)
┌──────────────────┐              ┌──────────────────────┐
│ BillboardPortal  │              │ Billboard            │
│                  │              │                      │
│ deposit(ETH)     │──msg──▶      │ claim_deposit()      │
│  records deposit │              │  consumes L1→L2 msg  │
│  sends L1→L2 msg │              │  creates DepositNote │
│                  │              │                      │
│ withdraw(ETH)    │◀──msg──      │ post()               │
│  consumes Outbox │              │  consumes note       │
│  sends ETH       │              │  stores message      │
│                  │              │  creates new note    │
│                  │              │                      │
│                  │              │ withdraw()           │
│                  │              │  consumes note       │
│                  │              │  sends L2→L1 msg     │
└──────────────────┘              └──────────────────────┘
```

### Privacy model

- **Deposits**: L1 deposit is public (EOA + amount visible on Ethereum)
- **Posts**: Fully anonymous — no sender address in public call data, no link to L1 deposit
- **Withdrawals**: Reveals depositor's L1 address (inherent — ETH must go somewhere)
- **Anonymity set**: All depositors who haven't withdrawn yet

### Rate-limit invariant

Posts are rate-limited by a time-lock stored in a private note. The cooldown is inversely proportional to the deposit amount:

```
cooldown = base_cooldown * min_deposit / amount
```

For example with `base_cooldown=3600, min_deposit=0.001`:
- 0.001 ETH → 3600s cooldown (1 post/hour)
- 0.005 ETH → 720s cooldown (5 posts/hour)
- 0.01 ETH → 360s cooldown (10 posts/hour)

Each `post()` advances `next_allowed_time` by one cooldown (or more if flagged posts are screened). Posting multiple times in quick succession is possible if enough time has elapsed since the last post — the **save-up rule** (`max_save_up`) allows accumulating up to `max_save_up` posts of credit during dormancy, then spending them in quick succession. The deposit→withdraw loop does not help: re-depositing creates a new note with a fresh claim-time lock, identical to simply waiting.

### Censorship mechanism

A censor (set at deployment time) can flag posts as "immoral" via `declare_immoral(post_index, response)`. Flagged posts are:

1. **Hidden** from the billboard feed by default (user app shows a "View censored posts" link with confirmation dialog)
2. **Flag-penalized**: when a flagged post is screened during a subsequent `post()` call, the next post's time lock is extended by `cooldown * (K-1)` per flag (K set at deploy time). This is equivalent to making K-1 dummy posts at the same time: screening 1 flagged post costs K total cooldowns (1 base + (K-1) penalty).

**Screening** uses constant-cost Merkle proofs instead of chain walking. Each `post()` call screens 0–2 older posts (the "child" and "grandchild" in the post chain) via `assert_note_existed_by`. A post can only be screened after the **censor window** (default 3600s) has passed since it was created — guaranteeing the censor time to flag it first.

**Withdrawal** requires all real posts to be screened (`last_screened_index >= last_real_post_index`). Users make **dummy posts** (which advance screening without storing content) to screen their last real post before withdrawing. If no real posts exist, only the initial claim-time lock must expire.

The post chain uses a cryptographic link mechanism: each post stores a `prev_link` field computed as `poseidon2_hash_with_separator([inner_note_hash, link_secret], DOM_SEP__POST_LINK)`, where `link_secret` is derived from the poster's nullifier hiding key. This preserves anonymity — no public link between posts is revealed.

The censor can transfer censorship rights to another address via `transfer_censor(new_address)`. The deployer has no post-deployment control over the censor.

### Moderation policy

The censor can set a text moderation policy on-chain via `set_moderation_policy(fields, len)` (up to 1488 bytes, stored as 48 Field values). The policy is readable via `get_moderation_policy()` and is displayed in the user app, censor app, and CLI output. The automated censor daemon reads the on-chain policy as the source of truth for moderation decisions.

See [SECURITY_PROPERTIES.md](SECURITY_PROPERTIES.md) for the full security analysis with line-by-line code references.

## Automated censorship bot

The `censor-daemon/` directory contains a self-contained daemon that watches the Billboard contract for new posts, runs them through a local LLM (llama.cpp), and automatically flags any that violate the on-chain moderation policy.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  daemon.mjs │────▶│  llama-server │────▶│  Local LLM      │
│  (orchestr) │     │  (port 5090)  │     │  (Qwen3.5-2B)   │
└──────┬──────┘     └──────────────┘     └─────────────────┘
       │
       │ subprocess (black-box)
       ▼
┌─────────────────────────────┐
│  cli.mjs  list --json        │  → posts[], censorWindow, policy
│  cli.mjs  declare-immoral    │  → flags post on-chain
└─────────────────────────────┘
```

From any state, running `node daemon.mjs` will:

1. **Download + compile llama.cpp** (if not already present)
2. **Download the model** (~1.4 GB Q4_K_M GGUF, Qwen3.5-2B by default)
3. **Start llama-server** — local OpenAI-compatible API on `127.0.0.1:5090`
4. **Read contract config** — fetches the on-chain moderation policy, censor window, and max save-up
5. **Poll the billboard** — shells out to `cli.mjs list --json` to read all posts
6. **Moderate each post** — sends the post + policy to the LLM, asks "VIOLATION or OK?"
7. **Flag violations** — shells out to `cli.mjs declare-immoral` to flag the post on-chain

The daemon is a **thin orchestrator** — it never touches the Aztec SDK directly. All on-chain operations go through the existing user CLI as black-box subprocess calls. It is **censor-window-aware**: it prioritizes posts closest to expiring (oldest first), warns on posts with <5 minutes left, and warns on posts already past the censor window.

Policy resolution order: on-chain policy (from `get_moderation_policy()`) → local `policy.txt` → hardcoded default.

```bash
# Dry-run (evaluate but don't flag on-chain):
node censor-daemon/daemon.mjs --dry-run --once

# Live (actually flag violations):
node censor-daemon/daemon.mjs --poll-interval 30
```

Tests: 23 unit tests (`test_moderation.mjs`) + 14 integration tests (`test_daemon.mjs`) with mock infrastructure — no network or llama.cpp required. Run `bash censor-daemon/run_tests.sh`.

See [censor-daemon/README.md](censor-daemon/README.md) for full details.

## The four apps

### 1. Fee Juice (`fee-juice`)

Before interacting with L2, you need Fee Juice to pay transaction fees. This app handles the full flow:

1. **Swap ETH→AZTEC** (optional) — If you don't already have AZTEC tokens, the app swaps ETH for AZTEC via Uniswap V3 on L1.
2. **Deposit to L2** — Approves the FeeJuicePortal and deposits AZTEC tokens, sending an L1→L2 message.
3. **Scan / Recover** — Scans L1 `DepositToAztecPublic` events backwards to find your deposit, derives the claim secret from your ETH wallet signature, and checks nullifier consumption + checkpoint status.
4. **Claim on L2** — Consumes the L1→L2 message to mint Fee Juice on L2.

Also supports an `auto` action that runs deposit → wait → claim in one go.

### 2. Deploy (`billboard/deploy`)

Deploys and links the billboard contracts. The deployment has a circular dependency (L1 portal needs L2 address, L2 contract needs L1 portal address), broken by making the L2 constructor take no arguments and setting the portal later.

1. **Deploy L2** — Deploys the Noir Billboard contract using universal deploy (address depends only on salt + artifact, not deployer wallet).
2. **Deploy L1 Portal** — Deploys the Solidity portal via CREATE2 (deterministic from L2 address + rollup + version).
3. **Link Portal** — Calls `update_portal()` on L2 to store the L1 portal address.
4. **Cross-Check** — Verifies L1→L2 and L2→L1 references match.

### 3. User (`billboard/user`)

The main user-facing app. Full flow: deposit → claim → post → withdraw → claim on L1.

1. **Deposit ETH** — Deposits ETH into the L1 portal (sends an L1→L2 message).
2. **Claim on L2** — Consumes the L1→L2 message to create a private DepositNote.
3. **Post** — Posts an anonymous message. Each post extends the time lock by one cooldown. The billboard feed auto-refreshes every 5 seconds.
4. **Withdraw** — Consumes the DepositNote and sends an L2→L1 message.
5. **Claim on L1** — After the epoch proof (~40 min on mainnet), consumes the Outbox message to claim ETH on L1.

The billboard feed **hides censored posts by default**. A "View censored posts" link at the bottom shows how many posts are hidden; clicking it opens a confirmation dialog ("These posts have been flagged as immoral by the censor. Are you sure you want to see them?"). Confirming reveals the censored posts with grey styling and a "Hide censored posts" toggle to hide them again.

The `auto` action runs the full flow end-to-end autonomously.

### 4. Censor (`billboard/censor`)

A dedicated app for the censor to manage censorship. No ETH wallet needed — the censor only operates on L2.

1. **Load censor wallet** — Load the censor's Aztec wallet (the one whose address was passed to `init` at deploy time, or the one that received rights via `transfer_censor`).
2. **Flag posts** — Enter a post index and optional response text, then flag it as immoral. Flagged posts are hidden from the user billboard by default. When a flagged post is later screened during a subsequent post, the poster's next post time lock is extended by (K-1) extra cooldowns per flag.
3. **Transfer rights** — Transfer censorship authority to another Aztec address.
4. **View billboard** — The censor sees all posts including flagged ones (with censor response messages).

The censor is set at `init()` time only — the deployer cannot change it after deployment. Only the censor can transfer rights to another address.

## Directory structure

```
aztec/
├── README.md                        ← this file
├── SECURITY_PROPERTIES.md           ← security analysis with code references
├── wallet.json                      ← Aztec wallet (secret key + salt)
├── eth_wallet.json                  ← ETH wallet (private key)
├── package.json                     ← ethers + fake-indexeddb (for CLIs)
│
├── billboard/                       ← Contracts
│   ├── Nargo.toml                   ← Noir workspace
│   ├── billboard_contract/          ← L2 contract (Noir)
│   │   ├── Nargo.toml
│   │   └── src/
│   │       ├── main.nr              ← Billboard contract
│   │       └── lib.nr               ← Helpers: msg hashes, cooldown computation
│   ├── portal/                      ← L1 contract (Solidity / Foundry)
│   │   ├── foundry.toml
│   │   └── src/
│   │       └── BillboardPortal.sol
│   └── target/                      ← Compiled Noir artifacts (gitignored)
│
├── shared/                          ← Shared modules (used by all apps)
│   ├── styles.css                   ← Dark theme CSS
│   ├── helpers.js                   ← UI helpers: logging, pagination, extractors
│   ├── wallet-buttons.js            ← Common wallet loading/generation UI module
│   ├── app-env.js                   ← Common browser env builders (buildEnv, buildConfig, makeCallEngine)
│   ├── aztec-lib.js                 ← PXE/CRS/wallet infrastructure + Fee Juice constants
│   ├── aztec_bundle.js              ← Generated Aztec PXE bundle (not tracked)
│   ├── ethers.min.js                ← ethers v6 (for L1 interactions)
│   ├── poseidon2.js                 ← Pure-JS Poseidon2 (verified against bb.js)
│   └── rpc-config.json              ← Aztec node URL + API key
│
├── apps/                            ← Web apps + CLIs
│   ├── build.mjs                    ← Build script (combines modules → single-file HTML)
│   ├── serve.py                     ← Dev server with COOP/COEP headers for multi-threaded WASM
│   ├── src/
│   │   ├── fee-juice/               ← Fee Juice app
│   │   │   ├── template.html
│   │   │   ├── app.js               ← Thin wrapper (UI → engine)
│   │   │   ├── engine.js            ← Fee Juice flow logic (swap, deposit, scan, claim)
│   │   │   ├── cli.mjs              ← CLI tool (same engine, Node.js)
│   │   │   └── pxe-cache.cjs        ← IndexedDB dump/restore for CLI PXE caching
│   │   └── billboard/
│   │       ├── billboard_artifact.json   ← Generated L2 contract artifact
│   │       ├── portal_bytecode.txt       ← Generated L1 portal bytecode
│   │       ├── build_artifact.mjs        ← Artifact build script (VKs, bytecode)
│   │       ├── build_vks.sh              ← VK computation helper
│   │       ├── deploy/                   ← Deploy app
│   │       │   ├── template.html
│   │       │   ├── app.js               ← Thin wrapper
│   │       │   ├── engine.js            ← Deploy flow (L2 + L1 + link + cross-check)
│   │       │   ├── cli.mjs              ← CLI tool
│   │       │   ├── gen_eth_wallet.mjs   ← ETH wallet generator
│   │       │   ├── gen_censor_wallet.mjs← Censor Aztec+ETH wallet generator
│   │       │   ├── gen_user_wallet.mjs  ← User Aztec+ETH wallet generator
│   │       │   ├── billboard_artifact.json
│   │       │   └── portal_bytecode.txt
│   │       ├── censor/                   ← Censor app
│   │       │   ├── template.html
│   │       │   ├── app.js               ← Flag posts, transfer rights, view all posts
│   │       │   ├── engine.js            ← Symlink → user/engine.js (shared engine)
│   │       │   └── pxe-cache.cjs        ← Symlink → user/pxe-cache.cjs
│   │       └── user/                     ← User app
│   │           ├── template.html
│   │           ├── app.js               ← Thin wrapper (UI → engine, live feed, censored post hiding)
│   │           ├── engine.js            ← User flow (deposit, claim, post, withdraw, claim-l1, declare-immoral, transfer-censor)
│   │           ├── cli.mjs              ← CLI tool
│   │           └── pxe-cache.cjs        ← IndexedDB dump/restore for CLI PXE caching
│   ├── dist/                        ← Generated apps and optional CRS cache (not tracked)
│   │   ├── fee-juice.html
│   │   ├── deploy.html
│   │   ├── user.html
│   │   ├── censor.html
│   │   ├── aztec_bundle.js          ← Copy of the PXE bundle
│   │   └── crs/                     ← CRS files for proving
│
├── censor-daemon/                  ← Automated censorship bot (local LLM)
│   ├── daemon.mjs                  ← Orchestrator: llama.cpp setup, polling, flagging
│   ├── moderation.mjs              ← LLM moderation logic (prompt, verdict parsing)
│   ├── policy.txt                  ← Default moderation policy (fallback)
│   ├── test_moderation.mjs         ← Unit tests for moderation parsing (23 tests)
│   ├── test_daemon.mjs             ← Integration tests with mock infra (14 tests)
│   ├── run_tests.sh                ← Test runner script
│   └── README.md                   ← Full daemon documentation
│
├── fv/                             ← Formal verification (Lean 4 + Verity)
│   ├── PLAN.md                     ← Verification plan and status
│   ├── billboard_aztec_lean/       ← Lean model of L2 Noir contract (51 theorems)
│   │   └── BillboardAztec.lean
│   ├── billboard_portal_verity/    ← Verity port of L1 Solidity portal (12 theorems)
│   │   ├── BillboardPortal.lean
│   │   ├── Spec.lean, Invariants.lean
│   │   └── Proofs/Basic.lean
│   ├── bridge_model/               ← Lean model of L1↔L2 bridge (7 theorems)
│   │   └── Bridge.lean
│   └── notes/
│       └── SECURITY_PROPERTIES_FORMAL.md ← Theorem-by-theorem mapping (P1-P18, I1-I12)
│
├── .pxe-cache/                     ← CLI PXE cache (IndexedDB dumps, gitignored)
│
└── node_modules/                    ← ethers, fake-indexeddb
```

## Architecture: shared engine pattern

Each app follows the same pattern:

- **`engine.js`** — All business logic. Takes an `env` object (`{ aztec, ethers, log, initCRS, createStore, getEthSigner, portalBytecode, artifact }`) and a `config` object. Returns `{ ok, state, handles }` where `handles` gives the web UI access to live PXE/contract objects for polling.
- **`app.js`** — Thin UI wrapper. Builds `env`/`config` from UI state, calls the engine with the appropriate action, routes `log` callbacks to page-specific status divs.
- **`cli.mjs`** — CLI tool. Same engine, Node.js environment. Polyfills IndexedDB with `fake-indexeddb`, loads the bundle, runs the engine.

Both the web UI and CLI share the same engine, so any flow that is autonomous in the CLI is also autonomous in the web UI.

### Engine actions

**Fee Juice**: `status`, `scan`, `deposit`, `claim`, `auto`

**User**: `status`, `deposit`, `claim`, `post`, `list`, `withdraw`, `claim-l1`, `declare-immoral`, `transfer-censor`, `auto`

**Deploy**: `status`, `deploy`

The `auto` action runs the full flow end-to-end: deposit → wait for L2 ingest → claim → post (if message provided) → withdraw → claim-l1.

**Censor daemon**: `daemon.mjs` is not an engine action but a standalone orchestrator that shells out to `cli.mjs list --json` and `cli.mjs declare-immoral` as subprocesses. See [censor-daemon/README.md](censor-daemon/README.md).

## Building

```bash
# From the repository root, with Node 24.12.0 and Aztec 6.0.0-rc.3 installed:
npm ci
npm run build:contract
npm run build:portal
npm run build:sdk
npm run build:apps
```

Generated SDK bundles, workers, contract artifacts, portal bytecode, Foundry output and `apps/dist/` are ignored by Git. On a fresh checkout, run all four build commands in order before using the browser apps or the legacy CLIs. The browser loads CRS from the Aztec CDN when local `apps/dist/crs/` files are absent; an offline browser setup must provide those files separately.

### Building the formal verification proofs

```bash
cd fv/verity
export PATH="$HOME/.elan/bin:$PATH"
lake build   # 2125 jobs, zero sorrys
```

### Important: aztec-nr version must match the bundle

This fork pins `aztec-nr`, the JavaScript SDK and PXE to **6.0.0-rc.3**, matching the public testnet RPC checked on 2026-10-20. The SDK packages use `@aztec-labs`; their foundation dependencies (`bb.js`, Noir WASM and L1 artifacts) use `@aztec-foundation` **6.0.0-rc.6**, as required by that SDK. The compiler is Noir **1.0.0-rc.3**. Build the SDK from `shared/sdk-entry.mjs` using the committed npm lockfile; `build:apps` alone only assembles pages and copies the existing bundle.

The toolchain wrapper checks `.aztec-version` and `.nvmrc` without changing the global installation. It supports the standard versioned installation, an isolated `.local/toolchains/<version>` installation, or an explicit `AZTEC_TOOLCHAIN_DIR`. Recompile all contracts: old artifacts, deployments and PXE stores are not interchangeable with v6.

After `npm run build:df`, run `npm run check:testnet` for a read-only public-network compatibility check. This does not deploy contracts, spend funds, or enable public-network sending in the local-only test UI. Public deployment still needs network-specific manifests, real proving, sponsor authorization and funding, and Sepolia transactions.

The SDK build bundles upstream `main.worker.js` and `thread.worker.js` entrypoints directly. The old generated-bundle patch/extraction scripts are legacy tools and must not be applied to the new bundle. Browser/CLI IndexedDB stores use a version, chain and rollup namespace; old wallet stores are not deleted or automatically migrated.

Regression commands: `npm run test:noir`, `npm run test:sdk`, and `npm run test:daemon`. Start the isolated local network with `npm run start:local` (L2 5180, L1 5954, admin 5980), then run `npm run test:e2e`. This local E2E uses synthetic proofs, not production proof verification. Its receipt is saved to `.local/e2e-result.json`.

Each recompilation changes the contract class ID (public bytecode commitment), so always use a salt that was never used before when deploying.

## CLI usage

```bash
# Fee Juice (swap ETH→AZTEC, deposit, claim — all in one)
node apps/src/fee-juice/cli.mjs --gen-all                          # Generate new wallets
node apps/src/fee-juice/cli.mjs --status --aztec-wallet wallet.json --eth-wallet eth_wallet.json
node apps/src/fee-juice/cli.mjs --scan --aztec-wallet wallet.json --eth-wallet eth_wallet.json
node apps/src/fee-juice/cli.mjs --eth-for-swap 0.005 --aztec-wallet wallet.json --eth-wallet eth_wallet.json

# Billboard user (deposit → claim → post → withdraw → claim-l1)
node apps/src/billboard/user/cli.mjs status   --contract-salt 2028 --aztec-wallet wallets/user_aztec_wallet.json --eth-wallet wallets/user_eth_wallet.json
node apps/src/billboard/user/cli.mjs deposit  --contract-salt 2028 --amount 0.002 --aztec-wallet wallets/user_aztec_wallet.json --eth-wallet wallets/user_eth_wallet.json
node apps/src/billboard/user/cli.mjs post     --contract-salt 2028 --msg "hello world" --aztec-wallet wallets/user_aztec_wallet.json --eth-wallet wallets/user_eth_wallet.json \
  --censor 0x0035abfebdafd10697b8a9a5de2792715602ff077787ca6cfefdab632547189f --k-multiplier 4
node apps/src/billboard/user/cli.mjs list     --contract-salt 2028 --aztec-wallet wallets/user_aztec_wallet.json --eth-wallet wallets/user_eth_wallet.json \
  --censor 0x0035abfebdafd10697b8a9a5de2792715602ff077787ca6cfefdab632547189f --k-multiplier 4
node apps/src/billboard/user/cli.mjs withdraw --contract-salt 2028 --aztec-wallet wallets/user_aztec_wallet.json --eth-wallet wallets/user_eth_wallet.json \
  --censor 0x0035abfebdafd10697b8a9a5de2792715602ff077787ca6cfefdab632547189f --k-multiplier 4

# Censor: flag posts and transfer rights
node apps/src/billboard/user/cli.mjs declare-immoral --contract-salt 2028 --post-index 0 --censor-response "spam" \
  --censor 0x0035abfebdafd10697b8a9a5de2792715602ff077787ca6cfefdab632547189f --k-multiplier 4 \
  --censor-wallet wallets/censor_aztec_wallet.json
node apps/src/billboard/user/cli.mjs transfer-censor --contract-salt 2028 --new-censor 0x... \
  --censor 0x0035abfebdafd10697b8a9a5de2792715602ff077787ca6cfefdab632547189f --k-multiplier 4 \
  --censor-wallet wallets/censor_aztec_wallet.json
```

### Serving web apps with multi-threaded WASM

```bash
python3 apps/serve.py [port]  # default: 5000 (project convention)
```

Sets COOP/COEP headers for `SharedArrayBuffer` (multi-threaded WASM) and serves from `apps/dist/`. Local CRS files in `apps/dist/crs/` are loaded automatically.

## Key design decisions

### Universal deploy (deterministic L2 address)

The L2 contract is deployed with `universalDeploy: true` and `publicKeys: deriveKeys(Fr.ZERO).publicKeys`, so the contract address depends only on the salt + artifact — not the deployer's wallet. This means the deploy and user apps always compute the same address.

### SchnorrInitializerlessAccountContract

The v5 bundle uses the initializerless Schnorr account contract for self-deployment. The regular SchnorrAccountContract stores its signing key in a private note created by the constructor, but during self-deployment (deploy + claim fee juice in one tx), the entrypoint runs before the constructor, so `get_note()` fails. The initializerless variant stores the signing key in a PXE capsule and verifies against `immutables_hash`.

### In-browser PXE (no server, no workers)

The web apps run the full PXE stack entirely in the browser:
- **IndexedDB store** for PXE state (data directory includes wallet address for isolation)
- **CRS files** loaded from local files first, falling back to CDN
- **Proving** via `bb.js` WASM (multi-threaded when COOP/COEP headers are set)
- **No backend server** — all RPC goes directly to the Aztec node

### CLI PXE cache

Both CLIs dump/restore the in-memory IndexedDB state to `~/.pxe-cache/` between runs, saving ~2-4s on PXE sync. Cache files are keyed by account address.

### Wallet loading

The shared `wallet-buttons.js` module provides a common wallet UI across all three apps with:
- **ETH wallet**: Load from JSON, Generate random, or connect browser wallet
- **Aztec wallet**: Load from JSON, Generate random, or derive from ETH wallet (sign a message, use signature as secret key)
- Color-coded button states and auto-advancement when all wallets are loaded

## Prerequisites

- **nargo** / **aztec** CLI (must match the v5 bundle version)
- **forge** (Foundry, for compiling the Solidity portal)
- **Node.js** ≥ 24
- A browser wallet for L1 transactions (in the web UI)
- **Lean 4 / elan** (only for building formal verification proofs in `fv/`)

## Formal verification (partial)

The `fv/` directory contains a partial formal verification of the billboard's security properties using [Verity](https://veritylang.com) (Lean 4 framework for verified smart contracts) and a standalone Lean model of the L2 contract.

**Build status: 2125 Lean jobs, zero `sorry`s, 70 proven theorems/lemmas.**

### Components

| Component | File | Theorems | Axioms | Status |
|-----------|------|----------|--------|--------|
| **L2 model (Lean)** | `fv/billboard_aztec_lean/BillboardAztec.lean` | 51 | 5 | Constant-cost screening model: I1–I12, deposit safety, privacy |
| **L1 portal (Verity)** | `fv/billboard_portal_verity/` | 12 | 1 | Solidity port rewritten as `verity_contract`, guard proofs + conservation |
| **Bridge model (Lean)** | `fv/bridge_model/Bridge.lean` | 7 | 2 | Inbox/Outbox no-double-consume, content-hash agreement |

### What's proven

**L2 model** (51 theorems, models the Noir contract's constant-cost screening design from [LATEST_CHANGE.md](LATEST_CHANGE.md)):
- **I1** — Constant-cost screening: each `post()` screens at most 2 posts (zero axioms)
- **I3** — Censor window guarantee: posts only screened after `censor_window` expires (zero axioms)
- **I4** — Monotonic advance: `last_screened` never goes backwards (zero axioms)
- **I5** — Flag penalty: each flag adds exactly `cooldown × (K-1)` (zero axioms)
- **I6** — Save-up rule bounds burst posting (zero axioms)
- **I7** — Withdrawal requires full screening (zero axioms)
- **I10** — Chain link unforgeability (uses `poseidon2_injective` axiom)
- **Master safety theorem** (`deposit_safety_master`): withdraw ≤ `T_stop + ⌈N/2⌉ × C × (1+(K-1)×2)` — no permanent lockout
- **Master privacy theorem** (`post_unlinkability_master`): two posts by same user are indistinguishable from two by different users (constructive proof, zero axioms)
- **Censor governance**: only censor can flag/transfer/set-policy (proven)

**L1 portal** (7 Verity proofs + 5 stubs): P2 (no double deposit), P3 (withdraw zeroes balance), P4 (no withdraw without deposit), P14 (u128 overflow), conservation of `totalDeposited`.

**Bridge**: no-double-consume for Inbox and Outbox, content-hash agreement axioms (P1/P16).

### Axioms (intentional trust boundaries)

8 axioms total, all at cryptographic/platform trust boundaries:
- `poseidon2_injective` — hash injectivity (cryptographic assumption)
- `nhk_app_opacity` — link_secret not derivable from public data (cryptographic)
- `nullifier_unlinkability` — nullifiers don't reveal owner (Aztec platform property)
- `deposit/withdraw_hash_agreement` — L1 and L2 agree on content hashes (bridge boundary)
- `externalCallStubBool_true` — Verity test stub for external calls returns `true`

See [fv/notes/SECURITY_PROPERTIES_FORMAL.md](fv/notes/SECURITY_PROPERTIES_FORMAL.md) for the full theorem-by-theorem mapping, and [fv/PLAN.md](fv/PLAN.md) for the verification plan.

## TODO

- [ ] **Strengthen end-to-end FV theorems** — The bridge soundness theorems (P1, P5, P16) and several L2 invariants (I2, I8, I9, I11, I12) are currently stated as `True := by trivial`. Strengthen these to full proofs connecting L1 Verity + L2 Lean + bridge model.
- [ ] **Replace in-app JSON Ethereum wallet with [OpenLV](http://openlv.sh/)** — The current "Load from JSON" ETH wallet option requires users to manually export and load a private key JSON file. Replace this with OpenLV integration for a more secure, user-friendly wallet connection.
- [ ] **End-to-end browser test of censor app** — The censor web app (`censor.html`) has been built but not yet tested in a browser. The CLI `declare-immoral` and `transfer-censor` actions have been fully tested on mainnet (salt 2028).
- [ ] **End-to-end browser test of censored post hiding** — The "View censored posts" confirmation dialog and grey styling have been implemented in the user app but not yet tested in a browser against live mainnet data.

## AI-recommended TODOs

### Security & verification

- [ ] **Add access control guard to `update_portal()`** — Currently anyone can call it first with a bogus address, bricking the contract (griefing DoS, not theft). Should be deployer-only or called in the same L2 tx batch as deploy. See [SECURITY_PROPERTIES.md](SECURITY_PROPERTIES.md) §5.
- [ ] **Fix `post_count` / `post_data` key type from u32 to u64/Field** — Theoretically wraps after ~134M posts, overwriting post 0. Economically unreachable today but should be fixed for correctness.
- [ ] **Fix `totalDeposited` accounting drift** — Over-counts across deposit/withdraw cycles (never decremented). Not security-relevant (withdrawals read `deposits[msg.sender]`, not the total) but cosmetically wrong.

### UX & functionality

- [ ] **Surface L1 withdrawal claim in the web UI** — The `claim-l1` action exists in the engine/CLI but the web UI doesn't expose it as a distinct page with Outbox proof input.
- [ ] **Add "view on explorer" links** for confirmed L2 transactions (e.g. aztecscan.com).
- [ ] **Show estimated wait time** for epoch proofs in the UI during claim-l1 (~40 min on mainnet).
- [ ] **Suppress verbose PXE/bundle console output** in the browser — Partially done, but pino logger output still leaks through to the console.

### Testing & robustness

- [ ] **Add transient RPC retry logic to web apps** — The CLI has this via a `TRANSIENT_RE` regex; the web apps may not.
- [ ] **Handle multiple deposits to different Aztec addresses from the same ETH wallet** — Fee-juice scan filters by `to` address, but the UX could be clearer about which deposit is being claimed.

### Misc

- [ ] **Withdraw deposits on old test deployments** — Salts 2025, 2026, 2027, 2028 have deposits that can be withdrawn to recover ETH.
