// Local-only standalone billboard deployment. No DF contracts or player setup.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Contract, getContractInstanceFromInstantiationParams, getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { GasFees } from '@aztec/stdlib/gas';
import { getBillboardFeeOptions } from '../shared/df-billboard.mjs';

const url = process.env.DF_NODE_URL ?? 'http://127.0.0.1:5180';
assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Only local nodes are allowed');
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Expected Anvil chain 31337');
assert.equal(info.nodeVersion, '5.0.1', 'Expected Aztec 5.0.1');
assert.equal(info.realProofs, false, 'Expected synthetic-proof local network');
const l1 = await node.getL1ContractAddresses();
const manifestUrl = new URL('../.local/billboard-harness.json', import.meta.url);
const publicUrl = new URL('../apps/dist/df-local.json', import.meta.url);
const artifactText = fs.readFileSync(new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url), 'utf8');
const artifact = loadContractArtifact(JSON.parse(artifactText));
const boardArtifactHash = createHash('sha256').update(artifactText).digest('hex');
const boardClass = await getContractClassFromArtifact(artifact);
const sponsorInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
const sponsoredFpc = sponsorInstance.address.toString();
const sponsorBalance = await getFeeJuiceBalance(sponsorInstance.address, node);
assert(sponsorBalance > 0n, 'Sponsored FPC is empty; fund the local sponsor before deploying');
const accounts = await getInitialTestAccountsData();
const deployer = accounts[0].address;
const previous = fs.existsSync(manifestUrl) ? JSON.parse(fs.readFileSync(manifestUrl, 'utf8')) : null;
let boardAddress;
if (previous?.kind === 'standalone-billboard' && previous.nodeUrl === url &&
    previous.rollupAddress === l1.rollupAddress.toString() && previous.boardArtifactHash === boardArtifactHash) {
  const instance = await node.getContract(AztecAddress.fromStringUnsafe(previous.board));
  if (instance?.currentContractClassId.equals(boardClass.id)) boardAddress = instance.address.toString();
}
let deploymentTx;
if (!boardAddress) {
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
  try {
    await wallet.createSchnorrInitializerlessAccount(accounts[0].secret, accounts[0].salt, accounts[0].signingKey);
    await wallet.registerContract(sponsorInstance, SponsoredFPCContract.artifact);
    const result = await Contract.deploy(wallet, artifact, []).send({
      from: deployer,
      fee: await getBillboardFeeOptions(node, new SponsoredFeePaymentMethod(sponsorInstance.address), GasFees),
    });
    assert.equal(result.receipt.executionResult, 'success');
    boardAddress = result.contract.address.toString();
    deploymentTx = result.receipt.txHash.toString();
  } finally {
    await wallet.stop();
  }
}
const manifest = {
  kind: 'standalone-billboard',
  schemaVersion: 1,
  nodeUrl: url,
  chainId: Number(info.l1ChainId),
  rollupVersion: info.rollupVersion.toString(),
  rollupAddress: l1.rollupAddress.toString(),
  board: boardAddress,
  sponsoredFpc,
  sponsorSalt: '0',
  boardArtifactHash,
  boardClassId: boardClass.id.toString(),
};
fs.mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
fs.mkdirSync(new URL('../apps/dist/', import.meta.url), { recursive: true });
fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(publicUrl, JSON.stringify(manifest, null, 2) + '\n');
// Public, deterministic local test keys only; the guards above forbid remote use.
fs.writeFileSync(new URL('../apps/dist/df-local-accounts.json', import.meta.url), JSON.stringify(
  accounts.slice(1).map((account, index) => ({
    label: `Local account ${index + 1}`,
    address: account.address.toString(),
    secretKey: account.secret.toString(),
    signingKey: account.signingKey.toString(),
    salt: account.salt.toString(),
  })), null, 2) + '\n');
console.log(deploymentTx ? 'Standalone billboard deployed:' : 'Existing standalone billboard reused:');
console.log(JSON.stringify({ ...manifest, deploymentTx, sponsorBalance: sponsorBalance.toString() }, null, 2));
