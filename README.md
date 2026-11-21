# Notch

Notch is an independent public message board on Aztec. Each post leaves a mark
without displaying its author's address. Anyone can read without a wallet.
Posting uses an installed Ethereum wallet for refundable L1 stake. Each 0.0005 ETH unlocks five
posts in a rolling 24 hours, up to 20 posts at 0.002 ETH. A browser-created
Aztec account publishes privately; Sponsored FPC covers L2 execution. New accounts
can be recovered with a signature from the same Ethereum wallet, including their
existing stake and remaining quota, without another L1 deposit. Setup uses one
Continue setup action for existing stakes and unfinished operations. Ready can
export the Aztec account keys for independent custody; the site has no file import. The site shows public posts without a Settings page or local
content filters.

[Website](https://onenotch.xyz/) · [Mainnet deployment](df-billboard/MAINNET.md) · [Frontend guide](docs/FRONTEND.md) · [Product design and usage](df-billboard/README.md) · [Testnet deployment](df-billboard/DEPLOYMENT.md)

The deployed mainnet contracts and maintained FPC are pinned in
[`deployments/mainnet.json`](deployments/mainnet.json). `npm run build:mainnet`
builds the matching frontend into `.local/releases/notch-mainnet/public` without
reading deployment keys or a private journal. Building does not publish the site.

The information icon in the header opens `/about`,
which explains the project's origins, staking model and privacy limits.
About can be read without connecting a wallet or loading the wallet runtime.
The logo and the About page's back link return to the board. The wallet entry
remains available on both pages.

## Project layout

| Path | Purpose |
| --- | --- |
| [`df-billboard/`](df-billboard/) | Current Aztec board, L1 stake portal, tests, and deployment notes |
| [`web/`](web/) | React, TypeScript and Vite website |
| [`protocol/`](protocol/) | Current post encoding and sponsored-fee helpers |
| [`runtime/`](runtime/) | Lazy SDK, browser wallet/PXE runtime and Noir runtime |
| [`scripts/`](scripts/) | Build, local chain, and public network release scripts |
| [`deployments/`](deployments/) | Public configuration for deployed contracts |
| [`tests/`](tests/) | JavaScript tests grouped by feature, runtime, protocol and tooling |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Frontend ownership, persistence and code reading paths |

The old `/df-billboard-test.html` URL redirects to `/` for existing links. The
published deployment manifest selects the network; the hostname does not.
`web/` contains the product website.

## Local development

Use Node `24.22.1` and Aztec `6.0.0`. From the repository root:

```sh
npm ci
npm run build:runtime
npm run build:contracts
npm run dev:local
```

Open `http://127.0.0.1:5001/`. For public testnet configuration and release
packaging, follow the [deployment guide](df-billboard/DEPLOYMENT.md). Local
commands do not deploy to public networks.

## Checks

```sh
npm run format:check
npm run typecheck
npm run test:unit
npm run test:message
npm run test:deployment
npm run test:release
```

`npm run dev` serves an already prepared local manifest. `npm run dev:local`
builds the contracts, starts or reuses a local chain, deploys the board and runs
the website. See the [frontend guide](docs/FRONTEND.md) for page, wallet,
persistence and transaction code paths. See the [product README](df-billboard/README.md)
for contract behavior, privacy limits, and test coverage.
