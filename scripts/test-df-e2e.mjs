// Standalone local integration: fresh zero-balance accounts -> sponsored posts.
// --real-proofs additionally verifies the client's proof and rejects a tampered
// copy. The local rollup itself still runs in synthetic-proof mode.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { Fr, Fq } from '@aztec/aztec.js/fields';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC';
import { Tx } from '@aztec/aztec.js/tx';
import { GasFees } from '@aztec/stdlib/gas';
import { encodeDFMessage, decodeDFMessage, getBillboardFeeOptions } from '../shared/df-billboard.mjs';

const deployment = JSON.parse(fs.readFileSync(new URL('../.local/billboard-harness.json', import.meta.url)));
assert.equal(deployment.kind, 'standalone-billboard', 'Run npm run deploy:df:harness first');
assert(['127.0.0.1', 'localhost'].includes(new URL(deployment.nodeUrl).hostname));
assert(!process.argv.includes('--df-core'), 'DF eligibility was removed; use the standalone E2E');
const node = createAztecNodeClient(deployment.nodeUrl);
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Refusing non-local chain');
assert.equal(info.nodeVersion, '5.0.1');
assert.equal(info.realProofs, false, 'Expected synthetic-proof local network');
assert.equal((await node.getL1ContractAddresses()).rollupAddress.toString(), deployment.rollupAddress);
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
const realProofs = process.argv.includes('--real-proofs');
const sponsor = AztecAddress.fromStringUnsafe(deployment.sponsoredFpc);
const sponsorInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
  salt: Fr.fromString(deployment.sponsorSalt),
});
assert(sponsorInstance.address.equals(sponsor));
const paymentMethod = new SponsoredFeePaymentMethod(sponsor);
let verifier;
let verifiedProofs = 0;
let verifyNext = false;
const payers = [];
const originalSend = node.sendTx.bind(node);
node.sendTx = async tx => {
  assert(tx.data.feePayer.equals(sponsor), 'Every submitted transaction must use Sponsored FPC');
  payers.push(tx.data.feePayer.toString());
  if (verifyNext) {
    assert.equal((await verifier.verifyProof(tx)).valid, true, 'Client proof must verify');
    const tampered = Tx.fromBuffer(tx.toBuffer());
    tampered.chonkProof.fields[0] = tampered.chonkProof.fields[0].add(Fr.ONE);
    assert.equal((await verifier.verifyProof(tampered)).valid, false, 'Tampered proof must fail');
    verifiedProofs++;
  }
  return originalSend(tx);
};
try {
  if (realProofs) {
    const { BBCircuitVerifier } = await import('@aztec/bb-prover/verifier');
    verifier = await BBCircuitVerifier.new({
      bbWorkingDirectory: fileURLToPath(new URL('../.local/billboard-verifier', import.meta.url)),
      numConcurrentIVCVerifiers: 1,
    });
  }
  const owner = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const other = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const artifact = loadContractArtifact(JSON.parse(fs.readFileSync(
    new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url))));
  const instance = await node.getContract(AztecAddress.fromStringUnsafe(deployment.board));
  assert(instance, 'Billboard must be deployed on this chain');
  await wallet.registerContract(instance, artifact);
  await wallet.registerContract(sponsorInstance, SponsoredFPCContract.artifact);
  const board = Contract.at(instance.address, artifact, wallet);
  const initialCount = BigInt((await node.getPublicStorageAt('latest', instance.address, artifact.storageLayout.post_count.slot)).toString());
  const before = await getFeeJuiceBalance(owner, node);
  const sponsorBefore = await getFeeJuiceBalance(sponsor, node);
  assert.equal(before, 0n, 'Fresh account must have no Fee Juice');
  assert(sponsorBefore > 0n, 'Sponsor must be funded');

  const message = '独立匿名留言板：无需 DF 入局、无需存款，Sponsored FPC 代付 🌲';
  const { text, length } = encodeDFMessage(message);
  const receipts = [];
  const send = async (from) => {
    // Verify two proofs when requested; the other sends still exercise the same
    // wallet/private-history path without repeating expensive proof generation.
    verifyNext = realProofs && receipts.length < 2;
    wallet.pxe.proverEnabled = verifyNext;
    try {
      const fee = await getBillboardFeeOptions(node, paymentMethod, GasFees);
      const posted = await board.methods.post(text, length).send({ from, fee });
      assert.equal(posted.receipt.executionResult, 'success');
      receipts.push({ txHash: posted.receipt.txHash.toString(), transactionFee: posted.receipt.transactionFee?.toString() });
    } finally {
      wallet.pxe.proverEnabled = false;
      verifyNext = false;
    }
  };
  for (let i = 0; i < 10; i++) {
    await send(owner);
    console.log(`PASS sponsored post ${i + 1}/10 from a fresh zero-balance account`);
  }
  await assert.rejects(
    async () => board.methods.post(text, length).simulate({ from: owner, fee: await getBillboardFeeOptions(node, paymentMethod, GasFees) }),
    /24-hour post limit reached/);
  console.log('PASS 11th post rejected inside rolling 24-hour window');
  await send(other);
  await assert.rejects(
    async () => board.methods._publish(Array(17).fill(0n), 1).simulate({ from: other, fee: await getBillboardFeeOptions(node, paymentMethod, GasFees) }),
    /only be called by the same contract/);
  const count = BigInt((await node.getPublicStorageAt('latest', instance.address, artifact.storageLayout.post_count.slot)).toString());
  assert.equal(count, initialCount + 11n);
  const value = await board.methods.get_post(initialCount).simulate({ from: other });
  const [fields, byteLength] = value.result ?? value;
  assert.equal(decodeDFMessage(fields, byteLength), message);
  const after = await getFeeJuiceBalance(owner, node);
  const otherAfter = await getFeeJuiceBalance(other, node);
  const sponsorAfter = await getFeeJuiceBalance(sponsor, node);
  assert.equal(after, 0n, 'Posting must not charge the author');
  assert.equal(otherAfter, 0n, 'Second account must remain unfunded');
  assert(sponsorAfter < sponsorBefore, 'Sponsor must actually pay transaction fees');
  assert(payers.length >= 11);
  assert.equal(verifiedProofs, realProofs ? 2 : 0);
  const result = {
    completedAt: new Date().toISOString(), nodeVersion: info.nodeVersion,
    rollupRealProofs: false, clientRealProofs: realProofs, verifiedProofs,
    board: instance.address.toString(), sponsoredFpc: sponsor.toString(),
    owner: owner.toString(), other: other.toString(),
    initialPostCount: initialCount.toString(), finalPostCount: count.toString(),
    ownerBalanceBefore: before.toString(), ownerBalanceAfter: after.toString(),
    sponsorBalanceBefore: sponsorBefore.toString(), sponsorBalanceAfter: sponsorAfter.toString(),
    quotaRejected: true, noPlayerRegistration: true, noDeposit: true, receipts, message,
  };
  fs.writeFileSync(new URL('../.local/billboard-e2e-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log('STANDALONE BILLBOARD E2E PASSED');
} finally {
  await wallet.stop();
  await verifier?.stop();
}
