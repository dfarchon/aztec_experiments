# Notch frontend guide

This guide follows the production website. The goal is to make the owner of a
page, button, stored record, RPC call, or transaction obvious without reading the
Aztec SDK first.

## Directory map

| Path | Responsibility |
| --- | --- |
| `web/src/main.tsx` | Browser entry: fonts, styles, initial theme, React root and router |
| `web/src/app/` | Page composition, routes, runtime lifetime, controller, view types and shared network policy |
| `web/src/features/feed/` | Public post reader, pinned feed cache, `Feed`, `PostTime` and `Composer` |
| `web/src/features/wallet/` | Wallet panel and views, account persistence, key export, L1 portal operations, Aztec board operations and transaction sequencing |
| `web/src/ui/` | Reused product primitives such as icons, loading state, steps and notifications |
| `web/src/appearance/` | Theme, brand, worker-backed interactive background and onboarding guide |
| `protocol/message.mjs` | Post encoding/decoding and sponsored-fee estimation shared with scripts |
| `runtime/` | Lazy SDK entry, wallet/PXE runtime, Noir runtime and IndexedDB namespace helper |
| `runtime/generated/` | Ignored SDK and worker build output |
| `scripts/` | Contract, runtime, local-chain, deployment and release tooling |
| `df-billboard/` | Current Noir contract, L1 stake portal and native contract tests |

JavaScript tests live under the root `tests/` directory, separate from production
code. They import the owning modules directly and use Node's built-in test runner.

| Path | Coverage | Command |
| --- | --- | --- |
| `tests/web/` | App/controller, feed, wallet and appearance | `npm run test:unit` |
| `tests/runtime/` | Noir runtime and IndexedDB | `npm run test:unit` |
| `tests/protocol/` | Message encoding and fees | `npm run test:message` |
| `tests/tooling/` | Vite and local clock | `npm run test:unit` |
| `tests/tooling/deployment.test.mjs` | Offline deployment/recovery | `npm run test:deployment` |
| `tests/tooling/release.test.mjs` | Isolated static release packaging | `npm run test:release` |
| `tests/e2e/stake-flow.mjs` | Stake, claim, post and withdraw on local chains | `npm run test:e2e` |

Native contract tests stay in `df-billboard/test/` and
`df-billboard/portal/test/` for their respective toolchains. The end-to-end
script requires a local deployment and rejects public chains; it is not part of
`npm run check` or `npm test`.

## State ownership

`web/src/app/controller.ts` owns the only frontend application store. Its
`BillboardView` snapshot contains the feed, current wallet status, message draft,
operation progress and user-visible error. React reads it with
`useSyncExternalStore`; components dispatch controller actions and do not keep a
second copy of wallet or feed state.

The wallet feature owns durable transaction facts and emits wallet snapshots to
the controller:

- `features/wallet/wallet-flow.ts` is the transaction coordinator.
- `features/wallet/portal.ts` performs concrete Ethereum portal calls.
- `features/wallet/l1-reader.ts` owns the app's direct Ethereum read transport.
  Providers targeting the same endpoint share a serial queue with at least 200ms
  between request starts. Identical in-flight method/parameter reads share one
  result, but completed balances and receipts are not cached. Batch requests are
  disabled. Only allowlisted reads retry rate limits (including HTTP 429 and
  id-less gateway errors), at most three times with exponential backoff and
  jitter. Destroyed callers stop receiving results and queued work is skipped
  when no callers remain. Injected-wallet signatures and transaction submissions
  do not pass through this queue. Limits are per browser page and endpoint,
  not an aggregate limit across all website users.

- `features/wallet/aztec.ts` performs concrete Aztec board and PXE-facing calls.
- `features/wallet/account-storage.ts` owns the durable browser account record.
- `features/wallet/wallet-recovery.ts` owns versioned signature messages and
  domain-separated account/deposit key derivation; no SDK is needed before payment.
- `features/wallet/account-files.ts` writes the versioned account key package;
  it contains no import parser or transaction checkpoints.
- `features/wallet/wallet-session.ts` owns the silent-reconnect preference.

The UI never signs a transaction, reads an account secret, polls a receipt, or
calls a contract method.

The interactive background lives in `appearance/AsciiClouds.tsx`. On supporting
browsers it transfers the canvas to `appearance/clouds.worker.ts`, which runs the
shared `appearance/clouds-renderer.ts` outside the main thread. The worker keeps
the existing noise, glyph and palette logic, precomputes per-cell geometry, and
runs at a lower frame rate while wallet restore or transaction work is active.
Browsers without OffscreenCanvas fall back to the same renderer at reduced main
thread frequency. Worker creation, transfer, asynchronous errors and a missing
startup acknowledgement fall back using a fresh canvas. Reduced-motion mode
stops the previous draw timer and renders a static frame.

`app/SiteLayout.tsx` keeps the background, header, wallet panel, notifications and
content frame mounted outside the route's Suspense boundary. Router transitions
retain the current content while the next page's code loads, so the first About
visit does not flash a loading screen or restart the background animation.

`app/AboutRoute.tsx` is a lazy, static `/about` page for the project's origins,
mechanism and privacy boundaries. The header information icon opens About; its
back link and the logo return to the board. Reading About does not initialize the
feed or load the wallet runtime. Navigating away from the board does not dispose
its module-owned runtime; returning reuses the existing session.

## What is persisted

Browser names and file formats are compatibility contracts:

| Data | Location |
| --- | --- |
| Last authorized wallet | localStorage `notch-wallet-session/<board>` |
| Account keys and transaction checkpoints | localStorage `notch-stake/6.0.0/<board>/<lowercase-payer>` |
| PXE data | IndexedDB `pxe_data`, under the board/salt/rollup-specific data directory |
| Account export | JSON key package with `kind: "notch-account"` and version `2` |
| Theme | localStorage `df-billboard:theme` |
| Onboarding seen | localStorage `df-billboard:board-guide:v2` |
| Cross-tab mutation lock | Web Lock `billboard-wallet:notch-stake:<board>` |

The account record keeps distinct durable facts for the L1 transaction hash,
deposit secret, L2 claim attempt/hash, pending exit and last post. These are not
replaced by one UI busy flag.

The feed cache is recreated in memory from a pinned Aztec block snapshot. Wallet
connection, PXE sessions and proof resources are recreated lazily. Neither the
feed cache nor wallet UI state is persisted.

## Reading paths

### Page startup and public posts

1. `web/src/main.tsx` mounts `web/src/app/routes.tsx`.
2. `web/src/app/BoardRoute.tsx` starts
   `web/src/app/runtime.ts::initializeRuntime`.
3. `web/src/app/controller.ts::initialize` loads `/df-local.json`, validates the
   chain and board class, loads the public storage layout, then reads a page.
4. `web/src/features/feed/feed-reader.ts::createFeedReader` maintains the bounded
   post cache and cursor. `readPostPage` performs ordered storage reads against
   one block.
5. `web/src/features/feed/public-reader.ts` implements the public JSON-RPC adapter
   and field hashing. It does not import the wallet or proof runtime.
6. `web/src/features/feed/Feed.tsx` renders and requests older pages at its
   sentinel.

`Composer.tsx` publishes the message draft through
`controller.setField("message", value)`. Draft ownership stays in the controller.

### A first stake

1. `features/wallet/SetupView.tsx::primaryStakeAction` calls
   `controller.stake(amount)`.
2. `features/wallet/wallet-flow.ts::createWalletFlow` creates one deposit secret
   and persists the pending job before any wallet prompt can spend ETH.
3. `sendDeposit` verifies the configured Ethereum portal in
   `features/wallet/portal.ts::verifyPortal`, checks for an existing deposit with
   the same secret hash, estimates gas, and calls
   `portal.ts::submitDeposit`.
4. The L1 hash is persisted. `confirmDeposit` waits only for that recorded hash
   or the matching `Deposited` event and verifies payer, amount and secret hash.
5. While L1 confirmation is pending, `controller.ts::stake` asks the typed
   wallet runtime to prepare proof resources.
6. `controller.ts::initializeAztec` loads
   `features/wallet/runtime-sdk.ts`, then
   `features/wallet/aztec.ts::createAztecBoardSession`.
7. The runtime exposes the SDK and explicitly configured node URL to
   `runtime/wallet-runtime.mjs::createAztecRuntime::setupAccount`. That function
   derives the private account, creates/syncs PXE, registers the account and
   contract, and returns a wallet.
8. `aztec.ts::claimDeposit` waits for the L1-to-L2 message, persists an uncertain
   claim attempt before submission, stores the prepared claim hash, and clears
   the deposit only after a successful receipt.
9. `wallet-flow.ts::refresh` reads stake, depositor, last-post time and remaining
   quota from Aztec. The UI becomes Ready from that chain state.

### A post

1. `features/feed/Composer.tsx` calls `controller.post()`.
2. `web/src/app/controller.ts::post` validates the UTF-8 message with
   `protocol/message.mjs`, requires a Ready wallet, and calls the coordinator.
3. `features/wallet/wallet-flow.ts::operations.post` rejects pending
   deposit/withdrawal jobs, verifies the L1 account is still current, and calls
   `features/wallet/aztec.ts::publishPost`.
4. The coordinator refreshes stake/quota from Aztec and returns.
5. The controller clears the draft only if it still equals the submitted text,
   then refreshes the public feed. A failed post preserves the draft.

### Manual wallet connection

Selecting a wallet calls `features/wallet/l1.ts::requestEthereumAccounts`.
It requests the `eth_accounts` permission before reading the selected address,
so MetaMask can show account selection even after an earlier authorization.
Only unsupported-method errors fall back to `eth_requestAccounts`; rejection,
a pending prompt, or timeout never reconnects an old account implicitly.
Disconnect clears the site session and automatic-reconnect preference while
preserving private account keys and pending transaction records.

The setup view uses one persistent inline reminder. Normal proof preparation
does not display an uncertain-claim warning; if setup stops with an unknown
claim hash, that reminder is replaced by recovery guidance. It does not install
a browser leave-page confirmation.

### A returning account

1. `controller.ts::initialize` starts one `restoreSession` task.
2. `controller.ts::restoreSession` reads
   `features/wallet/wallet-session.ts::readWalletSession`.
3. `features/wallet/l1.ts::listEthereumWallets` finds the saved provider.
4. `wallet-flow.ts::operations.connect` calls `eth_accounts` only. It does not
   request accounts or switch networks during silent restoration.
5. If the saved account is complete, the controller starts Aztec initialization
   in the background. `createAztecRuntime`, `setupAccount` and
   `wallet-flow.ts::refresh` recreate PXE state and verify stake/quota on chain.
6. Closing the wallet dialog only changes `walletOpen`. It does not cancel the
   restore task. Disconnect, account/network changes and page disposal advance
   the controller session generation so late results cannot update a new session.

Deposit confirmation and history recovery validate successful `Deposited` events
from the configured Portal, including depositor, amount, claim commitment and
message identity. Outer transaction destination/value are not authoritative for
EIP-7702 or relayed wallet execution. A missing transaction/receipt remains a
syncing state. Recovery tries the outer payer nonce (or current payer nonce for
a relayer), its successor and at most 256 earlier nonces, accepting only an exact
claim commitment match. Older unmatched deposits require the original browser's
saved secret; they never cause a replacement payment.

### Setup continuation and account export

1. L1 connection performs a bounded, read-only balance check through
   `portal.ts::readL1Stake`. It does not initialize Aztec or request a signature.
2. `SetupView` shows amount choices only for a new stake. Existing L1 stake and
   unfinished local records use the same **Continue setup** action.
3. `controller.continueSetup` calls `wallet-flow.ts::continueSetup`, which resumes
   the saved operation or derives recovery credentials, then initializes Aztec.
4. `createAztecBoardSession` records the account class ID and SDK version alongside
   its derived address. `account-files.ts::writeAccountFile` exports only the
   address, three key materials, account contract metadata and network identity.
5. Ready warns about private keys before download. There is no file-import or
   random-account fallback. See the root README for independent SDK usage.
6. Setup progress maps verbose runtime diagnostics to short button labels. Wallet
   primary actions have fixed height and truncate labels instead of resizing.

## Finding failures

- Public read failure: `controller.ts::loadFeed` calls `feed-reader.ts` and
  `public-reader.ts`; retry keeps the previous cursor and posts.
- Wallet authorization failure: `features/wallet/l1.ts`.
- Portal or Ethereum failure: `features/wallet/portal.ts`.
- Aztec/PXE/claim/post failure: `features/wallet/aztec.ts` and
  `runtime/wallet-runtime.mjs`.
- Transaction sequencing or persistence failure:
  `features/wallet/wallet-flow.ts`.
- User-visible notification: `controller.ts::fail` followed by
  `web/src/ui/NotificationToasts.tsx`.

## Commands

```sh
npm run dev                 # prepare runtime assets and serve the website
npm run build               # typecheck and build the static website
npm run build:mainnet       # isolated frontend package for the deployed mainnet contracts
npm run build:runtime       # rebuild lazy SDK and workers
npm run build:contracts     # compile Noir and Solidity contracts
npm run check               # formatting, types, unit, message and deployment tests
npm run test                # unit, message and isolated release packaging tests
npm run dev:local           # local chain, deployment and website
npm run release:testnet -- plan
npm run release:mainnet -- plan
```

`npm run dev` uses an existing `web/dist/df-local.json`. The local command builds
contracts and writes a local manifest. Public release packaging is documented in
`docs/DEPLOYMENT.md`; it never deploys automatically.

The mainnet frontend reads the public, versioned `deployments/mainnet.json`.
`npm run build:mainnet` produces `.local/releases/notch-mainnet/public`; use
`-- --out PATH` for a fresh output directory on later builds. It does not read
private deployment journals, change the development manifest or upload anything.
See [Deployment](DEPLOYMENT.md) for network pins and release procedures.


## Resuming a withdrawal after reload

Withdrawal has two stages: an Aztec exit followed by an explicit L1 claim.
`withdraw` persists the exit transaction and starts a read-only proof monitor;
it never requests an L1 payment. A missing witness is a pending state, not an
error. Checks run every 30 seconds, with a 15-second request deadline and
backoff up to 120 seconds after errors. Disconnect, account replacement and
flow disposal invalidate the monitor and any late results.

`ReadyView` keeps a pending exit at step three even before the browser Aztec
session has been recreated. It shows the withdrawing amount instead of
spendable quota. Silent reconnection restores the existing account and restarts
monitoring without preparing another stake or Aztec exit. Waiting can continue
with the dialog closed; after a page closes it resumes on the next visit.

Once a proof is available, **Claim ETH** calls `controller.resumeWithdrawal`.
The flow rechecks the proof and L1 balance before requesting the user's wallet
confirmation. A saved L1 transaction is checked without resending it. The exit
record is cleared only after confirmation or a zero portal balance. Missing
transaction records show an inline warning; no transaction hash input is exposed.

## Resource ownership and cancellation

`createAztecBoardSession` owns the new PXE until it returns a complete session.
It checks the caller's lifecycle after setup and at asynchronous boundaries,
persists the derived address through `onAccountReady` before downloading board
artifacts, and stops the PXE on cancellation or failure. Once returned, the
wallet flow owns the session and its cleanup.

`claimDeposit` receives an active-session guard from the wallet flow. It checks
that guard around witness polling, fee preparation, simulation, and the point
before submission. A disposed or replaced account cannot continue polling or
submit a claim. Closing the background-restoration dialog does not invalidate
the session; disconnecting, replacing the account, or disposing the flow does.

`verifyPortal` requires both the Aztec node's Inbox and the L1 portal's Inbox to
match the deployment configuration. Stake preflight checks the existing L1 balance before deriving new keys or
requesting payment. Existing stakes without local keys enter signature recovery
instead of submitting a new deposit. `readDepositHistory` scans bounded block
ranges and validates transactions; `depositWasClaimed` computes the message
nullifier locally and sends only the siloed nullifier to the node. Recovery
checkpoints persist across refresh/export, and L1/L2 balances must reconcile
before the flow permits posting or more stake. See the root README for the
frozen `l1-signature-v1` derivation scheme and account limitations.

## Settings and custom RPC endpoints

The header settings control opens a native modal dialog, integrating appearance
selection, an optional custom Aztec node, and an optional custom Ethereum L1 RPC.
Theme changes apply immediately. Each inline Test button validates only its draft
URL; it never persists or switches transports. Editing the URL or toggling a
custom endpoint invalidates that endpoint's test result. Apply is enabled only
after every enabled custom endpoint has passed its exact-URL test; it saves the
choices and reloads the page. Use defaults stages both default choices without
saving until Apply is clicked. Contract addresses, account derivation and
pending-operation records are unchanged.

`features/settings/node-preferences.ts` stores choices by environment and Rollup
for the Aztec node, and by environment, L1 chain and Portal for the L1 RPC. Both
choices are stored in localStorage. `controller.ts::loadDeployment` applies the
choices before creating either the public client or wallet runtime. A failed
custom endpoint never silently falls back to the site's default. Settings remains
accessible when the feed cannot load; Use defaults restores both endpoints.

`node-connection.ts` checks node version, chain, Rollup, proof mode, Inbox and board
class before saving. Public nodes require HTTPS; explicit custom choices may use
HTTP or HTTPS loopback URLs. Loopback transport does not change the deployment's
network or proof policy. A self-hosted node must allow browser CORS and any local
network access requested by the browser. Pending signatures, proving, connection
and restore work disable node changes, while the theme remains usable.

`l1-connection.ts` checks HTTPS or explicit loopback access, L1 chain ID, latest
block versus the deployment block, Portal bytecode hash, Portal board and Inbox
bindings, Rollup version and stake policy. Application reads, receipt checks and
log recovery use the custom L1 RPC. Injected-wallet signing and transaction
submission continue to use the wallet's own RPC. If a wallet adds an unknown
chain, it receives the deployment's default L1 RPC rather than the reader's
custom endpoint. A custom URL is stored locally and is visible in this browser's
developer tools; it must not be treated as a server-side secret.

The modal uses native focus trapping, Escape dismissal and focus return. Closing
cancels connection testing without saving. Applying checks the current operation
lock again after testing; storage errors leave the existing connection intact.
