// Actual local L1 -> L2 messages and sponsor debits; synthetic proofs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Contract as EvmContract, JsonRpcProvider } from 'ethers';
import { InboxAbi } from '@aztec-foundation/l1-artifacts';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Contract, NO_WAIT, getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { EventSelector, loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { getPublicEvents } from '@aztec-labs/aztec.js/events';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { TxHash } from '@aztec-labs/aztec.js/tx';
import { NO_FROM } from '@aztec-labs/aztec.js/account';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { computeSecretHash, siloNullifier } from '@aztec-labs/stdlib/hash';
import { computeFeeJuiceMessageNullifier } from '@aztec-labs/stdlib/messaging';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { createRequestSession, readRequestReceipt, requestABI, requestCommitment, validateRequestConfig, verifyRequestEntry } from '../apps/src/df-billboard-test/l1-request-core.ts';
import { syncLocalClock } from './sync-df-clock.mjs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL('.local/l1-post-lab.json', root)));
const a = { createAztecNodeClient, AztecAddress, Contract, NO_WAIT, getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams, EventSelector, loadContractArtifact, getPublicEvents,
  Fr, Fq, GasFees, TxHash, NO_FROM, SponsoredFeePaymentMethod, computeSecretHash, siloNullifier, computeFeeJuiceMessageNullifier };
const node = await validateRequestConfig(a, config);
await syncLocalClock(node, createAztecNodeDebugClient(config.nodeUrl), config);
const rpc = new JsonRpcProvider(config.l1.rpcUrl, undefined, { cacheTimeout: -1 });
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
const raw = JSON.parse(fs.readFileSync(new URL('apps/dist/df-l1-post-artifact.json', root)));
const sponsorRaw = JSON.parse(fs.readFileSync(new URL('apps/dist/df-sponsor-artifact.json', root)));
const results = [];
const debug = createAztecNodeDebugClient(config.nodeUrl);
try {
  const owner = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const session = await createRequestSession(a, node, wallet, owner, config, raw, sponsorRaw);
  const payer = await rpc.getSigner(5);
  await verifyRequestEntry(config, rpc);
  const entry = new EvmContract(config.l1.entry, requestABI, payer);
  const wait = async job => {
    for (let i = 0; i < 20 && !(await session.ready(job)); i++) {
      await debug.warpL2TimeAtLeastBy(12);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert(await session.ready(job), 'Message not ingested');
  };
  const job = await session.create('Gas-only L1 request · L2 由 Sponsored FPC 代付');
  const payerBefore = await rpc.getBalance(await payer.getAddress());
  const balanceBefore = await rpc.getBalance(config.l1.entry);
  const l1 = await entry.requestPost(config.board, job.commitment, job.secretHash, { value: 0n });
  const receipt = await l1.wait();
  job.l1Tx = receipt.hash;
  assert(await readRequestReceipt(config, job, rpc));
  assert.equal(l1.value, 0n);
  assert.equal(payerBefore - await rpc.getBalance(await payer.getAddress()), receipt.fee);
  assert.equal(await rpc.getBalance(config.l1.entry), balanceBefore);
  assert.equal(await getFeeJuiceBalance(owner, node), 0n);
  console.log('PASS L1 value=0; payer spent exactly L1 gas; no deposit or L2 balance');
  await wait(job);

  const changed = { ...job, text: 'Changed body' };
  changed.commitment = requestCommitment(changed.text, changed.salt, owner.toString());
  await assert.rejects(() => session.simulate(changed));
  await assert.rejects(() => session.simulate({ ...job, secret: Fr.random().toString() }));
  const other = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const otherSession = await createRequestSession(a, node, wallet, other, config, raw, sponsorRaw);
  await assert.rejects(() => otherSession.simulate({
    ...job, commitment: requestCommitment(job.text, job.salt, other.toString()),
  }));
  console.log('PASS on-chain validation rejects changed body, wrong secret, different account');

  // An attacker can send a valid protocol message directly, but it must not be
  // accepted as if it came from the board's pinned entry contract.
  const forged = await session.create('Wrong L1 sender');
  const inbox = new EvmContract(config.l1.inbox, InboxAbi, payer);
  const forgedReceipt = await (await inbox.sendL2Message([config.board, config.rollupVersion], forged.commitment, forged.secretHash)).wait();
  const forgedEvent = forgedReceipt.logs.map(log => { try { return inbox.interface.parseLog(log); } catch { return null; } })
    .find(event => event?.name === 'MessageSent');
  forged.messageKey = forgedEvent.args.hash; forged.leafIndex = forgedEvent.args.message.index.toString();
  await wait(forged);
  await assert.rejects(() => session.simulate(forged));
  console.log('PASS messages from another L1 sender rejected');

  // Resume from only persisted data after validation failures. No second L1 tx.
  const resumed = JSON.parse(JSON.stringify(job));
  const sponsor = AztecAddress.fromStringUnsafe(config.sponsoredFpc);
  const sponsorBefore = await getFeeJuiceBalance(sponsor, node);
  await session.publish(resumed, () => {});
  assert(resumed.postId !== undefined && resumed.l2Tx);
  const l2Receipt = await node.getTxReceipt(TxHash.fromString(resumed.l2Tx));
  const sponsorAfter = await getFeeJuiceBalance(sponsor, node);
  assert.equal(sponsorBefore - sponsorAfter, l2Receipt.transactionFee);
  assert.equal(await getFeeJuiceBalance(owner, node), 0n);
  await assert.rejects(() => session.simulate(job));
  assert(await session.discover(JSON.parse(JSON.stringify(resumed))));
  const tx = await node.getTxByHash(TxHash.fromString(resumed.l2Tx));
  const effect = await node.getTxEffect(TxHash.fromString(resumed.l2Tx));
  assert.equal(tx.data.feePayer.toString(), config.sponsoredFpc);
  const wire = tx.toBuffer().toString('hex') + effect.data.toBuffer().toString('hex');
  for (const value of [owner.toString(), await payer.getAddress(), job.commitment, job.secretHash, job.messageKey]) {
    assert(!wire.includes(value.slice(2).toLowerCase()), `Public plaintext identifier found: ${value}`);
  }
  console.log('PASS sponsor paid actual L2 fee; replay rejected; event/readback recovery; no tested plaintext identity link');
  results.push({ id: resumed.postId, l1Tx: job.l1Tx, l2Tx: resumed.l2Tx,
    l1Value: '0', l1GasPaid: receipt.fee.toString(), l2FeePaidBySponsor: l2Receipt.transactionFee.toString(),
    userL2Balance: '0', text: job.text });
  const second = await session.create('Second post needs its own L1 request');
  await assert.rejects(() => session.simulate(second), /not confirmed/);
  second.l1Tx = (await (await entry.requestPost(config.board, second.commitment, second.secretHash)).wait()).hash;
  await readRequestReceipt(config, second, rpc);
  await wait(second);
  await session.publish(second, () => {});
  assert.notEqual(second.postId, resumed.postId);
  results.push({ id: second.postId, l1Tx: second.l1Tx, l2Tx: second.l2Tx, text: second.text });
  console.log('PASS second post uses a distinct request; no fee prepayment');
  fs.writeFileSync(new URL('.local/l1-post-lab-e2e.json', root), JSON.stringify({
    completedAt: new Date().toISOString(), syntheticProofs: true, config, results,
    limitations: ['Local synthetic proofs only', 'Timing/network metadata may correlate users',
      'Test Sponsored FPC has no production sponsor budget policy', 'Direct Aztec post() remains available'],
  }, null, 2) + '\n');
  console.log('L1 POST LAB E2E PASSED', JSON.stringify(results));
} finally { await wallet.stop(); rpc.destroy(); }
