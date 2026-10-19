// Local prototype only: real Anvil + Aztec transactions, synthetic rollup proofs.
// Does not change the browser harness manifest, reset the chain, or use real ETH.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { AbiCoder, ContractFactory, JsonRpcProvider, hexlify, sha256, solidityPacked, toUtf8Bytes, zeroPadValue } from 'ethers';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec/stdlib/interfaces/client';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { EventSelector, loadContractArtifact } from '@aztec/aztec.js/abi';
import { getPublicEvents } from '@aztec/aztec.js/events';
import { Fr, Fq } from '@aztec/aztec.js/fields';
import { EthAddress } from '@aztec/foundation/eth-address';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { GasFees } from '@aztec/stdlib/gas';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { encodeDFMessage, decodeDFMessage, getBillboardFeeOptions } from '../shared/df-billboard.mjs';

const nodeUrl = process.env.DF_NODE_URL ?? 'http://127.0.0.1:5180';
const l1Url = process.env.DF_L1_RPC_URL ?? 'http://127.0.0.1:5954';
for (const url of [nodeUrl, l1Url]) {
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Only loopback nodes are allowed');
}
const node = createAztecNodeClient(nodeUrl);
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Refusing non-local Aztec network');
assert.equal(info.nodeVersion, '5.0.1');
assert.equal(info.realProofs, false, 'This prototype requires a synthetic-proof local network');
const l1 = await node.getL1ContractAddresses();
const provider = new JsonRpcProvider(l1Url, undefined, { cacheTimeout: -1 });
let wallet;
try {
  assert.equal((await provider.getNetwork()).chainId, 31337n, 'Refusing non-local Ethereum network');
  assert.notEqual(await provider.getCode(l1.rollupAddress.toString()), '0x', 'L1 RPC does not host this Aztec rollup');
  const debug = createAztecNodeDebugClient(nodeUrl);
  wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
  const owner = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: Fr.ZERO });
  await wallet.registerContract(sponsor, SponsoredFPCContract.artifact);
  const paymentMethod = new SponsoredFeePaymentMethod(sponsor.address);
  const fees = () => getBillboardFeeOptions(node, paymentMethod, GasFees);
  const sponsorBefore = await getFeeJuiceBalance(sponsor.address, node);
  assert(sponsorBefore > 0n, 'Local Sponsored FPC must be funded');
  assert.equal(await getFeeJuiceBalance(owner, node), 0n);
  // Also sponsor deployment of the isolated board; never alter the site's board.
  const artifact = loadContractArtifact(JSON.parse(fs.readFileSync(
    new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url))));
  const deployment = await Contract.deploy(wallet, artifact, []).send({ from: owner, fee: await fees() });
  assert.equal(deployment.receipt.executionResult, 'success');
  const board = deployment.contract;
  const portalArtifact = JSON.parse(fs.readFileSync(
    new URL('../.local/billboard-l1-out/BillboardPublisher.sol/BillboardPublisher.json', import.meta.url)));
  const deployer = await provider.getSigner(1);
  const payer = await provider.getSigner(2);
  const payerAddress = await payer.getAddress();
  const factory = new ContractFactory(portalArtifact.abi, portalArtifact.bytecode.object, deployer);
  const deployPublisher = async (source = board.address.toString(), version = info.rollupVersion) => {
    const publisher = await factory.deploy(l1.rollupAddress.toString(), source, version);
    await publisher.waitForDeployment();
    return publisher.connect(payer);
  };
  const publisher = await deployPublisher();
  const portalAddress = await publisher.getAddress();
  const wrongSource = await deployPublisher(new Fr(123n).toString());
  const wrongVersion = await deployPublisher(board.address.toString(), BigInt(info.rollupVersion) + 1n);
  const wrongRecipient = await deployPublisher();
  console.log(`PASS isolated L2 board ${board.address} and L1 publisher ${portalAddress}`);

  const hashToField = bytes => `0x00${sha256(bytes).slice(2, -2)}`;
  const contentHash = (id, body) => {
    const bytes = toUtf8Bytes(body);
    const packed = Array(17).fill(0n);
    bytes.forEach((byte, i) => packed[Math.floor(i / 31)] |= BigInt(byte) << BigInt(8 * (30 - i % 31)));
    return hashToField(AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'uint256', 'bytes32[17]'],
      [zeroPadValue('0x444642425f4c315f504f53545f5631', 32), id, bytes.length,
        packed.map(value => `0x${value.toString(16).padStart(64, '0')}`)]));
  };
  const read = async interaction => {
    const value = await interaction.simulate({ from: owner });
    return value.result ?? value;
  };
  const send = async interaction => {
    const result = await interaction.send({ from: owner, fee: await fees() });
    assert.equal(result.receipt.executionResult, 'success');
    return result;
  };
  const plain = encodeDFMessage('Only on L2');
  const plainPost = await send(board.methods.post(plain.text, plain.length));
  assert((await node.getTxEffect(plainPost.receipt.txHash)).data.l2ToL1Msgs.every(message => message.isZero()));
  const cases = ['Hello from Aztec', '黑暗森林：跨链匿名留言 🌲', `${'森'.repeat(170)}ab`];
  const pending = [];
  for (const body of cases) {
    const id = BigInt(await read(board.methods.get_post_count()));
    const encoded = encodeDFMessage(body);
    const posted = await send(board.methods.post_to_l1(encoded.text, encoded.length, EthAddress.fromString(portalAddress)));
    const [fields, length] = await read(board.methods.get_post(id));
    assert.equal(decodeDFMessage(fields, length), body);
    const effect = await node.getTxEffect(posted.receipt.txHash);
    const index = effect.data.l2ToL1Msgs.findIndex(message => !message.isZero());
    assert(index >= 0, 'L2 post must emit an L2 -> L1 message');
    const content = contentHash(id, body);
    const abiType = artifact.outputs.structs.events.find(event => event.path.endsWith('::L1PostQueued'));
    const queued = await getPublicEvents(node, {
      abiType, eventSelector: await EventSelector.fromSignature('L1PostQueued(u32,Field)'),
      fieldNames: abiType.fields.map(field => field.name),
    }, { contractAddress: board.address, txHash: posted.receipt.txHash });
    assert.equal(queued.events.length, 1, 'Exactly one source event identifies the post, even with concurrent writers');
    assert.equal(BigInt(queued.events[0].event.id), id);
    assert.equal(new Fr(BigInt(queued.events[0].event.content)).toString(), content);
    assert.equal(await publisher.computeContentHash(id, toUtf8Bytes(body)), content, 'JS/Solidity content hash mismatch');
    const leaf = hashToField(solidityPacked(['bytes32', 'uint256', 'address', 'uint256', 'bytes32'],
      [board.address.toString(), info.rollupVersion, portalAddress, 31337n, content]));
    assert.equal(effect.data.l2ToL1Msgs[index].toString(), leaf, 'Noir/JS/Solidity envelope mismatch');
    pending.push({ id, body, posted, index, leaf });
    console.log(`PASS L2 anonymous post #${id}: ${encoded.length} bytes, canonical cross-chain commitment`);
  }
  // Shared quota: one normal post + three L1-bound posts leaves exactly six.
  for (let i = 0; i < 6; i++) await send(board.methods.post(plain.text, plain.length));
  await assert.rejects(
    async () => board.methods.post_to_l1(plain.text, plain.length, EthAddress.fromString(portalAddress))
      .simulate({ from: owner, fee: await fees() }), /24-hour post limit reached/);
  assert.equal(BigInt(await read(board.methods.get_post_count())), 10n);
  console.log('PASS L1/L2 posting shares one quota; the 11th post is rejected');

  await debug.prove();
  const witnessFor = async entry => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const witness = await node.getL2ToL1MembershipWitness(entry.posted.receipt.txHash, Fr.fromString(entry.leaf), entry.index);
      if (witness) return witness;
      if (Date.now() >= deadline) throw new Error('Local epoch proof/witness did not become available');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };
  const proofArgs = witness => [witness.epochNumber, witness.numCheckpointsInEpoch, witness.leafIndex,
    witness.siblingPath.toBufferArray().map(value => hexlify(value))];
  const reject = async (label, call) => {
    await assert.rejects(call, error => error.code === 'CALL_EXCEPTION', label);
    console.log(`PASS rejected ${label}`);
  };
  const first = pending[0];
  const witness = await witnessFor(first);
  const proof = proofArgs(witness);
  const firstBody = toUtf8Bytes(first.body);
  await reject('tampered body', () => publisher.publish.staticCall(first.id, toUtf8Bytes(`${first.body}!`), ...proof));
  await reject('wrong post ID', () => publisher.publish.staticCall(first.id + 100n, firstBody, ...proof));
  await reject('wrong L2 source', () => wrongSource.publish.staticCall(first.id, firstBody, ...proof));
  await reject('wrong rollup version', () => wrongVersion.publish.staticCall(first.id, firstBody, ...proof));
  await reject('wrong L1 recipient', () => wrongRecipient.publish.staticCall(first.id, firstBody, ...proof));
  const badPath = [...proof[3]];
  assert(badPath.length > 0);
  badPath[0] = `0x${(BigInt(badPath[0]) ^ 1n).toString(16).padStart(64, '0')}`;
  await reject('tampered Merkle proof', () => publisher.publish.staticCall(first.id, firstBody, ...proof.slice(0, 3), badPath));
  assert.equal(await publisher.postCount(), 0n, 'Rejected messages must not change L1 storage');

  const payerBefore = await provider.getBalance(payerAddress);
  let gasPaid = 0n;
  const published = [];
  for (const entry of pending) {
    const args = proofArgs(await witnessFor(entry));
    const receipt = await (await publisher.publish(entry.id, toUtf8Bytes(entry.body), ...args)).wait();
    assert.equal(receipt.status, 1);
    assert.equal(receipt.from.toLowerCase(), payerAddress.toLowerCase());
    assert.equal(await publisher.getPost(entry.id), hexlify(toUtf8Bytes(entry.body)));
    const event = receipt.logs.map(log => {
      try { return publisher.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === 'PostPublished');
    assert(event && event.args.sourcePostId === entry.id);
    assert.equal(event.args.text, hexlify(toUtf8Bytes(entry.body)));
    gasPaid += receipt.fee;
    published.push({ sourcePostId: entry.id.toString(), text: entry.body, l2Tx: entry.posted.receipt.txHash.toString(),
      l1Tx: receipt.hash, l1GasUsed: receipt.gasUsed.toString(), l1FeeWei: receipt.fee.toString() });
    console.log(`PASS L1 published #${entry.id}, full body readable, gas paid by test account`);
  }
  await reject('duplicate publication', () => publisher.publish.staticCall(first.id, firstBody, ...proof));
  assert.equal(await publisher.isPublished(0), false, 'L2-only post must not appear on L1');
  assert.equal(await publisher.postCount(), 3n);
  const payerAfter = await provider.getBalance(payerAddress);
  assert.equal(payerBefore - payerAfter, gasPaid, 'Test payer balance delta must equal actual L1 receipt fees');
  assert.equal(await provider.getBalance(portalAddress), 0n, 'Publisher must not hold a deposit');
  assert.equal(await getFeeJuiceBalance(owner, node), 0n, 'L2 author remains unfunded');
  const sponsorAfter = await getFeeJuiceBalance(sponsor.address, node);
  assert(sponsorAfter < sponsorBefore, 'Sponsored FPC must pay L2 fees');
  const result = {
    completedAt: new Date().toISOString(), nodeUrl, l1Url, nodeVersion: info.nodeVersion,
    rollupRealProofs: false, clientRealProofs: false, rollupAddress: l1.rollupAddress.toString(),
    rollupVersion: info.rollupVersion.toString(), board: board.address.toString(), publisher: portalAddress,
    l2Author: owner.toString(), sponsoredFpc: sponsor.address.toString(), l2AuthorFeeJuice: '0',
    l1TestPayer: payerAddress, l1GasPaidWei: gasPaid.toString(), quotaShared: true,
    rejected: ['tampered body', 'wrong ID', 'wrong source', 'wrong version', 'wrong recipient', 'tampered proof', 'replay'],
    privacyBoundary: 'L1 submitter is public. This test does not implement anonymous user-paid L1 settlement.', published,
  };
  fs.mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../.local/billboard-l1-e2e-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log('BILLBOARD L2 -> L1 E2E PASSED');
} finally {
  await wallet?.stop();
  provider.destroy();
}
