// Read-only compatibility check. Never creates accounts or sends transactions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';

const version = fs.readFileSync(new URL('../.aztec-version', import.meta.url), 'utf8').trim();
const url = process.env.AZTEC_TESTNET_URL ?? 'https://aztec-testnet.drpc.org';
assert.equal(new URL(url).protocol, 'https:', 'Public testnet requires HTTPS');
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
assert.equal(info.nodeVersion, version, 'Testnet version changed: review compatibility before deploying');
assert.equal(info.l1ChainId, 11155111, 'Expected Ethereum Sepolia');
assert.equal(info.realProofs, true, 'Public testnet must verify real proofs');
const artifact = loadContractArtifact(JSON.parse(fs.readFileSync(
  new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url), 'utf8')));
const contractClass = await getContractClassFromArtifact(artifact);
const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: Fr.ZERO });
const sponsorBalance = await getFeeJuiceBalance(sponsor.address, node);
console.log(JSON.stringify({
  compatible: true,
  nodeUrl: url,
  nodeVersion: info.nodeVersion,
  l1ChainId: info.l1ChainId,
  rollupVersion: info.rollupVersion,
  realProofs: info.realProofs,
  contracts: info.l1ContractAddresses,
  compiledBoardClassId: contractClass.id.toString(),
  canonicalSponsoredFpc: sponsor.address.toString(),
  sponsorFeeJuiceBalance: sponsorBalance.toString(),
  deployment: 'Not deployed by this check. Sponsor balance does not guarantee sponsorship permission.',
}, null, 2));
