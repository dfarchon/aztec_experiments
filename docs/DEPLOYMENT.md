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

The committed mainnet manifest can build a frontend without the private journal:

```sh
npm run build:mainnet
```

This creates a Netlify-ready package at:

```text
.local/releases/notch-mainnet/public
```

For testnet or a journal-verified release:

```sh
npm run release:testnet -- release --target netlify \
  --out .local/releases/notch-testnet
```

Use the same command shape with `release:mainnet` when a verified private mainnet
journal is available. The release command rebuilds the SDK, typechecks the
frontend, prepares runtime assets, checks the board artifact and builds React.

Before publication, verify:

- `df-local.json` has the intended environment, chain and contract addresses;
- `df-board-artifact.json` matches `boardArtifactHash`;
- `df-read-config.json` matches the artifact;
- the package contains no `.local`, key or journal files;
- COOP and COEP headers are present.

Published releases currently use Netlify:

```text
Mainnet project: notch-mainnet
Testnet project: df-billboard-testnet
```

Upload only the generated `public/` directory. Do not connect a cloud build that
is expected to deploy contracts or reconstruct a private journal.

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
