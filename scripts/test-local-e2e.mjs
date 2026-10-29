// Local-only integration: real Anvil/L2 transactions, simulated proofs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { JsonRpcProvider, ContractFactory } from 'ethers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.join(root, 'package.json'));
const sdk = name => import(requireTools.resolve(name));
const { createAztecNodeClient } = await sdk('@aztec-labs/aztec.js/node');
const { createAztecNodeDebugClient } = await sdk('@aztec-labs/stdlib/interfaces/client');
const { EmbeddedWallet } = await sdk('@aztec-labs/wallets/embedded');
const { getInitialTestAccountsData } = await sdk('@aztec-labs/accounts/testing');
const { Contract } = await sdk('@aztec-labs/aztec.js/contracts');
const { loadContractArtifact } = await sdk('@aztec-labs/aztec.js/abi');
const { Fr } = await sdk('@aztec-labs/aztec.js/fields');
const { EthAddress } = await sdk('@aztec-labs/foundation/eth-address');
const { computeSecretHash } = await sdk('@aztec-labs/aztec.js/crypto');
const node = createAztecNodeClient('http://127.0.0.1:5180');
const debug = createAztecNodeDebugClient('http://127.0.0.1:5180');
const provider = new JsonRpcProvider('http://127.0.0.1:5954');
const info = await node.getNodeInfo();
assert.equal(info.l1ChainId, 31337, 'Refusing non-local chain');
assert.equal(info.nodeVersion, '6.0.0');
assert.equal(info.realProofs, false, 'This test expects a synthetic-proof local network');
let advancing = false;
const clock = setInterval(async () => {
  if (advancing) return;
  advancing = true;
  try { await debug.warpL2TimeAtLeastBy(72); } catch (error) { console.error('Local clock:', error.message); }
  finally { advancing = false; }
}, 10000);
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
const accounts = await getInitialTestAccountsData();
for (const a of accounts) await wallet.createSchnorrInitializerlessAccount(a.secret, a.salt, a.signingKey);
const owner = accounts[0].address;
const censor = accounts[1].address;
const send = async (call, from = owner) => {
  const result = await call.send({ from });
  assert.equal(result.receipt.executionResult, 'success');
  return result;
};
const view = async (contract, method, ...args) => {
  const value = await contract.methods[method](...args).simulate({ from: owner });
  return value.result ?? value;
};
const pack = text => {
  const bytes = Buffer.from(text);
  assert(bytes.length <= 992);
  const fields = Array(32).fill(0n);
  bytes.forEach((b, i) => fields[Math.floor(i / 31)] += BigInt(b) << BigInt(8 * (i % 31)));
  return fields;
};
try {
  const artifact = loadContractArtifact(JSON.parse(fs.readFileSync(path.join(root, 'apps/src/billboard/billboard_artifact.json'))));
  const { contract } = await Contract.deploy(wallet, artifact,
    [1000000000000000n, 1n, censor, 4n, 1n, 16n, Array(48).fill(0n), 0n], 'init').send({ from: owner });
  console.log('PASS L2 deploy', contract.address.toString());
  const portalArtifact = JSON.parse(fs.readFileSync(path.join(root, '.local/portal-out/BillboardPortal.sol/BillboardPortal.json')));
  const signer = await provider.getSigner(0);
  const l1Owner = await signer.getAddress();
  const portal = await new ContractFactory(portalArtifact.abi, portalArtifact.bytecode.object, signer)
    .deploy(info.l1ContractAddresses.rollupAddress.toString(), contract.address.toString(), info.rollupVersion, 1000000000000000n);
  await portal.waitForDeployment();
  const portalAddress = await portal.getAddress();
  await send(contract.methods.update_portal(EthAddress.fromString(portalAddress)));
  console.log('PASS L1 portal deployment and linking', portalAddress);
  const secret = Fr.random();
  const deposit = await (await portal.deposit((await computeSecretHash(secret)).toString(), { value: 1000000000000000n })).wait();
  const deposited = deposit.logs.map(l => { try { return portal.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Deposited');
  assert(deposited);
  for (let i = 0; i < 4; i++) await debug.warpL2TimeAtLeastBy(72);
  await send(contract.methods.claim_deposit(EthAddress.fromString(l1Owner), 1000000000000000n, secret, deposited.args.index, EthAddress.fromString(portalAddress)));
  assert.equal(BigInt((await view(contract, 'get_deposit_info', owner))[0]), 1000000000000000n);
  console.log('PASS L1 deposit -> private L2 deposit note');
  await debug.warpL2TimeAtLeastBy(72);
  const message = pack('Hello DFArchon — local anonymous billboard works!');
  await send(contract.methods.post(message, false, null, null));
  assert.equal(BigInt(await view(contract, 'get_post_count')), 1n);
  assert.deepEqual((await view(contract, 'get_post', 0n)).map(BigInt), message);
  console.log('PASS anonymous post and public readback');
  await send(contract.methods.declare_immoral(0n, pack('Local moderation test')), censor);
  assert.equal(await view(contract, 'is_post_flagged', 0n), true);
  console.log('PASS censor flags published message');
  await debug.warpL2TimeAtLeastBy(72);
  const hints = await view(contract, 'get_screen_hints', owner);
  await send(contract.methods.post(Array(32).fill(0n), true, hints[0], hints[1]));
  await debug.warpL2TimeAtLeastBy(72);
  const withdrawal = await send(contract.methods.withdraw(EthAddress.fromString(portalAddress)));
  console.log('PASS screened dummy post and L2 withdrawal');
  await debug.prove();
  const effect = await node.getTxEffect(withdrawal.receipt.txHash);
  const index = effect.data.l2ToL1Msgs.findIndex(x => !x.isZero());
  const witness = await node.getL2ToL1MembershipWitness(withdrawal.receipt.txHash, effect.data.l2ToL1Msgs[index], index);
  assert(witness, 'Missing L2 -> L1 withdrawal witness');
  await (await portal.withdraw(witness.epochNumber, witness.numCheckpointsInEpoch, witness.leafIndex,
    witness.siblingPath.toBufferArray().map(b => '0x' + Buffer.from(b).toString('hex')))).wait();
  assert.equal(await portal.getDeposit(l1Owner), 0n);
  assert.equal(await provider.getBalance(portalAddress), 0n);
  console.log('PASS L1 withdrawal: escrow balance returned to zero');
  fs.mkdirSync(path.join(root, '.local'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local/e2e-result.json'), JSON.stringify({
    nodeVersion: info.nodeVersion, chainId: info.l1ChainId, realProofs: info.realProofs,
    contract: contract.address.toString(), portal: portalAddress,
    message: 'Hello DFArchon — local anonymous billboard works!', completedAt: new Date().toISOString()
  }, null, 2));
  console.log('LOCAL E2E PASSED');
} finally {
  clearInterval(clock);
  await wallet.stop();
  provider.destroy();
}
