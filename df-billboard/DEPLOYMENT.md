# Public testnet deployment

The website is static on Vercel. Contracts are deployed from your computer, not
from Vercel. The two contracts are **BillboardInbox on Ethereum Sepolia**, then
**DFBillboard on Aztec Testnet**. This does not deploy the Aztec protocol.

## 1. Build and inspect (no transactions)

Use the Node version in `.nvmrc` and the Aztec toolchain in `.aztec-version`.
From the repository root:

```sh
npm ci
npm run build:df
npm run build:df:l1
npm run deploy:df:testnet -- plan
npm run test:df:deployment
npm run test:df:release
```

`plan` is the default. It does not load deployment keys, create accounts, sign,
or broadcast. It verifies the SDK version, real-proof mode, Sepolia chain ID,
Rollup/Inbox addresses, compiled artifacts and canonical Sponsored FPC. A funded
FPC is not a guarantee of future sponsorship or availability.

Network pins live in `scripts/testnet/config.json`, based on the
[official network directory](https://docs.aztec.network/networks). Use
`--config PATH` for a reviewed alternative configuration. All RPC URLs in this
file are published to browsers: use public, browser-accessible HTTPS endpoints,
not secret API credentials. Network upgrades require an explicit review; scripts
will not silently accept a new Rollup or SDK version.

The release smoke test uses **offline fixture addresses**, sends nothing and
deletes its temporary output. It is not an on-chain deployment test.

## 2. Deploy (only when approved)

Use a dedicated Sepolia account funded with test ETH for L1 deployment gas. In a
local editor, create `.local/testnet/deployer.json` containing a JSON object with
one field, `l1PrivateKey`, holding that account's private key. Set permissions to
`600`. Do not use a mainnet-funded wallet, paste keys into commands, commit this
file, or add it to Vercel environment variables.

**The following command sends public testnet transactions:**

```sh
npm run deploy:df:testnet -- deploy --broadcast \
  --key-file .local/testnet/deployer.json
```

The script uses real client proofs and the canonical Sponsored FPC for L2 fees.
It generates a separate Aztec deployment account locally and saves it before
proving. It never uses the sandbox's predefined test accounts. The website's
users create/connect their own accounts; this deployment key is not shipped.

The default journal is `.local/testnet/deployment.json` (mode `600`, git-ignored).
It records network/artifact bindings, contract addresses, signed transaction
bytes and hashes, the generated Aztec account, and confirmation checkpoints.
The L1 private key is **not** copied into the journal.

## 3. Restore / resume

```sh
# Read-only status; no key file needed.
npm run deploy:df:testnet -- status

# Resume the exact recorded transactions, not a second deployment.
npm run deploy:df:testnet -- deploy --broadcast
```

If L1 has not yet been prepared, supply `--key-file` again. After it is prepared,
recovery uses the saved signed transaction and does not read that key. The script
waits for two L1 confirmations and an Aztec checkpoint, then checks the deployed
class and the board's L1 Inbox binding. Repeating the command revalidates completed
stages without deploying replacements.

- A transaction is persisted **before** broadcast. If the response is lost,
  recovery checks its hash and, if absent, resubmits the same bytes.
- Timeouts preserve the journal. A revert or expired/rejected Aztec proof stops
  the process; it does not generate a replacement or choose a new nonce. Inspect
  the recorded transaction before deciding how to recover. Do not delete the
  journal to get past an error.
- A changed network or artifact is rejected. Keep the exact source revision,
  lockfile and compiled artifacts with your private deployment backup.
- Concurrent runs are blocked by `deployment.json.lock`. After a process crash,
  inspect the PID in that file and confirm no deployment is running before
  removing **only that lock file**, not the journal.

Back up the journal privately after each stage. It includes an account secret
and replayable signed transactions. To restore on another machine, restore the
same artifacts and journal with permissions `600`, then pass `--state PATH` to
`status`, `deploy`, `export`, or `release`. Never publish the journal. No local
chain reset or production website data migration is part of this workflow.

## 4. Export and generate the Vercel package

After both contracts are confirmed:

```sh
# Optional: inspect/share just the public deployment metadata.
npm run deploy:df:testnet -- export --out .local/testnet/public-manifest.json

# Revalidate contracts on chain and build an isolated static release.
npm run deploy:df:testnet -- release --out .local/releases/testnet-v1
```

Both commands are read-only on chain and refuse incomplete deployments.
Existing output paths are not overwritten; use a new path for each release.
The release rebuilds the SDK, typechecks the client, prepares runtime assets,
and builds React. It does not copy the existing `apps/dist` or change its local
deployment manifest.

The package includes only the ONNX runtime referenced by the bundled model
worker, not every backend distributed with ONNX Runtime. Release source maps
are omitted; normal local builds still generate them. Model weights remain
downloaded on demand when the reader enables AI filtering.

Before writing the deployable config, the build checks the uncompressed output
against a conservative **100,000,000-byte / 15,000-file budget**. This matches
the [Hobby CLI upload limits](https://vercel.com/docs/limits#static-file-uploads)
without relying on archive compression. Run `npm run test:df:release` for an
offline fixture build, asset/budget checks, and a size report. It never deploys
contracts or uploads to Vercel; passing is not a hosted-browser acceptance test.

Generated [Vercel Build Output API](https://vercel.com/docs/build-output-api) layout:

```text
.local/releases/testnet-v1/
  .vercel/output/
    config.json          # v3 routes, COOP/COEP headers, missing-asset 404s
    static/
      index.html
      df-local.json      # public testnet manifest; historical filename
      df-board-artifact.json
      df-sponsor-artifact.json
      aztec_bundle.js
      main.worker.js
      thread.worker.js
      df-wallet-runtime.js
      df-toxicity.worker.js
      assets/            # React, CSS, fonts
      onnx/              # optional local model runtime
      ...                # README/license and legacy URL redirects
```

There are no deployment keys, journals, local test accounts, or dev tools in this
package. `config.json` is written last, so an interrupted build is not marked as
a deployable release. COOP `same-origin` and COEP `credentialless` cover the page
and workers. Only known app routes fall back to HTML; missing JS/WASM/JSON returns
404. Runtime assets revalidate instead of retaining stale contract metadata.

When ready to publish, install/use the Vercel CLI, enter the generated directory,
and link a **dedicated testnet Vercel project**. Vercel's first deployment of a
new project is production even without `--prod`; do not use an existing live
product's project or domain for this first validation:

```sh
cd .local/releases/testnet-v1
vercel link
vercel deploy --prebuilt
# Subsequent production updates, after checking a preview:
vercel deploy --prebuilt --prod
```

These publish commands are manual and are never called by the deployment script.
See [Vercel prebuilt deployment](https://vercel.com/docs/cli/deploy#prebuilt).
Vercel also supports `--archive=tgz` for prebuilt uploads. The budget check
covers this generated output, not extra files added to the release directory.
Hobby is for [personal, non-commercial use](https://vercel.com/docs/plans/hobby);
meeting its upload limit does not establish that a team's commercial deployment
is eligible. Confirm the intended use and account plan before publishing.
Do not connect an auto-build to the repository expecting it to deploy
contracts or reconstruct a private journal.

## Before inviting users

Verify both wallet flows on the HTTPS preview, including real proof generation,
Sponsored FPC payment, MetaMask Sepolia requests/resume, and reading the resulting
messages. Check RPC CORS/accessibility and Worker isolation headers in a real
browser. Local/mocked tests and a successful deployment are not a substitute for
that public-testnet acceptance test. Review sponsor funding/availability and
privacy limitations before describing the service as production-ready.
