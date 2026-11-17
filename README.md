# DFArchon Billboard

A standalone public message board on Aztec. Anyone can read without a wallet.
Posting supports an Aztec wallet or MetaMask. MetaMask users pay Sepolia L1 gas
per post; Sponsored FPC covers L2 execution. Both paths publish to the same
Aztec board. The site shows public posts without a Settings page or local
content filters.

[Public testnet site](https://df-billboard-testnet.netlify.app/) · [Product design and usage](df-billboard/README.md) · [Deployment guide](df-billboard/DEPLOYMENT.md)

## Project layout

| Path | Purpose |
| --- | --- |
| [`df-billboard/`](df-billboard/) | Current Aztec contract, L1 request contract, tests, and deployment notes |
| [`apps/src/df-billboard/`](apps/src/df-billboard/) | Current React and TypeScript website |
| [`scripts/`](scripts/) | Build, test, local chain, and testnet release scripts |
| [`billboard/`](billboard/) | Earlier deposit-and-censor experiment; not used by the current website |
| [`LEGACY_BILLBOARD.md`](LEGACY_BILLBOARD.md) | Archived explanation of that earlier experiment |

The old `/df-billboard-test.html` URL redirects to `/` for existing links. The
`testnet` in the hosted domain identifies the public test network. The React
source directory is the product, not a separate test page.

## Local development

Use Node `24.22.1` and Aztec `6.0.0`. From the repository root:

```sh
npm ci
npm run build:sdk
npm run build:df
npm run build:df:l1
npm run start:local:df # terminal 1
npm run deploy:df:harness # terminal 2
npm run dev:df:site
```

Open `http://127.0.0.1:5001/`. For public testnet configuration and release
packaging, follow the [deployment guide](df-billboard/DEPLOYMENT.md). Local
commands do not deploy to public networks.

## Checks

```sh
npm run format:check:df:site
npm run typecheck:df:site
npm run test:df:ui
npm run test:df:moderation
npm run test:df
npm run test:df:l1
```

See the [product README](df-billboard/README.md) for contract behavior, posting
paths, privacy limits, and test coverage.
