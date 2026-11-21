# Contributing

Notch is a React, TypeScript, Aztec and Solidity project. Keep changes aligned
with the existing feature boundaries and verify the behavior they affect.

## Requirements

- Node.js `24.22.1`
- Aztec `6.0.0` only for contract compilation or local chain development
- npm

The Aztec toolchain is available through `scripts/with-toolchain.sh` when
installed in `.local/toolchains/6.0.0` or the configured Aztec installation.

## Setup

```sh
npm ci
npm run dev:testnet
# Or connect the source frontend to mainnet:
npm run dev:mainnet
```

The local site runs at `http://127.0.0.1:5001/`. These commands prepare the SDK
and use the versioned public manifests and artifact; no local chain or Aztec CLI
is needed. Mainnet transactions use real ETH. See [Local development](README.md#local-development)
for RPC configuration and the separate local-contract workflow.

## Change Scope

- Keep page composition in `web/src/app/`.
- Keep feed behavior in `web/src/features/feed/`.
- Keep wallet UI, persistence and transaction sequencing in
  `web/src/features/wallet/`.
- Keep public reads independent from wallet and proof code.
- Keep contract changes isolated to `df-billboard/` and add native tests.
- Do not add a state-management framework or a second application store.
- Do not commit private keys, deployment journals, browser recovery data or
  populated `.local/` files.

Read [docs/FRONTEND.md](docs/FRONTEND.md) before changing wallet or page
ownership. Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) before changing network
configuration or release tooling.

## Verification

Run checks appropriate to the change:

```sh
npm run format:check
npm run typecheck
npm run test:unit
npm run test:message
npm run test:deployment
npm run test:release
```

Contract changes also require:

```sh
npm run test:contracts
```

Local end-to-end coverage requires a local deployment:

```sh
npm run test:e2e
```

Tests do not replace a real-wallet check on the target network or an independent
security audit.

## Commits

Use Conventional Commit subjects such as:

```text
feat(wallet): add a scoped behavior
fix(contracts): correct an invariant
docs: clarify deployment
```

Keep commits scoped to one purpose. Do not include unrelated generated files,
local release output or user data.

## Pull Requests

Before opening a pull request:

- Confirm links point to existing files.
- Run formatting, type checking and relevant tests.
- Explain user-visible behavior and compatibility impact.
- Call out contract, storage, account derivation and deployment changes.
- Report simulated tests separately from real testnet or mainnet verification.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
