# DFArchon Billboard

An independent public message board on Aztec. Anyone can read without connecting a wallet. Any Aztec account can post; joining Dark Forest, staking, and deposits are not required. The deployed contracts and public chain state are the source of truth.

The current website points to the public testnet. Testnet availability does not imply mainnet readiness, a funded sponsorship budget, or a completed privacy audit.

## Product

The website uses React 18, TypeScript, Vite, and React Router. Its ink, sakura, and thin-border visual language draws from DFArchon, Onchain Reality, and DF Aztec Bridge.

- The home page shows public posts, pagination, and a shared composer.
- The wallet menu offers MetaMask, a compatible Aztec extension wallet, or a browser Aztec account. All choices use the same board and composer. The browser wallet supports a saved account, account creation, and backup import.
- A three-step guide appears on first visit. Its completion state stays in this browser.
- The header switches between light and dark themes. The preference is stored locally and synchronized across tabs; CSS tokens and the ASCII background use the same theme. Dark is the default.
- Legacy report and lab URLs redirect to the home page. The old test page URL remains a compatibility redirect.

The public testnet requires real proofs; the local environment may use synthetic proofs. The client validates the deployment manifest and does not expose a proof-mode switch. The wallet SDK discovers compatible extensions, including Nulo. Extension posting has not yet received an end-to-end test. Browser wallet posting and a MetaMask Sepolia request through to an Aztec post were verified from the local website on 2026-10-24. See [deployment instructions](DEPLOYMENT.md#use-public-testnet-from-a-local-website).

The board initially reads the newest 10 posts. Load older posts fetches another 10 from the same block snapshot. Refresh starts a new snapshot. Failed older-page reads retain the cursor for retry. There is no indexer yet.

Reads use at most eight concurrent storage requests. The client keeps at most 100 decoded posts in memory, keyed by node, board, and block snapshot. A new snapshot rereads the posts. The footer distinguishes loaded posts from the total in the snapshot.

Posts display an on-chain ID and the publication time, with no author identity. The contract records the Aztec public execution block's Unix timestamp in _publish. Both wallet paths use that same timestamp. The browser displays today's posts relatively and older posts by date, with full time and timezone on hover. Older contracts without timestamps show no time.

## Contract and posting

Implementation: contract/src/main.nr and test/src/lib.nr.

1. The client connects an Aztec wallet and registers the board and Sponsored FPC.
2. The private post(text, length) call validates the message and that account's posting history.
3. The private call queues _publish, which only the contract itself may invoke.
4. _publish assigns an ID and stores public text, byte length, and publication timestamp.
5. Readers use get_post_count, get_post, and get_post_timestamp, or a public storage snapshot from one block.

| Constraint | Behavior |
| --- | --- |
| Board identity | Network plus board contract address; no DF season or player contract dependency |
| Eligibility | Any Aztec account; no player proof, manual claim, stake, or deposit |
| Rate limit | At most 10 posts per account in a rolling 86,400 seconds, using Aztec anchored block time |
| History | A private note records posting history; an initialization nullifier prevents resetting the quota by discarding history |
| Message | Client requires 1–512 bytes of valid UTF-8; the contract checks length and zero padding across 17 Fields |
| Visibility | Text is public on Aztec; public post storage contains no author address |
| Fees | Sponsored FPC pays L2 gas; if sponsorship is unavailable, posting stops rather than silently switching to user payment |

Direct contract calls still rely on the client for UTF-8 validity. The reader skips content with invalid decoding. A per-account limit is not a per-person limit, and omitting the author address does not eliminate all network metadata links.

A contract upgrade requires a new deployment. Existing posts remain at the old contract address and are not migrated automatically. The public reader supports the older storage layout; the timestamped layout reads 19 fields per post.

## MetaMask path

The message is published on Aztec only. There is no extra Ethereum copy.

1. The browser creates an independent Aztec account using fresh randomness; its key is not derived from a MetaMask signature.
2. MetaMask calls BillboardInbox.requestPost with zero ETH value and pays only L1 transaction gas.
3. The standard Aztec Inbox carries a salted commitment and secret hash, without the message text or Aztec account in plaintext.
4. The private post_from_l1 call checks the permitted L1 contract source, message, and account binding, then consumes the one-time Inbox message.
5. Sponsored FPC pays L2 gas and the same per-account rate limit applies.

No fee deposit, stake, or fee-asset swap is required. If an L1 request times out or the page reloads, the wallet panel can continue the original request. It must verify an uncertain receipt before a new L1 payment. Switching wallets preserves the pending request and account. Posting confirmation and list refresh are separate: a failed refresh does not relabel a confirmed post as failed.

Same-origin tabs use Web Locks around account creation, posting, and recovery, and storage events synchronize pending records. Environments without Web Locks disable these writes. This does not coordinate different browsers or replace the contract's replay protection.

deploy:df:harness deploys both the L1 Inbox and an Aztec board initialized with its Inbox configuration. An older L2-only board still supports Aztec wallet posting, but disables MetaMask posting. Save the old manifest and accounts before switching deployments.

An L1 payment address is public. The final text is on L2, so this is not native L1 posting. Local checks did not find the examined payment address, Aztec account, or credential plaintext in public L2 transactions, but timing, RPC, and IP data may still correlate activity. Synthetic local proofs and unencrypted local test keys are not a production privacy assessment.

## Fixed-sample diagnostics

The historical evaluation contains 144 manually written Chinese and English examples: 96 original and 48 additional, plus 22 duplicate pairs. Local-rule counts below reflect the code at the time of migration. AI results were recorded on 2026-10-14 12:03 Asia/Shanghai and were not rerun during the website migration. They do not estimate real-world accuracy.

| Category | Total | Example keyword folds | Local-rule folds | Historical AI folds |
| --- | ---: | ---: | ---: | ---: |
| Ordinary chat/discussion | 56 | 8 | 0 | 5 |
| Ads and obfuscated solicitation | 48 | 11 | 42 | 0 |
| Abuse and real-world threats | 24 | 0 | 0 | 23 |
| Borderline | 16 | 2 | 0 | 0 |

Example keywords include boosting and VPN, plus two Chinese terms for boosting and WeChat. They are not default user keywords. One post can appear in multiple columns. Local rules folded 22/24 Chinese ads and 20/24 English ads, missing six ads overall. Historical AI falsely folded 5/56 ordinary examples and missed 1/24 risk examples. Credential and adult-content sample sizes are too small for a production claim.

Model: Horizon-Labs/content-safety-guard-small; revision 6152f768a82207aab4ae7305b9df235a4a5163d9; decision threshold: unsafe >= 0.5.

The original research files live outside this repository at ../docs, or at DF_REPORT_DOCS_DIR. Run npm run report:df:reading to generate .local/reading-report/df-test-report.json with per-example decisions and source hashes. This recalculates rules and reuses recorded AI decisions. Missing evidence is reported as unavailable rather than replaced with invented zero-error results; it does not block the product build.

## Local development

Run these from the repository root with Node 24.22.1, Aztec 6.0.0, and Noir 1.0.0-rc.3. The SDK uses @aztec-labs packages; associated proof libraries, Noir WASM, and L1 artifacts use the SDK-required @aztec-foundation 6.0.0 packages.

```sh
npm ci
npm run build:sdk
npm run build:df
npm run build:df:l1
# Terminal 1: start the local chains
npm run start:local:df
# Terminal 2: deploy the standalone board and start the site
npm run deploy:df:harness
npm run dev:df:site
```

Open http://127.0.0.1:5001/. MetaMask must be available in the browser for that path. Local deployment does not require real ETH. Do not redeploy the contract or reset the local chain to update the UI.

npm run check:testnet performs read-only checks of public testnet versions, Sepolia chain ID, real proof mode, and the canonical Sponsored FPC balance. It defaults to https://aztec-testnet.drpc.org; AZTEC_TESTNET_URL can select another HTTPS node. A nonzero FPC balance does not prove sponsorship permission.

The page reads /df-local.json. A missing environment field defaults to local for existing manifests. Public testnet manifests must specify environment: "testnet", HTTPS Aztec and L1 RPCs, matching rollup address and version, board and FPC addresses, and contract artifacts. The MetaMask path also needs the matching Sepolia Inbox request contract, chain ID 11155111, Inbox address, and runtime code hash. The client checks SDK version, chain ID, rollup, and proof mode without upgrading or switching deployments automatically. While waiting on a public Inbox request it only polls status; it does not call local time-advance helpers.

Public testnet deployment, recovery, and Vercel release package generation are documented in [DEPLOYMENT.md](./DEPLOYMENT.md). npm run deploy:df:testnet -- plan is read-only by default; real deployment requires deploy --broadcast. Logs and keys stay local; the host receives only static assets and public contract configuration. Switching local chains changes the manifest and runtime assets, so back them up first.

## Tests

```sh
npm run format:check:df:site
npm run typecheck:df:site
npm run test:df:ui
npm run test:df:moderation
npm run test:df:message
npm run test:df
npm run test:df:l1
npm run build:df:harness
```

Noir tests cover open eligibility, the 10/11-post quota, rolling boundaries, history reset protection, length and padding, internal-only publication, and account and board isolation. Solidity tests cover zero-value Inbox requests and commitment validation. UI tests cover disconnected guards, error retention, message escaping, pagination, and L1 states. Message tests cover UTF-8 boundaries.

The product loads the shared wallet runtime. It does not load the legacy experiment's deposit, review, or Portal helpers. Existing local end-to-end commands require running nodes and matching deployments: npm run test:df:e2e, npm run test:df:l1-request, and npm run test:df:l1-post-lab:e2e. Local synthetic tests do not replace public-network proof verification or a security audit.

## Before a production release

- Continue to validate public testnet posting, compatible wallets, and deployment manifests after network upgrades.
- Fund and bound Sponsored FPC usage so open accounts cannot drain sponsorship.
- Validate the MetaMask path in real browsers and improve chain-reorganization handling.
- Improve account backup and recovery; current browser account storage is suitable for testing, not valuable assets.
- Expand independent multilingual moderation samples, test network privacy assumptions, and measure large-board reads.

References: [Onchain Reality](https://onchainreality.xyz/), [DF Aztec Bridge](https://github.com/dfarchon/df-aztec-bridge), and [Aztec networks](https://docs.aztec.network/networks).
