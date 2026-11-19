// Local integration: L1 stake -> private L2 claim -> sponsored post -> L1 withdrawal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Contract as EvmContract, JsonRpcProvider } from 'ethers';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { computeSecretHash } from '@aztec-labs/stdlib/hash';
import { encodeDFMessage, decodeDFMessage, getBillboardFeeOptions } from '../shared/df-billboard.mjs';

const deployment = JSON.parse(fs.readFileSync(new URL('../.local/billboard-harness.json', import.meta.url)));
assert.equal(deployment.kind, 'notch-stake');
assert.equal(deployment.chainId, 31337, 'Only local chain is allowed');
const node = createAztecNodeClient(deployment.nodeUrl);
const debug = createAztecNodeDebugClient(deployment.nodeUrl);
const info = await node.getNodeInfo();
assert.equal(info.nodeVersion, '6.0.0');
assert.equal(info.realProofs, false);
const provider = new JsonRpcProvider(deployment.l1Stake.rpcUrl, undefined, { cacheTimeout: -1 });
const signer = await provider.getSigner(1);
const l1Owner = await signer.getAddress();
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
try {
  const owner = (await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())).address;
  const boardArtifact = loadContractArtifact(JSON.parse(fs.readFileSync(new URL('../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url))));
  const instance = await node.getContract(AztecAddress.fromStringUnsafe(deployment.board));
  assert(instance, 'Board is missing');
  await wallet.registerContract(instance, boardArtifact);
  const board = await Contract.at(instance.address, boardArtifact, wallet);
  const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: Fr.ZERO });
  await wallet.registerContract(sponsor, SponsoredFPCContract.artifact);
  const fee = () => getBillboardFeeOptions(node, new SponsoredFeePaymentMethod(sponsor.address), GasFees);
  const portalArtifact = JSON.parse(fs.readFileSync(new URL('../.local/billboard-l1-out/BillboardPortal.sol/BillboardPortal.json', import.meta.url)));
  const portal = new EvmContract(deployment.l1Stake.portal, portalArtifact.abi, signer);
  assert.equal((await portal.board()).toLowerCase(), deployment.board.toLowerCase());
  const send = async call => {
    const tx = await call.send({ from: owner, fee: await fee() });
    assert.equal(tx.receipt.executionResult, 'success');
    return tx;
  };
  const stake = async amount => {
    const secret = Fr.random();
    const receipt = await (await portal.deposit((await computeSecretHash(secret)).toString(), { value: amount })).wait();
    const deposited = receipt.logs.map(log => { try { return portal.interface.parseLog(log); } catch { return null; } })
      .find(event => event?.name === 'Deposited');
    assert(deposited);
    assert.equal(deposited.args.amount, amount);
    for (let i = 0; i < 6; i++) await debug.warpL2TimeAtLeastBy(72);
    await send(board.methods.claim_deposit(EthAddress.fromString(l1Owner), amount, secret, deposited.args.index));
  };
  const readStake = async () => {
    const result = await board.methods.get_stake_info(owner).simulate({ from: owner });
    return result.result ?? result;
  };
  const { text, length } = encodeDFMessage('Notch stake integration test');
  await assert.rejects(board.methods.post(text, length).simulate({ from: owner, fee: await fee() }), /Stake required/);
  await stake(500_000_000_000_000n);
  assert.equal(BigInt((await readStake())[0]), 500_000_000_000_000n);
  for (let i = 0; i < 5; i++) await send(board.methods.post(text, length));
  await assert.rejects(board.methods.post(text, length).simulate({ from: owner, fee: await fee() }), /24-hour post limit reached/);
  await stake(500_000_000_000_000n);
  assert.equal(BigInt((await readStake())[0]), 1_000_000_000_000_000n);
  await send(board.methods.post(text, length));
  const count = BigInt((await board.methods.get_post_count().simulate({ from: owner })).result);
  const post = await board.methods.get_post(count - 1n).simulate({ from: owner });
  const [fields, byteLength] = post.result ?? post;
  assert.equal(decodeDFMessage(fields, byteLength), 'Notch stake integration test');
  await assert.rejects(board.methods.withdraw().simulate({ from: owner, fee: await fee() }), /Wait 24 hours/);
  await debug.warpL2TimeAtLeastBy(86_500);
  const exit = await send(board.methods.withdraw());
  await debug.prove();
  const effect = await node.getTxEffect(exit.receipt.txHash);
  const index = effect.data.l2ToL1Msgs.findIndex(value => !value.isZero());
  assert(index >= 0);
  const witness = await node.getL2ToL1MembershipWitness(exit.receipt.txHash, effect.data.l2ToL1Msgs[index], index);
  assert(witness, 'Withdrawal proof missing');
  const path = witness.siblingPath.toBufferArray().map(value => `0x${Buffer.from(value).toString('hex')}`);
  await (await portal.withdraw(1_000_000_000_000_000n, witness.epochNumber,
    witness.numCheckpointsInEpoch, witness.leafIndex, path)).wait();
  assert.equal(await portal.deposits(l1Owner), 0n);
  assert.equal(BigInt((await readStake())[0]), 0n);
  console.log('PASS L1 stake, two L2 claims, tier increase, sponsored posts, 24h lock, L1 refund');
} finally {
  await wallet.stop();
  provider.destroy();
}
