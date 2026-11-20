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
| `web/src/features/wallet/` | Wallet panel and views, account persistence, import/export, L1 portal operations, Aztec board operations and transaction sequencing |
| `web/src/ui/` | Reused product primitives such as icons, loading state, steps and notifications |
| `web/src/appearance/` | Theme, brand, interactive background and onboarding guide |
| `protocol/message.mjs` | Post encoding/decoding and sponsored-fee estimation shared with scripts |
| `runtime/` | Lazy SDK entry, wallet/PXE runtime, Noir runtime and IndexedDB namespace helper |
| `runtime/generated/` | Ignored SDK and worker build output |
| `scripts/` | Contract, runtime, local-chain, deployment and release tooling |
| `df-billboard/` | Current Noir contract, L1 stake portal, tests and deployment notes |

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
- `features/wallet/portal.ts` performs concrete Sepolia portal calls.
- `features/wallet/aztec.ts` performs concrete Aztec board and PXE-facing calls.
- `features/wallet/account-storage.ts` owns the durable browser account record.
- `features/wallet/account-files.ts` owns versioned import/export validation.
- `features/wallet/wallet-session.ts` owns the silent-reconnect preference.

The UI never signs a transaction, reads an account secret, polls a receipt, or
calls a contract method.

## What is persisted

Browser names and file formats are compatibility contracts:

| Data | Location |
| --- | --- |
| Last authorized wallet | localStorage `notch-wallet-session/<board>` |
| Account keys and transaction checkpoints | localStorage `notch-stake/6.0.0/<board>/<lowercase-payer>` |
| PXE data | IndexedDB `pxe_data`, under the board/salt/rollup-specific data directory |
| Account export | JSON file with `kind: "notch-account"` and version `1` |
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
3. `sendDeposit` verifies the Sepolia portal in
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

### An imported account

1. `features/wallet/SetupView.tsx` selects a JSON file and calls
   `controller.importStakeBackup`.
2. `controller.ts::prepareWallet` loads the typed runtime.
3. `features/wallet/account-files.ts::readAccountFile` validates file size,
   JSON shape, version, board, payer, network, deposit hash, Aztec address and
   amount hint before replacing local state.
4. `wallet-flow.ts::operations.restore` writes the validated record through
   `account-storage.ts`.
5. The controller calls `initializeAztec`. A fresh PXE registers the imported
   account before sync, discovers historical private notes, and
   `wallet-flow.ts::refresh` verifies the original stake and remaining quota.
   No L1 deposit is prepared.

## Finding failures

- Public read failure: `controller.ts::loadFeed` calls `feed-reader.ts` and
  `public-reader.ts`; retry keeps the previous cursor and posts.
- Wallet authorization failure: `features/wallet/l1.ts`.
- Portal or Sepolia failure: `features/wallet/portal.ts`.
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
npm run build:runtime       # rebuild lazy SDK and workers
npm run build:contracts     # compile Noir and Solidity contracts
npm run check               # formatting, types, unit, message and deployment tests
npm run test                # unit, message and isolated release packaging tests
npm run dev:local           # local chain, deployment and website
npm run release:testnet -- plan
```

`npm run dev` uses an existing `web/dist/df-local.json`. The local command builds
contracts and writes a local manifest. Public-testnet release packaging is
documented in `df-billboard/DEPLOYMENT.md`; it never deploys automatically.


## Resuming a withdrawal after reload

`ReadyView` keeps the saved withdrawal action visible even before the browser
Aztec session has been recreated. `controller.resumeWithdrawal` first calls
`initializeAztec` if needed, then resumes the saved exit or recovers the supplied
exit hash. Initialization reads the existing identity; it never prepares another
stake or starts another Aztec withdrawal. If initialization fails, the saved exit
remains pending and can be retried.

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
match the deployment configuration. Deposit preflight reads the L1 stake once
and checks account recovery and the cap before requesting a wallet signature.
