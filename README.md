# Notch

Notch is an independent public message board built on Aztec. Anyone can read
without a wallet. Publishing requires an Ethereum wallet, an L1 stake and a
browser-created private Aztec account. Posts and publication times are public,
but the board does not publish an author address with each post.

[Mainnet](https://onenotch.xyz/) · [Testnet](https://testnet.onenotch.xyz/) ·
[Architecture](docs/FRONTEND.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Risk notice**
>
> The contracts have not been independently audited. Mainnet stakes use real
> ETH. Contract, wallet, sponsor or network failures may delay or prevent
> withdrawal. Stake only what you can afford to lose.

## Status

| Network | L1 | L2 | Funds | L2 fees |
| --- | --- | --- | --- | --- |
| Mainnet | Ethereum Mainnet | Aztec Mainnet | Real ETH | Maintained Sponsored FPC |
| Testnet | Ethereum Sepolia | Aztec public testnet | Test ETH | Testnet Sponsored FPC |

L2 fees are currently sponsored, subject to sponsor availability. Ethereum
staking and withdrawal claims always require L1 gas.

## How it works

1. Connect an Ethereum wallet and stake ETH in the Notch portal.
2. The browser derives one Aztec account from a versioned Ethereum signature.
3. The stake is claimed privately on Aztec and sets a rolling posting allowance.
4. Posts are published through Aztec with no public author address attached.
5. The stake becomes eligible for withdrawal 24 hours after the last post, or
   immediately when no post was made. Withdrawal requires an Aztec exit proof
   and a separate Ethereum claim.

| Stake | Maximum posts in a rolling 24 hours |
| ---: | ---: |
| 0.0005 ETH | 5 |
| 0.001 ETH | 10 |
| 0.0015 ETH | 15 |
| 0.002 ETH | 20 |

Each Aztec account has one `PrivateMutable<AccountState>` containing the total
stake, L1 depositor, last-post time and rolling history. A top-up replaces that
state without clearing its history or withdrawal wait. Withdrawal sets the
stake amount to zero while retaining the state chain.

## Accounts and recovery

The private Aztec account is derived from a domain-separated EIP-191 signature
from the original Ethereum wallet. The signature is not sent to an RPC and is
not included in the exported key package. Wallets must produce repeatable
signatures for the same account and deployment.

The Ready view can export an unencrypted Aztec account key package for
independent custody. **The website does not import this file.** Normal recovery
in another browser uses the original Ethereum wallet signature. Anyone holding
the export can control the Aztec account, while the original L1 wallet still
controls the address that receives stake withdrawals.

The version-2 `notch-account` package contains the Aztec address, secret key,
Schnorr signing key, salt, account contract class and SDK version, plus the L1
chain ID, Rollup address and Rollup version. It excludes the L1 payer, board,
recovery signature, transactions, balances and pending operation checkpoints.
Independent tooling must use the declared Schnorr initializerless account class,
register the account with a PXE, sync notes and provide the signing-key capsule.
The package is not a universal wallet-import format.

The browser keeps pending deposit and withdrawal checkpoints locally. Preserve
that browser data until all transactions are complete. A withdrawal completed
on Aztec but not yet claimed on L1 requires its saved exit checkpoint; it is not
automatically reconstructed from L2 history. There is no emergency L1 refund,
account migration or server-held recovery key.

## Privacy boundaries

Posts and timestamps are public on Aztec. The contract stores post content and
timestamps in public storage, while stake and posting history remain private
notes. L1 deposits and withdrawals are public, and timing, amounts, RPC metadata
or wallet behavior may allow activity to be correlated. Notch does not claim
guaranteed anonymity.

## Deployments

Public deployment manifests are pinned in:

- [`deployments/mainnet.json`](deployments/mainnet.json)
- [`deployments/testnet.json`](deployments/testnet.json)

The current mainnet contracts are:

| Contract | Ethereum / Aztec mainnet |
| --- | --- |
| L1 portal | `0x472B1dC69736C9B6034CE7aAbBa1ff5f7f16307a` |
| Aztec board | `0x090065f980667a9f5273c8b7e7ff31d234c375bfc172539f43d2c91284717c78` |

Each hosted release includes a fixed deployment manifest. The manifest is
verified against the selected chain, Rollup, portal binding and contract class.
Changing a hostname alone cannot change the application's network.

## Project layout

| Path | Purpose |
| --- | --- |
| [`df-billboard/`](df-billboard/) | Aztec board, L1 stake portal and native contract tests |
| [`web/`](web/) | React, TypeScript and Vite website |
| [`protocol/`](protocol/) | Post encoding, network policy and sponsored-fee helpers |
| [`runtime/`](runtime/) | Lazy SDK, browser wallet/PXE runtime and Noir runtime |
| [`scripts/`](scripts/) | Build, local chain, and public network release scripts |
| [`deployments/`](deployments/) | Public configuration for deployed contracts |
| [`tests/`](tests/) | JavaScript tests grouped by feature, runtime, protocol and tooling |
| [`docs/`](docs/) | Architecture and deployment guides |

## Local development

Use Node `24.22.1` (`nvm use` with nvm), then install dependencies once:

```sh
npm ci
```

Run the React source against either existing public deployment:

```sh
npm run dev:mainnet
# Or:
npm run dev:testnet
```

Open `http://127.0.0.1:5001/`. Both commands build the browser SDK, prepare
public contract assets and start Vite with hot reload. They need no Aztec CLI,
local node, deployer key or contract compilation. Mainnet actions use real ETH;
testnet actions use Sepolia test ETH. The port must be free, or select another
with `npm run dev:testnet -- --port 5002`.

The commands read `deployments/mainnet.json` and `deployments/testnet.json`,
respectively, and keep generated files in separate `.local/frontend/` folders.
To use a different RPC, edit `nodeUrl` in the corresponding manifest and restart.
The RPC must support that deployment's network and browser CORS. Configuration
is public; do not embed private credentials. For mainnet release builds, keep
`scripts/mainnet/config.json` in sync as well.

For local contract development only, also install Aztec `6.0.0` and run:

```sh
npm run build:runtime
npm run build:contracts
npm run dev:local
```

See [the deployment guide](docs/DEPLOYMENT.md) for release builds and contract
deployments. Public network development does not deploy or modify contracts.

## Checks

```sh
npm run format:check
npm run typecheck
npm run test:unit
npm run test:message
npm run test:contracts
npm run test:deployment
npm run test:release
```

Tests and local integration runs do not replace an independent security audit or
a final real-wallet acceptance run on each target network.

## Documentation

- [Frontend architecture](docs/FRONTEND.md): pages, state ownership, persistence,
  wallet runtime and transaction code paths.
- [Deployment](docs/DEPLOYMENT.md): network pins, private journals, release
  builds and hosted domains.
- [Contributing](CONTRIBUTING.md): environment, change scope, tests and commits.
- [Security](SECURITY.md): vulnerability reporting and operational boundaries.
