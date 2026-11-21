# Deployment

Notch has separate mainnet and testnet deployments. Contract deployment,
frontend packaging and hosting are independent operations.

## Networks

| Network | L1 | L2 | Manifest | Website |
| --- | --- | --- | --- | --- |
| Mainnet | Ethereum Mainnet | Aztec Mainnet | `deployments/mainnet.json` | `https://onenotch.xyz/` |
| Testnet | Ethereum Sepolia | Aztec public testnet | `deployments/testnet.json` | `https://testnet.onenotch.xyz/` |

The deployment manifests include the Rollup, Inbox, L1 portal, Aztec board,
contract class, artifact hash and configured Sponsored FPC.

## Secret Handling

Never commit, print or upload:

- L1 private keys;
- Aztec deployment accounts;
- signed deployment transactions;
- private deployment journals;
- browser account or withdrawal recovery data.

Mainnet and testnet must use separate key files and journals:

```text
.local/mainnet/deployer.json
.local/mainnet/stake-deployment.json
.local/testnet/deployer.json
.local/testnet/stake-deployment.json
```

Create deployer files with mode `600`, keep a private backup of the journal and
never place either file in a hosting package.

## Preflight

Use the pinned Node and Aztec versions:

```sh
npm ci
npm run build:contracts
npm run test:deployment
npm run test:release
npm run release:mainnet -- plan
npm run release:testnet -- plan
```

`plan` is read-only. It checks chain IDs, Rollup and Inbox binding, the SDK and
proof mode, contract artifacts and the configured FPC class. It does not load a
key or broadcast a transaction.

## Contract Deployment

Contract deployment is manual and requires `--broadcast`:

```sh
npm run release:mainnet -- deploy --broadcast \
  --key-file .local/mainnet/deployer.json
```

```sh
npm run release:testnet -- deploy --broadcast \
  --key-file .local/testnet/deployer.json
```

The order is L1 portal, Aztec board with real proofs, then one-time portal
binding. Signed transactions are checkpointed before broadcast. Do not create a
replacement deployment to recover a timeout or ambiguous receipt; resume the
recorded journal and inspect the saved transaction.

Read-only status:

```sh
npm run release:mainnet -- status
npm run release:testnet -- status
```

## Frontend Builds

Public frontend builds need Node `24.22.1` and `npm ci`. They use the versioned
manifests and `deployments/artifacts/notch-board.json`, verified against the
manifest hash. No Aztec toolchain, compiled local contract, deployment journal
or deployer private key is required. Frontend builds do not deploy contracts.

```sh
npm run build:mainnet
npm run build:testnet
```

Outputs are `.local/releases/notch-mainnet/public` and
`.local/releases/notch-testnet/public`. Existing release directories are not
overwritten; use `-- --out .local/releases/a-new-name` for another build.

### Netlify from GitHub

1. Import the repository in Netlify and select the intended branch.
2. Leave the base directory at the repository root. The committed `netlify.toml`
   sets the build command to `npm run build:netlify`, the publish directory to
   `.local/netlify/public` and Node to `24.22.1`.
3. Add `NOTCH_NETWORK` in the site's environment variables, with Builds scope:
   `mainnet` for Ethereum/Aztec mainnet, or `testnet` for Sepolia/Aztec testnet.
   This choice is required; an unset/invalid value fails before building.
4. Optionally set `AZTEC_RPC_URL` and `L1_RPC_URL` in the same location. Omit
   them to use the selected manifest's defaults. Do not add private URLs to Git.
5. Deploy. Subsequent pushes rebuild the site. Changing environment variables
   requires a new deployment; it does not change an already published build.

Use separate Netlify projects for mainnet and testnet, each with its own network
and RPC settings. Environment values can also differ by Netlify deploy context;
check the effective values before publishing a production deployment. Do not put
network/RPC overrides in `netlify.toml`, whose values take precedence over UI values.

The Netlify command replaces only its dedicated `.local/netlify` output each run,
so cached build output cannot retain another network's manifest. It emits COOP
and COEP headers and rewrites only actual application routes. Missing JS/WASM
files remain 404 rather than receiving the SPA HTML page.

### RPC overrides and local configuration

Copy `.env.example` to `.env.local` (ignored by Git):

```dotenv
NOTCH_NETWORK=testnet
AZTEC_RPC_URL=https://your-aztec-rpc.example
L1_RPC_URL=https://your-ethereum-rpc.example
```

`dev:mainnet`, `dev:testnet`, `build:mainnet`, `build:testnet` and `build:netlify`
all support these RPC overrides. Explicit mainnet/testnet commands select their
named network regardless of `NOTCH_NETWORK`. Shell/Netlify variables override
`.env.local`; absent values use the selected manifest. An explicitly empty or
invalid RPC override fails without printing the endpoint. Contract addresses,
chain IDs and Rollup identity cannot be changed through these environment variables.
Changing an RPC no longer requires editing `scripts/mainnet/config.json`; that
file configures contract deployment tooling, not the public frontend build.

RPCs must use HTTPS, allow browser CORS, and serve the selected network and
compatible Aztec version. The application checks chain and contract identity
at runtime. A successful offline build does not verify RPC availability.

**RPC URLs are embedded in the public `df-local.json` and visible to visitors.**
Environment variables keep them out of Git, not out of the browser. Use a
browser-safe provider key with domain restrictions, or a separately implemented
server proxy when credentials must remain secret. Never set deployer keys as
frontend build configuration.

Before publication, check `/df-local.json` for the selected network and addresses,
load posts, open `/about` directly and verify the wallet's network label. Upload
only the generated `public/` directory when deploying manually. Builds never
need the private `.local` journals or wallet data.

## Fee Sponsorship

Mainnet and testnet use externally maintained Sponsored FPC instances pinned in
their manifests. The frontend verifies the deployed FPC address and class.

- The testnet path checks fee-juice balance before paid workflow actions that
  use the shared fee helper.
- Mainnet checks the FPC before a new stake but does not continuously monitor or
  top up the sponsor.
- An unavailable or exhausted FPC causes a normal transaction error.

L1 deployment, stake and claim transactions still require Ethereum gas.

## Verification Boundaries

Offline build and release tests are not contract deployment tests. Local
end-to-end tests use local chains. Testnet success is not mainnet verification,
and a real-wallet mainnet check is not an independent security audit.
