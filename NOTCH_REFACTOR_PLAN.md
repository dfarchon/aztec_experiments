# Notch refactoring plan

Date: 2026-11-20  
Baseline: `9718759`  
Status: implemented through Phase 4; Phase 5 pre-publication checks completed without deployment.

## Implementation record

Commits:

- `d9832d6` - `docs(notch): record refactor baseline`
- `be1fa6a` - `refactor(notch): remove retired reports and unused UI`
- `8b458d3` - `refactor(notch): remove legacy experiments and packaging`
- `91d244d` - `refactor(notch): isolate the typed Aztec runtime`
- `d8f8718` - `refactor(notch): separate account persistence and transaction coordination`
- `4e012ac` - `refactor(notch): consolidate website and build entrypoints`
- The Phase 5 verification/documentation commit records this section and the
  cleanup of stale hashed build assets.

Final checks on the refactored tree:

- Clean `npm ci --ignore-scripts` succeeded from the committed lockfile. Node
  reported the existing host mismatch (`24.3.0` instead of `.nvmrc` `24.22.1`)
  but installation completed.
- `npm run build` passed. Initial JavaScript remained 165.77 kB (54.54 kB
  gzip); the lazy wallet chunk was 274.18 kB (100.61 kB gzip); the lazy Aztec
  bundle was 64,093,130 bytes.
- 83 UI/runtime tests, 10 message tests, 13 deployment tests and five isolated
  release-package tests passed.
- The offline release remains 68.87 MB uncompressed and contains only intended
  current assets, redirects, workers and public deployment metadata.
- Local browser checks passed at desktop and 390x844 mobile widths with no
  horizontal overflow. Light/dark switching and the Connect wallet dialog were
  exercised.
- The existing public testnet site returned `200`, COOP `same-origin`, COEP
  `credentialless`, `nosniff`, title `Notch`, `crossOriginIsolated: true`, and
  loaded two public posts without a wallet. Its board artifact hash still
  matches the local compiled artifact:
  `6eda534b9a9963e3100906d638d68147a05185a98226b73d684dc74bcbeb5b1c`.

Not executed:

- No deployment, upload, push or paid transaction was performed.
- Contract test suites were not run because the execution host has Node
  `24.3.0` while the Aztec wrapper requires `.nvmrc` Node `24.22.1`.
- A real wallet approval, first setup, claim, post and withdrawal were not
  performed. Those remain HTTPS/public-testnet and funded-wallet acceptance
  items.

## Post-refactor review closeout

The follow-up review found behavior regressions despite the initial passing
suite. The fixes restore the missing withdrawal-session initialization, stop
claim polling for cancelled/replaced sessions, release PXE resources on partial
setup/artifact failures, checkpoint the derived address before artifact loading,
and restore the node/portal Inbox cross-check. Reverted L1 deposits again have a
specific error, and stake preflight checks the balance once without weakening
the recovery or cap checks. Connection availability hints and pending-action
accessible labels are preserved while busy.

New regressions cover these paths, including no automatic new stake during exit
recovery and versioned/legacy account exports with string-valued pending jobs.
Stricter file validation is retained; it is not removed merely to match an older
permissive parser.

Follow-up validation uses the pinned Node 24.22.1: formatting, lint, type checks,
100 unit/runtime tests, 10 message tests, 13 offline deployment tests, and five
isolated release tests pass. Deployment tests require access to the existing
proof cache; their simulated broadcasts are not real chain transactions.
Contract source, deployed identity, account/file formats and storage namespaces
are unchanged. No local node, paid transaction, upload, push or deployment is
part of this closeout. Real browser/testnet withdrawal and account recovery
acceptance remain outstanding; do not label those verified from mocks alone.

## 0. Baseline record

Recorded on 2026-11-20 before application changes:

- Repository baseline: `9718759d647a7620c64399d21a40cf75a9efa89c`
  (`chore(notch): remove legacy project branding`).
- Toolchain: Node `24.3.0`; `.nvmrc` requests Node `24.22.1`; npm `11.4.2`;
  Aztec `.aztec-version` is `6.0.0`.
- Package lock SHA-256:
  `02978be7fb424531a0303ec9b3e7ff030ad60f34d639073da7ff2eabe4fd6c2f`.
- Compiled board artifact SHA-256:
  `6eda534b9a9963e3100906d638d68147a05185a98226b73d684dc74bcbeb5b1c`.
- The current local manifest has `kind: "notch-stake"`, schema version `2`,
  board class
  `0x24003f1d8e97caabaa416743423e21c14c1c8147c1ee2c6a158c55e88b9bc04f`,
  and the same board artifact hash. Its RPC URLs and addresses are local
  development values and are not release configuration.
- Existing runtime sizes:
  `shared/aztec_bundle.js` 64,092,884 bytes; `shared/main.worker.js` 24,363
  bytes; `shared/thread.worker.js` 16,583 bytes;
  `shared/wallet-runtime.js` 19,603 bytes.
- Offline release fixture: Vercel 25 public files and Netlify 27 public files,
  both 68.88 MB uncompressed. The initial entry bundle is 165.77 kB
  (54.54 kB gzip), the lazy wallet chunk is 277.39 kB (101.43 kB gzip), and
  the lazy SDK bundle is 64,092,884 bytes.
- Baseline checks: `test:df:ui` passed 81 tests, `test:df:release` passed five
  tests, and TypeScript, ESLint and Prettier checks passed.

Browser durability and compatibility names recorded before refactoring:

- Wallet restoration choice: localStorage
  `notch-wallet-session/<board>` with `walletId`, `walletName` and `payer`.
- Account and pending transaction record: localStorage
  `notch-stake/6.0.0/<board>/<lowercase-payer>`. The record retains account
  keys, amount hints, deposit/claim checkpoints, pending exit and last-post
  data across versions.
- PXE store: IndexedDB database `pxe_data`; account data directory prefix
  `pxe_notch_stake_<board>_<salt>_<rollup>`.
- Exported account file: `kind: "notch-account"`, version `1`, containing the
  secret key, salt, signing key, payer, board and network binding. The current
  importer also accepts legacy records without the kind/version/network fields
  when their keys and bindings validate.
- Theme and onboarding: localStorage `df-billboard:theme` and
  `df-billboard:board-guide:v2`.
- Wallet mutation lock: Web Lock `billboard-wallet:notch-stake:<board>`.

These names and record semantics are compatibility contracts. Internal file
moves do not justify renaming them.

## 1. Objective and boundaries

Make this repository a focused, independent Notch product with one website, one current contract system, and one supported build/release path. Remove abandoned experiments and unused product logic before introducing new abstractions.

Preserve the current product:

- Public posts and publication timestamps, read without connecting a wallet.
- Batched reads, a bounded cache, infinite scrolling, skeletons, and refresh behavior.
- Ethereum wallet discovery and selection, L1 staking, Aztec setup, posting, and withdrawal.
- Existing stake tiers, rolling quota, Sponsored FPC, account import/export, and pending-transaction recovery.
- Silent authorized reconnection, background restoration of completed accounts, and a dismissible restoration dialog. Active first setup remains locked.
- Light/dark themes, the interactive background, compact status icons, account actions, and onboarding.

This is a repository and frontend refactor. Do not change contract behavior, upgrade Aztec, redeploy contracts, reset browser accounts, add a server, or introduce new product features. Keep Node and Aztec versions pinned. Do not combine this work with a visual redesign.

## 2. What exists today

The current production path is:

```text
apps/src/df-billboard/main.tsx
  -> routes.tsx -> BoardRoute.tsx
  -> runtime.ts -> controller.ts -> App.tsx and child components
                      |
                      +-> public-reader.ts + feed-reader.ts -> Aztec RPC
                      |
                      +-> stake-posting.ts -> Ethereum wallet + L1 portal
                              |
                              +-> runtime-assets.ts
                                  -> shared/sdk-entry.mjs, bundled as __aztec
                                  -> shared/wallet-runtime.js -> browser PXE/proofs
```

Current contracts are in `df-billboard/contract/` and `df-billboard/portal/`. Public deployment and release code lives in `scripts/testnet/` and `scripts/deploy-billboard-testnet.mjs`.

The following sizes describe concentration of responsibilities, not deletion targets:

| File | Approximate lines | Main concern |
| --- | ---: | --- |
| `controller.ts` | 525 | Feed coordination, session restoration, actions, progress, and errors share one closure |
| `stake-posting.ts` | 1,001 | L1 deposit, L2 claim, recovery, account files, posting, and withdrawal share mutable state |
| `WalletPanel.tsx` | 559 | Several wallet/setup/recovery/Ready views share a large conditional tree |
| `styles.css` | 1,324 | Current UI styles coexist with selectors left by retired features |
| `shared/wallet-runtime.js` | 438 | Current proof runtime also carries globals and DOM fallbacks for older apps |

The repository also contains an earlier contract system, standalone HTML experiments, censor tooling, formal-verification work for the older design, and classification/report code that the current UI no longer uses. Those are separate from the production path above.

## 3. Removal inventory

### A. Remove after checking their remaining callers

The intended disposition is deletion from the active tree. Git history preserves the earlier implementation; do not create another maintained archive application in this repository.

| Paths | Evidence / reason | Required accompanying changes |
| --- | --- | --- |
| `apps/src/billboard/`, `apps/src/fee-juice/` | Standalone HTML/CLI experiments built by `apps/build.mjs`; outside the current React website | Remove their build commands, dedicated scripts, and template-only resources together |
| `billboard/` | Earlier deposit/censor contracts and tests; current contracts live under `df-billboard/` | Remove only the old contract toolchain and tests; preserve the current portal and board |
| `censor-daemon/` | Earlier censor workflow; not used by current Notch posting | Remove `test:daemon` and its exclusive dependencies/resources |
| `fv/`, `LATEST_CHANGE.md`, `SECURITY_PROPERTIES.md`, `LEGACY_BILLBOARD.md` | Historical work describing the old system, including Aztec v5 verification | Remove active README references; do not present old proofs as verification of current contracts |
| `apps/build.mjs`, `apps/serve.py` | Earlier HTML packaging/server path | Confirm no current command invokes them, then remove |
| `scripts/build-contract.mjs`, `scripts/build-portal.mjs`, `scripts/test-local-e2e.mjs` | Explicitly reference the earlier `billboard/` or `apps/src/billboard/` paths | Remove corresponding legacy npm commands |
| `scripts/test-sdk.mjs` | Uses the old artifact and runs `wallet-runtime.js` with `aztec-lib.js` | Move any unique runtime/worker regression checks to current runtime tests before deleting |
| `shared/patch_bundle_workers.cjs`, `shared/extract_thread_worker.cjs` | Earlier bundle-patching/extraction strategy; current `build-sdk.mjs` bundles upstream worker entrypoints directly | Check callers outside npm scripts too; remove obsolete patch commands, not current worker generation |

### B. Remove current-source features that have no product consumer

| Paths / symbols | Current consumers | Planned action |
| --- | --- | --- |
| `moderation.ts`, `keywords.ts`, `ai-config.ts`, their tests | Classification/report tooling and tests; no current feed or wallet consumer found | Delete with the retired report pipeline |
| `report-data.ts`, `report.test.mjs`, `scripts/build-df-report.mjs` | Offline reading reports; `/reports` now redirects to `/` | Remove report generation and `report:df:reading`; retain the old URL redirect |
| `Select.tsx` and its isolated React test | Only the test renderer imports the component; wallet selection uses buttons | Delete the unused component and its test/export fixture |
| `RuleCategory`, `Category`, `ReportRow`, `ReadingReport`, and classification-only `PostData` fields | The retired classification/report modules | Remove after their consumers are gone; retain `decodeError`, which the feed still renders |
| Obsolete CSS selectors | Examples to investigate include `#verification`, `#emoji`, and `.notch-wallet-pending` | Remove only selectors with no remaining markup or scripted use; preserve `.shell`, which routes still use |

Tests for deleted functionality should be deleted. Tests alone do not justify keeping a component with no runtime or supported tooling consumer.

### C. Extract current behavior before deleting old shared files

These files cannot all be removed with a blanket `shared/` deletion:

| File / group | Disposition |
| --- | --- |
| `shared/wallet-runtime.js` | Migrate its current account/PXE/proof behavior into a typed, explicitly configured module; then remove the old global/DOM interface |
| `shared/df-billboard.mjs` | Preserve message encoding/decoding and fee estimation; move to a small protocol module shared by frontend and scripts |
| `shared/sdk-entry.mjs`, `shared/noir-runtime.mjs`, `scripts/build-sdk.mjs` | Keep a deliberate lazy SDK/proof boundary; narrow exports only after mapping browser and script consumers |
| `shared/aztec-lib.js`, `helpers.js`, `app-env.js`, `wallet-buttons.js`, `styles.css`, vendored `ethers.min.js`, `poseidon2.js`, `moderation-policy.js`, `rpc-config.json` | Candidates for removal after the HTML apps and SDK test migration are complete; verify each resource's textual/build consumers first |
| Generated `aztec_bundle.js`, `main.worker.js`, `thread.worker.js` | Continue generating and publishing the current required assets; these are not unused because they lack static imports |
| Generated `thread_worker.js` | Old underscore-named extraction output; distinguish it from the current dot-named worker before removing stale generated files |

### D. Preserve operational and recovery data

Do not delete `.local/`, `.pxe-cache/`, `.netlify/`, browser localStorage, or IndexedDB as part of source cleanup. In particular, `.local/` contains deployment journals, keys, release manifests, and transaction records as well as disposable output. Never treat it as one cache directory.

Keep `df-billboard/`, the current testnet scripts, `deploy-df-harness.mjs`, `start-local.sh`, `sync-df-clock.mjs`, and their relevant tests. Local tooling is still a supported development capability even when the production website uses testnet. Do not start local nodes while executing this refactor unless the user explicitly requests that test environment.

## 4. Target structure

Keep one npm package and one lockfile. No workspace packages or new framework are needed.

```text
web/
  index.html, vite.config.ts, tsconfig.json
  src/
    main.tsx
    app/                 # App, routes, runtime lifetime, controller, view types
    features/
      feed/              # Feed, timestamps, batched reader, public RPC adapter
      wallet/            # Panel/subviews, L1 discovery, session, account files,
                         # stake/posting coordinator, portal and Aztec adapters
    ui/                  # Used primitives: Icon, LoadingIcon, StepIndicator, toasts
    appearance/          # Theme, brand, interactive background, onboarding
    styles.css           # Split only where a clear component boundary helps
  tests/                 # Or colocated tests; use one consistent convention
protocol/
  message.mjs            # Current message format and fee helpers used by scripts
scripts/
  testnet/               # Existing verified deployment/recovery/release tooling
  ...                    # Current SDK/assets build and local development scripts
runtime/
  sdk-entry.mjs          # Lazy heavy SDK boundary
  noir-runtime.mjs
  ...                    # Typed browser runtime adapter and worker build support
df-billboard/           # Existing Noir package, portal, and contract tests
README.md
package.json
package-lock.json
NOTCH_REFACTOR_PLAN.md
```

The existing contract directory/package names are intentionally retained. A filesystem cleanup must not change Noir package names, ABI, storage layout, compiled artifact identity, deployed addresses, or contract behavior. The `web/` move is a late mechanical step, not the first change.

### Frontend ownership rules

- UI renders view state and dispatches actions. It does not sign transactions, read account secrets, poll receipts, or call contract methods.
- The application controller owns one observable store and operation lifetime. Keep `useSyncExternalStore`; do not add Redux, Zustand, or a second event bus for this refactor.
- Feed reads own their snapshot/cursor/cache lifecycle. Wallet initialization must not become a prerequisite for public reads.
- The wallet coordinator owns the transaction sequence and persisted pending jobs. Portal and Aztec adapters own concrete SDK/RPC operations.
- A small account-storage module owns record validation and persistence. An account-file module owns versioned import/export validation. UI downloads an account file through the coordinator.
- The heavy runtime accepts node configuration, keys, progress callbacks, and storage namespace explicitly. Remove hidden form inputs and `window.RPC_CONFIG`, `window.log`, `window.deriveAccountAddress`, and similar cross-module globals after migrating their consumers.
- An isolated adapter may continue to bridge `window.__aztec` while the existing IIFE bundle is retained. Do not force the full SDK into Vite's initial bundle just to eliminate that final global.

Extract modules only along these responsibilities. Do not split every function into its own file or introduce generic repositories, service containers, workflow engines, or state-machine libraries.

### Readability is a primary acceptance criterion

The owner must be able to understand the frontend without first reading the Aztec SDK. Reducing file count or moving existing code into more folders is not sufficient. Keep the UI familiar and make its implementation easier to follow.

Use a feature-oriented layout. Keep a feature's components, domain types, and operations together; reserve `ui/` for primitives actually reused by the product. Use one consistent test convention, preferably tests beside their owning modules. Avoid deep folders and barrel exports that hide where a function is implemented.

A concrete wallet decomposition is:

```text
features/wallet/
  WalletPanel.tsx        # Modal shell, choosing a view, close/focus behavior
  ConnectView.tsx        # Choosing an installed Ethereum wallet
  SetupView.tsx          # Amount choice, first setup, progress, continuation
  ReadyView.tsx          # Stake/quota, top-ups, export, withdrawal, disconnect
  wallet-flow.ts         # Explicit stake -> confirmation -> setup -> claim flow
  wallet-session.ts      # Connection, authorized restoration, cancellation
  account-storage.ts    # Durable records and validation; no UI logic
  account-files.ts      # Versioned export/import validation and serialization
  l1.ts                 # Existing provider discovery/authorization helpers
  portal.ts             # Concrete L1 portal reads, deposits, receipts, withdrawal
  aztec.ts              # Concrete account/board calls through the lazy runtime
  types.ts              # Wallet domain types, operation results, view status
```

These names describe responsibilities, not a requirement to create empty wrappers. Merge adjacent modules if they would only forward calls and separating them would make the flow harder to read. Keep protocol operations out of React hooks.

| Current file | Readable result |
| --- | --- |
| `App.tsx` | Page composition: header, feed, composer, notifications. Extract a Composer component if it makes the page structure clearer; do not keep wallet recovery branches in the page markup |
| `controller.ts` | A small application coordinator and its one observable store. Delegate actual feed, session, and transaction work to their feature modules |
| `stake-posting.ts` | Named wallet flows plus account storage/files and concrete portal/Aztec operations. A reader can follow the main sequence without scrolling through import parsing or unrelated withdrawal code |
| `WalletPanel.tsx` | Modal shell plus the three named views above, with clear props/callbacks and early returns instead of a long nested conditional tree |
| `types.ts` | Small application-view types and feature-local domain types. No retired report types, untyped dependency bags, or file-wide suppression of errors |
| `styles.css` | Remove obsolete rules first. Keep tokens/base styles together and extract only substantial feature styles; do not create one stylesheet per trivial element |
| `shared/wallet-runtime.js` | An explicitly configured runtime module with documented inputs/results; its implementation is outside the ordinary UI reading path |

Implementation rules:

- Prefer descriptive names such as `aztecSdk`, `publicReader`, `connectedAccount`, and `pendingDeposit` over `A`, `R`, `a`, `S`, or a generic `local` object crossing several layers.
- Keep the happy path visible. Use named guards/early returns for missing authorization, uncertain submission, and missing notes. Put retries in the operation that owns them, not in several UI/controller layers.
- Use short typed functions and explicit parameters/results. A persisted account record, a pending transaction, a runtime resource, and UI view state are different concepts and should have different types.
- Keep each fact in one owner. Derive `canPost`, displayed stage, and button state from canonical session/operation facts instead of manually keeping several flags synchronized across components.
- Keep durable transaction checkpoints even when simplifying UI state. Readability is not a reason to replace safe recovery with a single loading flag.
- Comments explain ordering, recovery guarantees, SDK constraints, or protocol assumptions. Remove stale history and comments that merely repeat the next line. Document unusual storage/worker behavior where it is implemented.
- Judge file/function size by responsibility and nesting, not a rigid line-count target. Do not turn a long readable function into many indirect one-line calls just to meet a size limit.

During Phase 3, add `docs/FRONTEND.md` in plain English and link it from the root README. It must show the directory map, each layer's owner, what is persisted versus recreated, and these reading paths:

1. **Page startup and public posts:** `main` -> application startup/controller -> feed reader -> public RPC -> Feed.
2. **A first stake:** SetupView action -> wallet flow -> saved L1 submission -> parallel proof preparation -> verified confirmation -> Aztec claim -> Ready state.
3. **A post:** Composer -> controller action -> wallet flow/Aztec call -> updated quota and feed -> draft clearing.
4. **A returning account:** saved wallet choice -> `eth_accounts` -> session restoration -> lazy runtime -> chain verification -> ready status; closing the modal only hides the view.
5. **An imported account:** file selection -> account-file validation -> restored identity -> private-note sync -> verified stake/quota; no additional L1 deposit.

The guide must identify actual implemented file/function names. It must not describe an intended architecture that the code does not follow. A new contributor should be able to find the owner of a button's behavior, account persistence, or a failing RPC without searching the entire repository.

## 5. Execution order and proposed commits

### Phase 0 — Establish the baseline

Record the base revision, current public manifest, board artifact hash, release resource sizes, current npm commands, and known account-storage formats. Do not copy secrets into documentation or test fixtures.

The latest functional baseline has 81 passing UI/runtime tests and five release checks. These counts include tests for features proposed for deletion and must not be treated as fixed targets. The clean-account integration script exists, but its existence does not prove it has been executed successfully on public testnet.

Check callers through imports, script entrypoints, HTML resource references, runtime string URLs, test fixtures, and release copying. `rg` alone does not prove a dynamically loaded resource is unused.

### Phase 1 — Remove unused React-era features

Proposed commit: `refactor(notch): remove retired reports and unused UI`

Delete the classification/report pipeline and unused Select component. Remove their npm commands, tests, exported types, sample/report fields, and exclusively owned CSS. Preserve feed error handling and publication timestamps.

Exit criteria: no live import into deleted modules; current UI, type, lint, and release checks pass; old report URLs still resolve as before.

### Phase 2 — Remove the earlier experiments and build path

Proposed commit: `refactor(notch): remove legacy experiments and packaging`

Remove inventory A, along with legacy-only shared files whose consumers have disappeared. First transfer any unique proof/runtime regression coverage from `test-sdk.mjs`. Remove stale docs and update README commands/layout in the same commit.

Review direct dependencies after removing their consumers:

- `linkifyjs` becomes a removal candidate with moderation removed.
- `fake-indexeddb` becomes a removal candidate after checking whether migrated runtime tests need it; if retained only for tests, classify it accordingly.
- Do not remove `@aztec-labs/wallets`: current deployment and integration scripts use `EmbeddedWallet`.
- Do not remove `driver.js`: current onboarding uses it.
- Audit remaining SDK/prover dependencies against script and bundler entrypoints, not just React imports.

Exit criteria: the website and release build work without invoking the legacy HTML builder or reading old contract artifacts; installation works from the committed lockfile.

### Phase 3 — Make wallet/runtime boundaries explicit

Prefer two reviewable commits:

1. `refactor(notch): isolate the typed Aztec runtime`
2. `refactor(notch): separate account persistence and transaction coordination`

Migrate proof preparation, account derivation, PXE lifecycle, account registration, and signing capsule setup from the shared global runtime. Preserve their order and existing behavior before reducing SDK exports.

Extract account record/file logic and concrete L1/Aztec operations from `stake-posting.ts`. Keep one coordinator for deposit, claim, post, and withdrawal sequencing. Type dependencies and results so the file-wide `@ts-nocheck` in the coordinator and controller can be removed; isolate unavoidable generated-SDK uncertainty inside narrow adapters.

Do not replace transaction recovery with a single UI `busy` flag. Durable facts such as an L1 hash, deposit secret, L2 prepared hash, uncertain submission, pending exit, and completed setup remain distinct. Derive UI flags from those facts rather than maintaining several independent copies of the same status.

Keep one restore task per session. Closing its dialog must not stop it; disconnect, account/network changes, and disposal must invalidate late results. A failed restore cannot silently create an account or start another deposit.

Split `WalletPanel` only into meaningful views such as wallet choice, setup, and Ready account controls. Keep the existing StepIndicator and loading icon reusable. Do not create a second copy of stake policy in UI code.

Exit criteria: account-file round trips, pending-payment recovery, background restoration, transaction locks, progress display, and worker loading remain covered; no legacy DOM fallback is required by the product. The frontend readability requirements above and the implemented reading guide are complete; deletion-only cleanup does not satisfy this phase.

### Phase 4 — Normalize the source and command layout

Proposed commit: `refactor(notch): consolidate website and build entrypoints`

Move the current website to `web/` and shared current protocol/runtime files to their target locations. Update imports, Vite roots, ESLint/TypeScript/format globs, tests, deployment scripts, and README references atomically.

Expose a short command set such as `dev`, `build`, `check`, `test`, `build:contracts`, and `release:testnet`, with explicit local-development commands. Separate a frontend-only dev command from the command that starts a local chain. Retire old internal npm aliases once their callers and docs are migrated.

Preserve published configuration/asset URL contracts and local account namespaces during this move, including existing `/df-*.json` URLs, account storage keys, IndexedDB names, exported file identity/version, and old-page redirects. Internal naming changes do not justify breaking already-funded browser accounts.

Keep React Router if its aliases and not-found behavior are still useful. Remove it only in a separate, demonstrated simplification that preserves those behaviors; a single visible page is not enough evidence by itself.

Exit criteria: the documented commands run against the new tree, all current paths are resolvable, and build output contains only the intended public files.

### Phase 5 — Verify and publish once

Build the isolated Netlify release from the unchanged, verified testnet deployment. Publish to the existing site only after the final checks below. Keep the prior known-good deploy available for rollback. Do not publish an intermediate cleanup phase or redeploy contracts.

Check the public domain's build identity, Notch title, headers, post reads, and wallet UI. Clearly distinguish automated/mocked tests from actual testnet wallet verification in the completion report.

## 6. Required acceptance checks

| Area | What must remain true |
| --- | --- |
| Public feed | Reads without heavy wallet/proof code; batches stay ordered and pinned to one snapshot; retry does not skip or duplicate posts |
| UI | Compact steps/status/actions, both themes, narrow-screen bounds, synchronized skeletons, onboarding, and copyable errors still work |
| Silent restore | Uses `eth_accounts`; does not prompt, switch networks, create another identity, or pay again; header stays usable while restoring |
| Setup | Proof preparation overlaps L1 waiting; first active setup stays locked; returning to pending state never duplicates payment |
| Account recovery | Ready export imported into an empty browser/PXE recovers the same address, depositor, stake, and remaining quota; wrong files/payers/networks fail safely |
| Posting | Existing identity and quota are used; successful submission clears the draft; failure preserves it; uncertain submissions do not automatically resend |
| Withdrawal | Lock rules, persisted exit recovery, and L1 release remain unchanged |
| Cancellation | Closing a restoration dialog keeps work alive; disconnect/change/dispose prevents old tasks from updating another session |
| Build | SDK/proof assets remain lazy; WASM and workers resolve; COOP/COEP headers and missing-asset 404 behavior are preserved |
| Contracts/data | Artifact hash, addresses, wire encoding, account derivation, file format, and browser data namespaces are unchanged |
| Release | No keys, account files, private journals, local RPC configuration, or research datasets enter the public directory |

Use existing meaningful tests and move them with their owners. Add tests for changed boundaries and failure paths, not for every deleted line or mechanical move. Run targeted checks after a phase and the full relevant suite before release; do not rebuild/prove after every small edit.

Use public testnet for real wallet verification under the user's existing testing preference. Do not remove the local-only guards from `test-df-stake-e2e.mjs` to make it run against testnet. If funded browser verification needs a wallet approval, request that specific action and report the remaining acceptance item instead of claiming a mocked test proves it.

## 7. Completion and rollback

The refactor is complete when the repository has one current product/build path, deleted modules have no remaining references, the heavy SDK is still lazy, controller/runtime boundaries are typed and explicit, account/recovery compatibility is preserved, the final package passes checks, and the public site has been verified.

Report commits, deleted feature groups, moved files, dependencies removed, checks performed, final public URL/deploy identity, and any unexecuted real-wallet checks. Do not claim a smaller proving bundle or faster setup without measurement; initial-bundle and proof-resource sizes must be reported separately.

If a phase fails, fix or revert that phase before proceeding. Never clear account data, replace a pending payment, change contract artifacts, or broadcast a new deployment to make a refactor pass. Roll back a bad website deployment to the prior frontend build while preserving on-chain and browser state.

## 8. Suggested next-session instruction

Read `NOTCH_REFACTOR_PLAN.md` and execute Phases 0–4 in order, followed by the final pre-publication checks from Phase 5. The objective includes an understandable frontend, not only deleting old files. First remove unused features and legacy experiments, then simplify the controller, split wallet views and transaction responsibilities, migrate the global runtime, and normalize the layout. Follow the concrete readability requirements in Section 4 and deliver the implemented `docs/FRONTEND.md` reading guide. Keep one state owner, retain lazy wallet/proof loading, and avoid new frameworks or layers that only forward calls.

Preserve current Notch behavior, contracts, account identity, storage formats/namespaces, and private recovery data. Migrate unique runtime tests before deleting their old harness. Run appropriate checks and make the proposed focused commits as phases complete. Do not stop after deletion-only cleanup or claim the frontend was refactored after merely moving files. Do not start local nodes, send testnet payments, push, or deploy unless authorized in that session. Report commits, meaningful simplifications, checks, and outstanding real-wallet validation. Clarify genuinely undecided product requirements before changing behavior.
