# Notch mainnet configuration

Mainnet configuration is separate from the existing testnet deployment. Adding
this configuration does not deploy contracts, publish the website or move funds.

## Network and fee payer

`scripts/mainnet/config.json` pins Aztec 6.0.0, Ethereum chain ID `1`, Rollup
version `2070860440`, the Rollup and Inbox addresses and the externally maintained
Sponsored FPC:

```text
0x2b4bb42e8d8a7978edae5c3a078cc5d53c8cf3875fd3c191a3fba9cab7508dcf
```

The frontend and deployment CLI fetch that contract instance from the configured
node and compare its current class ID with the SDK-pinned Sponsored FPC artifact.
They do not assume the canonical testnet salt. Mainnet has no sponsor balance
precheck, warning, polling or top-up tooling in this project. The maintained FPC
pays L2 fees; Ethereum deployment, stake and claim transactions still need ETH.

## Confirmed deployment

Deployed and cross-checked on 2026-11-21:

| Contract | Mainnet address |
| --- | --- |
| Ethereum Portal | `0x472B1dC69736C9B6034CE7aAbBa1ff5f7f16307a` |
| Aztec board | `0x090065f980667a9f5273c8b7e7ff31d234c375bfc172539f43d2c91284717c78` |

Deployment transactions:

- Ethereum Portal: `0x4d56178a0fe09fa0b4cee4f7c489197eb0a03345f84e40f28006ddeea66f250c`
- Aztec board: `0x1bd255d6c00946767e4d48fb0988953060f099de0d8ae3e07f3beaf5a7f42cb4`
- Portal binding: `0x2259ef16f8ccdd70a3ea43f8524644405912658a606eacc94c092e0da401a87f`

Both contract references and the board class were checked onchain. The public
manifest is `.local/mainnet/public-manifest.json`. The website has not been
published to this deployment yet. Resume the existing journal instead of creating
another deployment when preparing its release.

## Read-only preflight

Use the pinned Node and Aztec versions from the repository root:

```sh
npm run release:mainnet -- plan
npm run test:deployment
```

The plan checks both networks' actual chain IDs, SDK/proof mode, Rollup/Inbox
binding, compiled artifacts and deployed FPC class. It never loads keys, creates
accounts, signs or broadcasts a transaction. Changes to protocol version or
Rollup addresses fail closed and require a reviewed configuration change.

## Deployment and publication

For a future mainnet deployment, create a dedicated private key file locally at
`.local/mainnet/deployer.json` with the field `l1PrivateKey` and permissions `600`.
Never reuse the testnet key file implicitly or include keys in commands, Git or
hosting configuration. The following command sends mainnet transactions:

```sh
npm run release:mainnet -- deploy --broadcast \
  --key-file .local/mainnet/deployer.json
```

The order is Ethereum Portal deployment, Aztec board deployment with real proofs,
then one-time Portal binding. Signed transactions are checkpointed before sending.
The default private journal is `.local/mainnet/stake-deployment.json`; testnet
continues using `.local/testnet/stake-deployment.json`. A journal cannot be reused
with another network, FPC or artifact. The CLI requires explicit `--broadcast`;
omitting it cannot submit a deployment. `release:mainnet` explicitly selects
`--network mainnet`; the existing `release:testnet` command defaults to testnet.

After every deployment stage is confirmed:

```sh
npm run release:mainnet -- status
npm run release:mainnet -- release --target netlify \
  --out .local/releases/notch-mainnet
```

The isolated package includes `environment: mainnet`, the deployed Portal/board
addresses, the matching artifacts and the configured FPC. It contains no private
deployment journal or keys and is not automatically uploaded. Publish only its
`public` directory to the intended site. Do not replace an existing site's
manifest with invented or testnet board addresses. The wallet panel identifies
Aztec Mainnet before a paid action; wallet switching uses Ethereum chain ID `1`.

For the deployment recorded in this document, the versioned public manifest is
`deployments/mainnet.json`. Build its frontend without the private journal:

```sh
npm run build:mainnet
# For another build, choose a fresh release directory:
npm run build:mainnet -- --out .local/releases/notch-mainnet-next
```

This produces a Netlify-ready `public` directory and checks the compiled artifact
against the deployed artifact hash. It does not change the development manifest
or publish the website.

Funding checks, bridge operations and maintenance of the supplied FPC are outside
this integration. An unavailable FPC can still cause normal transaction errors.
