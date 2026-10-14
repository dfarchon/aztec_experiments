// Deploy the minimal real DF onboarding contracts and the independent board.
// This script does not initialize a player; the browser harness does that.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { deployDFCore } from './df-core-fixture.mjs';

const url = process.env.DF_NODE_URL ?? 'http://127.0.0.1:5180';
const parsed = new URL(url);
assert(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'Only local nodes are allowed');
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Expected Anvil chain 31337');
assert.equal(info.nodeVersion, '5.0.1', 'Expected Aztec 5.0.1');
const l1 = await node.getL1ContractAddresses();
const manifestUrl = new URL('../.local/df-harness.json', import.meta.url);
const publicUrl = new URL('../apps/dist/df-local.json', import.meta.url);
const artifactUrl = new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url);
const artifactText = fs.readFileSync(artifactUrl, 'utf8');
const boardArtifactHash = createHash('sha256').update(artifactText).digest('hex');
const accounts = await getInitialTestAccountsData();
function writeBrowserAccounts() {
  const browserAccounts = accounts.slice(1).map((account, index) => ({
    label: `Local player ${index + 1}`,
    address: account.address.toString(),
    secretKey: account.secret.toString(),
    signingKey: account.signingKey.toString(),
    salt: account.salt.toString(),
  }));
  fs.writeFileSync(new URL('../apps/dist/df-local-accounts.json', import.meta.url), JSON.stringify(browserAccounts, null, 2));
}
const previous = fs.existsSync(manifestUrl) ? JSON.parse(fs.readFileSync(manifestUrl, 'utf8')) : null;
const deployed = async address => {
  try { return Boolean(await node.getContract(AztecAddress.fromStringUnsafe(address))); }
  catch { return false; }
};
const sponsoredFpc = (await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
  salt: new Fr(0n),
})).address.toString();
// The local network prefunds this deterministic address at genesis. SponsoredFPC
// has only a private function, so it need not appear in node.getContract().
const sameCore = previous && previous.rollupAddress === l1.rollupAddress.toString() &&
  previous.nodeUrl === url && await deployed(previous.core) && await deployed(previous.playerStorage);
if (sameCore && previous.boardArtifactHash === boardArtifactHash && await deployed(previous.board)) {
  previous.deploymentId ??= randomUUID();
  previous.sponsoredFpc = sponsoredFpc;
  fs.mkdirSync(new URL('../apps/dist/', import.meta.url), { recursive: true });
  fs.writeFileSync(manifestUrl, JSON.stringify(previous, null, 2));
  fs.writeFileSync(publicUrl, JSON.stringify(previous, null, 2));
  writeBrowserAccounts();
  console.log('Existing DF harness deployment reused:', previous.board);
} else {
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
  try {
    for (const account of accounts) {
      await wallet.createSchnorrInitializerlessAccount(account.secret, account.salt, account.signingKey);
    }
    const admin = accounts[0].address;
    const send = async (call, from = admin) => {
      const result = await call.send({ from });
      assert.equal(result.receipt.executionResult, 'success');
      return result;
    };
    const artifact = loadContractArtifact(JSON.parse(artifactText));
    if (sameCore) {
      const { contract: board } = await Contract.deploy(wallet, artifact, [
        AztecAddress.fromStringUnsafe(previous.playerStorage),
      ]).send({ from: admin });
      const manifest = { ...previous, deploymentId: randomUUID(), board: board.address.toString(), boardArtifactHash, sponsoredFpc };
      fs.mkdirSync(new URL('../apps/dist/', import.meta.url), { recursive: true });
      fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2));
      fs.writeFileSync(publicUrl, JSON.stringify(manifest, null, 2));
      writeBrowserAccounts();
      console.log('Updated DF board deployed; existing Core and player state preserved:', board.address.toString());
    } else {
      const { deployed, source, core, config, world } = await deployDFCore({ wallet, admin, send });
      const { contract: board } = await Contract.deploy(wallet, artifact, [source.address]).send({ from: admin });
      const manifest = {
        deploymentId: randomUUID(),
        nodeUrl: url,
        chainId: Number(info.l1ChainId),
        rollupAddress: l1.rollupAddress.toString(),
        admin: admin.toString(),
        core: core.address.toString(),
        config: config.address.toString(),
        playerStorage: source.address.toString(),
        board: board.address.toString(),
        sponsoredFpc,
        boardArtifactHash,
        worldRadius: world.radius.toString(),
        contracts: Object.fromEntries(Object.entries(deployed).map(([name, contract]) => [name, contract.address.toString()])),
      };
      fs.mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
      fs.mkdirSync(new URL('../apps/dist/', import.meta.url), { recursive: true });
      fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2));
      fs.writeFileSync(publicUrl, JSON.stringify(manifest, null, 2));
      writeBrowserAccounts();
      console.log('DF harness deployed (no player initialized):');
      console.log(JSON.stringify(manifest, null, 2));
    }
  } finally {
    await wallet.stop();
  }
}
