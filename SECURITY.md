# Security Policy

## Project Status

The Notch contracts and frontend have not been independently audited. Mainnet
stakes use real ETH and may be delayed or inaccessible if a contract, wallet,
sponsor or network dependency fails.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Report security issues privately through:

https://github.com/dfarchon/aztec_experiments/security/advisories/new

Include:

- the affected contract, frontend flow or deployment;
- the network and commit or release;
- reproduction steps or a proof of concept;
- expected impact;
- whether funds or user keys may be at risk.

Do not include private keys, recovery files, signed deployment transactions or
real user data in a report.

## In Scope

- `df-billboard/portal`: L1 deposits, withdrawal proofs and refunds.
- `df-billboard/contract`: Aztec stake, posting and withdrawal state.
- Browser account derivation, recovery and persistence.
- Contract-to-frontend network and artifact verification.
- Release scripts that could expose secrets or mix networks.

## Out of Scope

- Vulnerabilities in Aztec, Ethereum, wallets or public RPC providers without a
  Notch-specific impact.
- Spam or abuse that only requires a valid paid posting action.
- Issues that require a compromised wallet, private key or modified browser.
- Reports produced only against local mocks without a plausible production path.

## Testing Guidance

Do not test with other users' funds or real mainnet assets. Use local chains or
small testnet amounts. Never ask for or submit a private key.

Response and remediation are best effort. Please allow time for investigation
before public disclosure.
