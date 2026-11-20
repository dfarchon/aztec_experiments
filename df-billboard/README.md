# Notch

Notch is an independent public message board on Aztec. Anyone can read without a wallet. Posts are public, but the board does not display an author address. Posting requires an L1 Ethereum wallet and refundable stake. The website opens a separate Aztec account in the browser; its secret is generated independently of the L1 wallet.

The website uses React, TypeScript and Vite. The header offers a theme switch and one wallet entry. The wallet dialog shows Connect, Set up, and Ready. Once the L1 stake confirms, the same flow initializes Aztec and claims the deposit. Public posts load first; wallet code loads after an L1 stake is submitted or when restoring an existing account. Proof resources prepare while L1 confirmation is pending. The feed reads ten posts at a time from a pinned block snapshot and loads older posts as the user scrolls.

## Posting and stake

1. Choose an installed Ethereum wallet, such as MetaMask or Rabby, on Sepolia. Connecting only grants access to the L1 address; it does not create an Aztec account. Manual connection requests account selection in wallets that support permissions, including MetaMask. Other wallets fall back to their standard connection prompt. Disconnecting in Notch does not revoke the extension's site permission or delete the local Aztec account. Disconnect also disables automatic reconnection. Use the same L1 address when returning to manage its stake.
2. Select 0.0005, 0.001, or 0.002 ETH, then confirm one stake action in the BillboardPortal on Sepolia. The selected button stays highlighted and can be changed until a transaction might have been submitted. Each L1 address may have at most 0.002 ETH staked. Additional stakes remain available from the Ready view and immediately raise the rolling 24-hour quota.
3. After the L1 transaction confirms, the site initializes the private Aztec account and claims the deposit. Keep the tab open during first setup. After reload, the site silently checks the last selected wallet with `eth_accounts`; it never requests approval or switches networks automatically. A completed account restores in the background, with progress on the wallet button and in its dismissible dialog. Unfinished first setup requires continuing the saved stake state; never pay again for the same pending deposit. The L1 deposit event contains a secret hash, amount and payer address, but no post or Aztec account address. Sponsored FPC pays the L2 execution fee.
4. Write and publish from the private Aztec account. Text and time are public on Aztec. A private note tracks the rolling quota and last post. The wallet dialog shows the remaining posts in the current rolling 24-hour window.
5. The Ready view shows the stake and remaining posts read from Aztec. Export the account there if you want to recover it in another browser. Withdraw the full stake after 24 hours from the last post. If no post was made, withdrawal is available immediately. An Aztec exit proof releases the ETH from the L1 portal; the L1 withdrawal transaction pays Sepolia gas.

|   L1 stake | Maximum posts in a rolling 24 hours |
| ---------: | ----------------------------------: |
| 0.0005 ETH |                                   5 |
|  0.001 ETH |                                  10 |
| 0.0015 ETH |                                  15 |
|  0.002 ETH |                                  20 |

There is no cooldown or unused-post carryover. Each L1 address has its own deposit cap; the portal has no global custody cap. Direct contract calls still rely on clients for valid UTF-8; the contract enforces 1–512 bytes and zero padding.

The private Aztec account is not cryptographically derived from or publicly registered to the L1 address. L1 deposits and withdrawals are public, and network metadata or timing may allow correlation. This design has local end-to-end coverage but is not a privacy or security audit. Sponsored FPC availability must be checked separately.

## Account export and import

Ready exports a versioned JSON account file containing the three key materials required to recreate the browser-created Aztec account. The file is sensitive and is created entirely in the browser; it is not uploaded or logged. It contains network and board identity plus hints, but stake and quota are always re-read from the chain.

To recover on a clean browser, connect the same L1 wallet, choose **Already have an account? Import it** from the Stake view, and import the Ready export. The site validates the file, network, payer, and derived Aztec address, initializes the account in a fresh PXE, syncs historical private notes, and restores the original stake and remaining quota without another L1 payment. A mismatched wallet, network, board, malformed file, or missing private note fails without replacing a working local account or preparing a stake.

The Stake view does not offer a pre-Ready download. If the browser's local data is permanently lost after L1 payment but before the account reaches Ready, the pending deposit secret cannot be recovered. A normal reload in the same browser still resumes the saved pending state; a closed tab does not continue processing in the background. Pending L1 transactions are checked by their saved hash or deposit event and never trigger a second payment automatically.

## Development

Use Node 24.22.1 and Aztec 6.0.0 from the repository root:

```sh
npm ci
npm run build:runtime
npm run build:contracts
npm run dev:local
```

Open http://127.0.0.1:5001/. Local Anvil ETH is only for testing. The site reads `/df-local.json`, which must describe the matching board, stake portal, Inbox, Sponsored FPC and chain. A public release uses real proofs and HTTPS Aztec and Sepolia RPCs. [Deployment and recovery instructions](DEPLOYMENT.md) cover the public testnet. [The frontend guide](../docs/FRONTEND.md) maps pages, wallet state, persistence and transaction code.

```sh
npm run format:check
npm run typecheck
npm run test:unit
npm run test:message
npm run test:contracts
npm run test:e2e # requires the local chains and deployment
```

Noir tests cover stake claims, top-ups, quota boundaries, withdrawal timing and post validation. Solidity tests cover binding, stake caps and proof-based refunds. The local end-to-end test stakes, claims, posts, increases quota and withdraws. Browser and public testnet verification remain necessary before a wider release.
