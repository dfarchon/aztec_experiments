# Notch

Notch is an independent public message board on Aztec. Anyone can read without a wallet. Posts are public, but the board does not display an author address. Posting requires an L1 Ethereum wallet and refundable stake. The website opens a separate Aztec account in the browser; new accounts are derived from a private, domain-separated L1 wallet signature.

The website uses React, TypeScript and Vite. The header offers a theme switch and one wallet entry. The wallet dialog shows Connect, Set up, and Ready. Once the L1 stake confirms, the same flow initializes Aztec and claims the deposit. Public posts load first; wallet code loads after an L1 stake is submitted or when restoring an existing account. Proof resources prepare while L1 confirmation is pending. The feed reads ten posts at a time from a pinned block snapshot and loads older posts as the user scrolls.

## Posting and stake

1. Choose an installed Ethereum wallet, such as MetaMask or Rabby, on Sepolia. Connecting only grants access to the L1 address; it does not create an Aztec account. Manual connection requests account selection in wallets that support permissions, including MetaMask. Other wallets fall back to their standard connection prompt. Disconnecting in Notch does not revoke the extension's site permission or delete the local Aztec account. Disconnect also disables automatic reconnection. Use the same L1 address when returning to manage its stake.
2. Select 0.0005, 0.001, or 0.002 ETH, then confirm one stake action in the BillboardPortal on Sepolia. The selected button stays highlighted and can be changed until a transaction might have been submitted. Each L1 address may have at most 0.002 ETH staked. Additional stakes remain available from the Ready view and immediately raise the rolling 24-hour quota.
3. After the L1 transaction confirms, the site initializes the private Aztec account and claims the deposit. Keep the tab open during first setup. After reload, the site silently checks the last selected wallet with `eth_accounts`; it never requests approval or switches networks automatically. A completed account restores in the background, with progress on the wallet button and in its dismissible dialog. Unfinished first setup requires continuing the saved stake state; never pay again for the same pending deposit. The L1 deposit event contains a secret hash, amount and payer address, but no post or Aztec account address. Sponsored FPC pays the L2 execution fee.
4. Write and publish from the private Aztec account. Text and time are public on Aztec. A private note tracks the rolling quota and last post. The wallet dialog shows the remaining posts in the current rolling 24-hour window.
5. The Ready view shows the stake and remaining posts read from Aztec. Export the account there to take independent custody of its keys; website recovery in another browser uses the original L1 wallet signature. Withdraw the full stake after 24 hours from the last post. If no post was made, withdrawal is available immediately. The exit stays in Ready while the site checks for an Ethereum-verified proof every 30 seconds. This may take a while; the panel can be closed and the saved exit resumes after reload. Once ready, click Claim ETH and confirm the L1 wallet transaction to release the ETH from the portal. The L1 transaction pays Sepolia gas.

|   L1 stake | Maximum posts in a rolling 24 hours |
| ---------: | ----------------------------------: |
| 0.0005 ETH |                                   5 |
|  0.001 ETH |                                  10 |
| 0.0015 ETH |                                  15 |
|  0.002 ETH |                                  20 |

There is no cooldown or unused-post carryover. Each L1 address has its own deposit cap; the portal has no global custody cap. Direct contract calls still rely on clients for valid UTF-8; the contract enforces 1–512 bytes and zero padding.

The private Aztec account is derived from a wallet signature, not from the public L1 address alone. No account binding is publicly registered by this flow. L1 deposits and withdrawals are public, and network metadata or timing may allow correlation. This design has local end-to-end coverage but is not a privacy or security audit. Sponsored FPC availability must be checked separately.

## Account export

Ready offers **Export account**. Before download, the interface warns that the
file contains private keys and asks the user to confirm. The file is generated
entirely in the browser and is never uploaded or logged. It is an unencrypted,
version-2 `notch-account` JSON key package, not a Notch workflow backup.

The file contains the Aztec address; `keys.secretKey`, `keys.signingKey` and
`keys.salt`; the Schnorr initializerless account type, SDK version and account
contract class ID; and the network's L1 chain ID, rollup address and version.
It excludes the L1 payer, recovery signature, board, deposit/withdrawal records,
transaction hashes, balances and remaining quota. Anyone holding the file can
control the Aztec account independently of the website. The original L1 wallet
still controls the Ethereum address to which stake withdrawals are sent.
Exporting does not delete the website's local keys or revoke its access.

The format is documented for independent tooling; it is not a claim of universal
wallet import compatibility. With the pinned Aztec 6.0.0 SDK, an independent
client can reconstruct the address as follows:

```js
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { getSchnorrInitializerlessAccountContractAddress }
  from '@aztec-labs/accounts/schnorr';

const address = await getSchnorrInitializerlessAccountContractAddress(
  Fq.fromString(account.keys.signingKey),
  Fr.fromString(account.keys.salt),
  Fr.fromString(account.keys.secretKey),
);
if (address.toString() !== account.address) throw new Error('Account mismatch');
```

An independent wallet must also use the declared account contract class and
network, register the account with its PXE, sync private notes and provide the
initializerless Schnorr signing-key capsule. The automated export test uses the
SDK to reconstruct the same address and independently create/verify a Schnorr
signature from the exported signing key. There is no file-import feature in the
website. Product recovery uses the original L1 wallet signature.

## Wallet signature recovery

New accounts use the versioned `l1-signature-v1` recovery scheme, following the
upstream signature-as-seed design. Connecting remains a connection-only action:
it does not request a signature or initialize Aztec. On the first Stake action,
the wallet signs one fixed recovery message before any L1 payment. The message
binds the payer, L1 chain, portal, board, rollup and rollup version, but not the
website origin, so the same deployment can be recovered on another browser or
host. The signature is never sent to an RPC, logged, or included in an export.

The validated signature's `r` component seeds HMAC-SHA256 with separate purpose
labels for the account secret, salt and Schnorr signing key. Values are mapped
into the corresponding nonzero Fr/Fq fields. Per-deposit claim secrets use a
separate HMAC purpose, the account secret, the deployment scope, the L1 nonce
and amount. This provides the same recoverable-secret property as the upstream
per-deposit signature while avoiding an additional signature prompt for every
stake. These messages, labels and field mappings are identity compatibility
contracts: changes require a new scheme version. Transactions explicitly use
the nonce used to derive the claim secret; do not edit it in the wallet.

On a clean browser, connect the original L1 wallet. A read-only L1 balance check
selects the setup state without loading Aztec or requesting a signature. If a
stake or unfinished operation exists, amount choices are hidden and the only
action is **Continue setup**. Clicking it resumes the local operation or asks
for the same recovery signature when keys are absent. The app scans L1
deposit/withdrawal events in bounded block ranges, validates deposit calldata,
rebuilds claim secrets, and checks their hashes before saving a recovery plan.
It recreates the original Aztec account, syncs private notes, and checks message
nullifiers locally. Claimed deposits are skipped; unclaimed deposits continue
through the normal claim flow. Recovery never sends an L1 deposit transaction.
If Stake is clicked with an existing L1 balance but no local keys, the same
recovery flow runs instead of requesting another payment. The final L2 stake
must match the current L1 balance before the recovery guard is cleared.

A normal refresh with local keys still restores without a signature prompt.
The website has no random-account creation or legacy file-import flow. All new
accounts use this fixed signature scheme. Wallet recovery requires repeatable
EIP-191 signatures from the same Ethereum account. A wallet that changes its
signing behavior may produce another identity; deposit hash checks fail closed
in that case. The exported keys provide independent control through compatible
tooling, rather than another product recovery path. The recovery signature
itself grants control of the Aztec account; never share it.

An unconfirmed L1 transaction blocks a new stake even if local data was cleared
before a deposit event appeared. Rejected signatures, a different wallet/network,
incomplete history and in-flight claims/withdrawals never automatically trigger
another payment or clear the recovery guard. Account export is not a transaction
checkpoint backup. A withdrawal whose checkpoint was lost may require its
transaction hash to complete; this change adds no emergency L1 refund or account
migration mechanism. Neither contract is changed.

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
