import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract as EvmContract, ContractFactory, JsonRpcProvider, Wallet, Transaction, getCreateAddress, keccak256 } from 'ethers';
import { createAztecNodeClient, waitForTx } from '@aztec-labs/aztec.js/node';
import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { Contract, getContractInstanceFromInstantiationParams, getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { Tx, TxHash } from '@aztec-labs/aztec.js/tx';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { getBillboardFeeOptions } from '../../shared/df-billboard.mjs';
import { checkNetwork, digest, publicRpc, readPrivateJson } from './state.mjs';

const root = new URL('../../', import.meta.url);
const boardFile = new URL('df-billboard/target/df_billboard-DFBillboard.json', root);
const inboxFile = new URL('.local/billboard-l1-out/BillboardInbox.sol/BillboardInbox.json', root);

export async function connect(config) {
  publicRpc(config.nodeUrl);
  publicRpc(config.l1RpcUrl);
  assert.equal(config.nodeVersion, fs.readFileSync(new URL('.aztec-version', root), 'utf8').trim());
  assert.equal(JSON.parse(fs.readFileSync(new URL('node_modules/@aztec-labs/aztec.js/package.json', root))).version, config.nodeVersion);
  const node = createAztecNodeClient(config.nodeUrl);
  const provider = new JsonRpcProvider(config.l1RpcUrl, undefined, { cacheTimeout: -1 });
  try {
    const [info, network] = await Promise.all([node.getNodeInfo(), provider.getNetwork()]);
    checkNetwork(config, info, network.chainId);
    assert.notEqual(await provider.getCode(config.rollupAddress), '0x', 'Rollup is missing on L1');
    const rollup = new EvmContract(config.rollupAddress, ['function getInbox() view returns (address)'], provider);
    assert.equal((await rollup.getInbox()).toLowerCase(), config.inboxAddress.toLowerCase());
    const text = fs.readFileSync(boardFile);
    const artifact = loadContractArtifact(JSON.parse(text));
    const inboxText = fs.readFileSync(inboxFile);
    const inbox = JSON.parse(inboxText);
    const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: Fr.ZERO });
    const deployedSponsor = await node.getContract(sponsor.address);
    assert.equal(deployedSponsor?.currentContractClassId.toString(), sponsor.currentContractClassId.toString(), 'Canonical Sponsored FPC is missing or its class changed');
    const sponsorBalance = await getFeeJuiceBalance(sponsor.address, node);
    const binding = {
      config, boardArtifactHash: digest(text), boardClassId: (await getContractClassFromArtifact(artifact)).id.toString(),
      inboxArtifactHash: digest(inboxText), sponsoredFpc: sponsor.address.toString(),
    };
    return { node, provider, artifact, inbox, sponsor, sponsorBalance, binding, close: () => provider.destroy() };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

export function adapters(context, journal, keyFile, createWallet = (node, options) => EmbeddedWallet.create(node, options)) {
  const { node, provider, artifact, inbox, sponsor, binding } = context;
  const config = binding.config;
  const l1 = {
    async prepare() {
      assert(keyFile, 'First L1 deployment needs --key-file (private JSON with l1PrivateKey; mode 600)');
      let signer;
      const credentials = readPrivateJson(keyFile);
      try {
        assert.match(credentials.l1PrivateKey, /^0x[0-9a-fA-F]{64}$/);
        signer = new Wallet(credentials.l1PrivateKey, provider);
      } catch { throw new Error('Invalid l1PrivateKey in the private key file; value omitted'); }
      const factory = new ContractFactory(inbox.abi, inbox.bytecode.object, signer);
      const request = await signer.populateTransaction(await factory.getDeployTransaction(config.rollupAddress, config.rollupVersion));
      assert.equal(request.chainId, 11155111n);
      const raw = await signer.signTransaction(request);
      return { address: getCreateAddress({ from: signer.address, nonce: request.nonce }), hash: keccak256(raw), raw };
    },
    async validate(stage) {
      const tx = Transaction.from(stage.raw);
      assert.equal(tx.chainId, 11155111n);
      assert.equal(tx.to, null);
      assert.equal(tx.value, 0n);
      assert.equal(tx.hash, stage.hash);
      assert.equal(getCreateAddress({ from: tx.from, nonce: tx.nonce }), stage.address);
      const expected = await new ContractFactory(inbox.abi, inbox.bytecode.object).getDeployTransaction(config.rollupAddress, config.rollupVersion);
      assert.equal(tx.data, expected.data, 'Saved L1 transaction differs from the deployment plan');
    },
    async receipt(stage) {
      const receipt = await provider.getTransactionReceipt(stage.hash);
      return receipt && await receipt.confirmations() >= 2 ? receipt : null;
    },
    async broadcast(stage) {
      // A known pending/mined transaction needs waiting, not a replacement nonce.
      if (!await provider.getTransaction(stage.hash)) await provider.broadcastTransaction(stage.raw);
    },
    wait: stage => provider.waitForTransaction(stage.hash, 2, 180_000),
    async verify(stage, receipt) {
      assert.equal(receipt.status, 1, 'L1 deployment reverted; inspect it before making a new deployment');
      assert.equal(receipt.contractAddress?.toLowerCase(), stage.address.toLowerCase());
      const code = await provider.getCode(stage.address);
      assert.notEqual(code, '0x');
      const entry = new EvmContract(stage.address, inbox.abi, provider);
      assert.equal((await entry.INBOX()).toLowerCase(), config.inboxAddress.toLowerCase());
      assert.equal(String(await entry.ROLLUP_VERSION()), config.rollupVersion);
      const hash = keccak256(code);
      if (stage.runtimeCodeHash) assert.equal(hash, stage.runtimeCodeHash, 'L1 bytecode changed');
      return { runtimeCodeHash: hash, blockNumber: receipt.blockNumber };
    },
  };
  const l2 = {
    async prepare() {
      if (!journal.state.account) {
        journal.state.account = { secret: Fr.random().toString(), salt: Fr.random().toString(), signingKey: Fq.random().toString(), boardSalt: Fr.random().toString() };
        journal.save();
      }
      const account = journal.state.account;
      let prepared;
      // Use the SDK's normal simulation/proving path, but intercept its send
      // boundary: no bytes can reach the network before runStage checkpoints.
      const provingNode = new Proxy(node, { get(target, name) {
        if (name === 'sendTx') return async tx => {
          prepared = { ...prepared, hash: tx.getTxHash().toString(), raw: tx.toBuffer().toString('base64') };
          throw new Error('Deployment prepared; broadcast is handled by the journal');
        };
        return Reflect.get(target, name);
      } });
      const wallet = await createWallet(provingNode, { ephemeral: true, pxeConfig: { proverEnabled: true } });
      try {
        const manager = await wallet.createSchnorrInitializerlessAccount(Fr.fromString(account.secret), Fr.fromString(account.salt), Fq.fromString(account.signingKey));
        await wallet.registerContract(sponsor, SponsoredFPCContract.artifact);
        const deploy = Contract.deploy(wallet, artifact, [EthAddress.fromString(journal.state.l1.address)], 'constructor_with_inbox', { salt: Fr.fromString(account.boardSalt), deployer: manager.address });
        prepared = { address: (await deploy.getInstance()).address.toString() };
        try {
          await deploy.send({ from: manager.address, fee: await getBillboardFeeOptions(node, new SponsoredFeePaymentMethod(sponsor.address), GasFees) });
        } catch (error) {
          if (!prepared.raw) throw error;
        }
        assert(prepared.raw, 'SDK did not produce a deployment transaction');
        return prepared;
      } finally { await wallet.stop(); }
    },
    async validate(stage) {
      assert.equal(Tx.fromBuffer(Buffer.from(stage.raw, 'base64')).getTxHash().toString(), stage.hash, 'Saved Aztec transaction is corrupted');
    },
    async receipt(stage) {
      const receipt = await node.getTxReceipt(TxHash.fromString(stage.hash));
      return ['checkpointed', 'proven', 'finalized'].includes(receipt.status) ? receipt : null;
    },
    async broadcast(stage) {
      const receipt = await node.getTxReceipt(TxHash.fromString(stage.hash));
      if (receipt.status === 'dropped') await node.sendTx(Tx.fromBuffer(Buffer.from(stage.raw, 'base64')));
    },
    wait: stage => waitForTx(node, TxHash.fromString(stage.hash), { timeout: 180, dontThrowOnRevert: true }),
    async verify(stage, receipt) {
      assert.equal(receipt.executionResult, 'success', 'Aztec deployment reverted; no automatic replacement will be sent');
      const address = AztecAddress.fromStringUnsafe(stage.address);
      const instance = await node.getContract(address);
      assert.equal(instance?.currentContractClassId.toString(), binding.boardClassId, 'Board class does not match compiled artifact');
      const sender = await node.getPublicStorageAt('latest', address, artifact.storageLayout.l1_inbox.slot);
      assert.equal(sender.toBigInt(), BigInt(journal.state.l1.address), 'Board points to a different L1 entry');
      return { blockNumber: Number(receipt.blockNumber) };
    },
  };
  return { l1, l2 };
}

export async function verifyDeployment(journal, networkAdapters) {
  for (const name of ['l1', 'l2']) {
    const stage = journal.state[name];
    assert(stage?.confirmed, `${name} deployment is incomplete; resume deployment first`);
    const adapter = networkAdapters[name];
    await adapter.validate(stage);
    const receipt = await adapter.receipt(stage);
    assert(receipt, `${name} no longer confirmed on this network`);
    await adapter.verify(stage, receipt);
  }
}
