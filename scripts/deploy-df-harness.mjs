// Local-only standalone billboard deployment. No DF contracts or player setup.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Contract as EvmContract, ContractFactory, JsonRpcProvider, keccak256 } from 'ethers';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { Contract, getContractInstanceFromInstantiationParams, getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { getBillboardFeeOptions } from '../shared/df-billboard.mjs';

const url = process.env.DF_NODE_URL ?? 'http://127.0.0.1:5180';
assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Only local nodes are allowed');
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Expected Anvil chain 31337');
assert.equal(info.nodeVersion, '6.0.0', 'Expected Aztec 6.0.0');
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
const l1RpcUrl = process.env.DF_L1_RPC_URL ?? 'http://127.0.0.1:5954';
assert(['127.0.0.1', 'localhost'].includes(new URL(l1RpcUrl).hostname), 'Only local L1 RPCs are allowed');
const l1Provider = new JsonRpcProvider(l1RpcUrl, undefined, {
  cacheTimeout: -1,
});
try {
  assert.equal((await l1Provider.getNetwork()).chainId, 31337n);
  assert.notEqual(await l1Provider.getCode(l1.rollupAddress.toString()), '0x', 'L1 RPC does not host this rollup');
  let portalAddress;
  let portalCodeHash;
  if (previous?.kind === 'notch-stake' && previous?.rollupAddress === l1.rollupAddress.toString() && previous.l1Stake?.rpcUrl === l1RpcUrl) {
    const code = await l1Provider.getCode(previous.l1Stake.portal);
    if (code !== '0x' && keccak256(code) === previous.l1Stake.runtimeCodeHash) {
      portalAddress = previous.l1Stake.portal;
      portalCodeHash = previous.l1Stake.runtimeCodeHash;
    }
  }
  const portalArtifact = JSON.parse(
      fs.readFileSync(new URL('../.local/billboard-l1-out/BillboardPortal.sol/BillboardPortal.json', import.meta.url)),
    );
  if (!portalAddress) {
    const portal = await new ContractFactory(portalArtifact.abi, portalArtifact.bytecode.object, await l1Provider.getSigner(0)).deploy(
      l1.rollupAddress.toString(),
      info.rollupVersion,
    );
    await portal.waitForDeployment();
    portalAddress = await portal.getAddress();
    portalCodeHash = keccak256(await l1Provider.getCode(portalAddress));
  }
  let boardAddress;
  if (
    previous?.kind === 'notch-stake' &&
    previous.nodeUrl === url &&
    previous.rollupAddress === l1.rollupAddress.toString() &&
    previous.boardArtifactHash === boardArtifactHash &&
    previous.l1Stake?.portal === portalAddress
  ) {
    const instance = await node.getContract(AztecAddress.fromStringUnsafe(previous.board));
    if (
      instance?.currentContractClassId.equals(boardClass.id) &&
      (await node.getPublicStorageAt('latest', instance.address, artifact.storageLayout.l1_portal.slot)).toBigInt() === BigInt(portalAddress)
    )
      boardAddress = instance.address.toString();
  }
  let deploymentTx;
  if (!boardAddress) {
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxeConfig: { proverEnabled: false },
    });
    try {
      await wallet.createSchnorrInitializerlessAccount(accounts[0].secret, accounts[0].salt, accounts[0].signingKey);
      await wallet.registerContract(sponsorInstance, SponsoredFPCContract.artifact);
      const result = await Contract.deploy(wallet, artifact, [EthAddress.fromString(portalAddress)], 'constructor_with_portal').send({
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
  const portal = new EvmContract(portalAddress, portalArtifact.abi, await l1Provider.getSigner(0));
  const boundBoard = await portal.board();
  if (boundBoard === '0x' + '0'.repeat(64)) {
    const bind = await portal.bindBoard(boardAddress);
    await bind.wait();
  } else {
    assert.equal(boundBoard.toLowerCase(), boardAddress.toLowerCase(), 'Portal is bound to another board');
  }
  const manifest = {
    kind: 'notch-stake',
    schemaVersion: 2,
    nodeUrl: url,
    chainId: Number(info.l1ChainId),
    rollupVersion: info.rollupVersion.toString(),
    rollupAddress: l1.rollupAddress.toString(),
    board: boardAddress,
    sponsoredFpc,
    sponsorSalt: '0',
    boardArtifactHash,
    boardClassId: boardClass.id.toString(),
    l1Stake: {
      chainId: 31337,
      rpcUrl: l1RpcUrl,
      portal: portalAddress,
      inbox: l1.inboxAddress.toString(),
      runtimeCodeHash: portalCodeHash,
      deploymentBlock: 0,
    },
  };
  fs.mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  fs.mkdirSync(new URL('../apps/dist/', import.meta.url), { recursive: true });
  fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(publicUrl, JSON.stringify(manifest, null, 2) + '\n');
  console.log(deploymentTx ? 'Standalone billboard deployed:' : 'Existing standalone billboard reused:');
  console.log(JSON.stringify({ ...manifest, deploymentTx, sponsorBalance: sponsorBalance.toString() }, null, 2));
} finally {
  l1Provider.destroy();
}
