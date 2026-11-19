# Notch

Notch is a public message board on Aztec. Anyone can read without a wallet. Posts are public, but the board does not display an author address. Posting requires an L1 Ethereum wallet and refundable stake. The website opens a separate Aztec account in the browser; its secret is generated independently of the L1 wallet.

The website uses React, TypeScript and Vite. The header offers a theme switch and one wallet entry. The wallet dialog has three steps: connect, stake, post. Public posts load first; wallet code loads only when needed. The feed reads ten posts at a time from a pinned block snapshot and loads older posts as the user scrolls.

## Posting and stake

1. Choose an installed Ethereum wallet, such as MetaMask or Rabby, on Sepolia, then choose a stake amount. A previously authorized wallet may connect without another permission prompt. Use the same L1 address when returning to manage its stake.
2. Download the recovery backup before confirming the L1 transaction. Keep it private: losing both the backup and browser storage can make the stake unrecoverable. Deposit in 0.0005 ETH increments to the BillboardPortal on Sepolia. Each L1 address may have at most 0.002 ETH staked. Top-ups immediately raise the rolling 24-hour quota.
3. The browser privately claims each L1 deposit on Aztec. The L1 deposit event contains a secret hash, amount and payer address, but no post or Aztec account address. Sponsored FPC pays the L2 execution fee.
4. Write and publish from the private Aztec account. Text and time are public on Aztec. A private note tracks the rolling quota and last post.
5. Withdraw the full stake after 24 hours from the last post. If no post was made, withdrawal is available immediately. An Aztec exit proof releases the ETH from the L1 portal; the L1 withdrawal transaction pays Sepolia gas.

| L1 stake | Maximum posts in a rolling 24 hours |
| ---: | ---: |
| 0.0005 ETH | 5 |
| 0.001 ETH | 10 |
| 0.0015 ETH | 15 |
| 0.002 ETH | 20 |

There is no cooldown or unused-post carryover. Each L1 address has its own deposit cap; the portal has no global custody cap. The board does not require Dark Forest player status. Direct contract calls still rely on clients for valid UTF-8; the contract enforces 1–512 bytes and zero padding.

The private Aztec account is not cryptographically derived from or publicly registered to the L1 address. L1 deposits and withdrawals are public, and network metadata or timing may allow correlation. This design has local end-to-end coverage but is not a privacy or security audit. Sponsored FPC availability must be checked separately.

## Recovery

The wallet dialog keeps a pending deposit or withdrawal visible. A backup includes the private account key and any pending operation. Before paying on L1, download the latest backup. After a timeout, resume the saved operation and verify its receipt instead of making another deposit. If a wallet or RPC loses a transaction response, enter the existing transaction hash. Switching L1 wallets does not merge their stake or private accounts.

## Development

Use Node 24.22.1 and Aztec 6.0.0 from the repository root:

```sh
npm ci
npm run build:sdk
npm run build:df
npm run build:df:l1
npm run start:local:df # terminal 1
npm run deploy:df:harness # terminal 2
npm run dev:df:site
```

Open http://127.0.0.1:5001/. Local Anvil ETH is only for testing. The site reads `/df-local.json`, which must describe the matching board, stake portal, Inbox, Sponsored FPC and chain. A public release uses real proofs and HTTPS Aztec and Sepolia RPCs. [Deployment and recovery instructions](DEPLOYMENT.md) cover the public testnet.

```sh
npm run format:check:df:site
npm run typecheck:df:site
npm run test:df:ui
npm run test:df:message
npm run test:df
npm run test:df:l1
npm run test:df:e2e # requires the local chains and deployment
```

Noir tests cover stake claims, top-ups, quota boundaries, withdrawal timing and post validation. Solidity tests cover binding, stake caps and proof-based refunds. The local end-to-end test stakes, claims, posts, increases quota and withdraws. Browser and public testnet verification remain necessary before a wider release.
