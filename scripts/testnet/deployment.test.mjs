import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Wallet, ContractFactory, keccak256, getCreateAddress } from 'ethers';
import { Tx } from '@aztec-labs/aztec.js/tx';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { atomicJson, checkNetwork, openJournal, publicManifest, readPrivateJson, runStage } from './state.mjs';
import { adapters } from './network.mjs';
import { buildRelease, vercelConfig } from './release.mjs';

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
const binding = { config, boardArtifactHash: 'artifact-hash', boardClassId: 'class-id', sponsoredFpc: 'sponsor' };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billboard-deployment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'deployment.json');
}
function mockStage(events, changes = {}) {
  return {
    async prepare() { events.push('prepare'); return { address: 'address', hash: 'hash', raw: 'signed-transaction' }; },
    async validate() { events.push('validate'); },
    async receipt() { events.push('receipt'); return null; },
    async broadcast() { events.push('broadcast'); },
    async wait() { events.push('wait'); return { status: 1 }; },
    async verify(_stage, receipt) { assert.equal(receipt.status, 1, 'reverted'); events.push('verify'); return { runtimeCodeHash: 'code-hash' }; },
    ...changes,
  };
}

test('pins chain, rollup, inbox, version and real proofs', () => {
  const info = { nodeVersion: config.nodeVersion, l1ChainId: 11155111, realProofs: true,
    rollupVersion: config.rollupVersion, l1ContractAddresses: { rollupAddress: config.rollupAddress, inboxAddress: config.inboxAddress } };
  checkNetwork(config, info, 11155111n);
  for (const change of [{ nodeVersion: '5.0.1' }, { realProofs: false }, { l1ChainId: 1 }, { rollupVersion: '1' },
    { l1ContractAddresses: { ...info.l1ContractAddresses, inboxAddress: 'other' } },
    { l1ContractAddresses: { ...info.l1ContractAddresses, rollupAddress: 'other' } }]) {
    assert.throws(() => checkNetwork(config, { ...info, ...change }, 11155111n));
  }
  assert.throws(() => checkNetwork(config, info, 31337n));
  for (const url of ['http://rpc.example', 'https://localhost', 'https://user:secret@rpc.example']) {
    assert.throws(() => checkNetwork({ ...config, nodeUrl: url }, info, 11155111n));
  }
});

test('journal locks concurrent runs, writes mode 600 and rejects changed artifacts', t => {
  const file = temporary(t);
  const journal = openJournal(file, binding);
  journal.save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => openJournal(file, binding), /EEXIST/);
  journal.close();
  assert.throws(() => openJournal(file, { ...binding, boardArtifactHash: 'changed' }), /changed/);
  const restored = openJournal(file, binding);
  assert.deepEqual(restored.state.binding, binding);
  restored.close();
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file), /permissions/);
});

test('signed transaction is saved before broadcasting', async t => {
  const journal = openJournal(temporary(t), binding);
  const events = [];
  const save = journal.save;
  journal.save = () => { events.push('save'); save(); };
  await runStage(journal, 'l1', mockStage(events));
  assert.deepEqual(events, ['prepare', 'save', 'validate', 'receipt', 'broadcast', 'wait', 'verify', 'save']);
});

test('failed checkpoint never broadcasts', async () => {
  const events = [];
  const journal = { state: {}, save() { throw new Error('disk full'); } };
  await assert.rejects(runStage(journal, 'l1', mockStage(events)), /disk full/);
  assert.deepEqual(events, ['prepare']);
});

test('restart after ambiguous broadcast recovers exact transaction, no second preparation', async t => {
  const file = temporary(t);
  let journal = openJournal(file, binding);
  await assert.rejects(runStage(journal, 'l1', mockStage([], { async broadcast() { throw new Error('connection lost'); } })), /connection lost/);
  journal.close();
  journal = openJournal(file, binding);
  const events = [];
  await runStage(journal, 'l1', mockStage(events, { async broadcast(stage) { assert.equal(stage.raw, 'signed-transaction'); events.push('rebroadcast same'); } }));
  assert(!events.includes('prepare'));
  assert(events.includes('rebroadcast same'));
  assert(journal.state.l1.confirmed);
});

test('restart after receipt but before checkpoint verifies without sending', async t => {
  const file = temporary(t);
  atomicJson(file, { schemaVersion: 1, binding, l1: { hash: 'hash', raw: 'signed', address: 'address' } });
  const journal = openJournal(file, binding);
  const events = [];
  await runStage(journal, 'l1', mockStage(events, { async receipt() { return { status: 1 }; } }));
  assert.deepEqual(events, ['validate', 'verify']);
  assert(journal.state.l1.confirmed);
});

test('reverted transaction and confirmation timeout do not trigger replacement', async t => {
  const journal = openJournal(temporary(t), binding);
  const events = [];
  await assert.rejects(runStage(journal, 'l2', mockStage(events, { async wait() { return null; } })), /timed out/);
  assert(!journal.state.l2.confirmed);
  events.length = 0;
  await assert.rejects(runStage(journal, 'l2', mockStage(events, { async receipt() { return { status: 0 }; } })), /reverted/);
  assert.deepEqual(events, ['validate']);
});

test('public export excludes all secrets and refuses incomplete deployments', () => {
  const state = { schemaVersion: 1, binding, account: { secret: 'PRIVATE' },
    l1: { confirmed: true, raw: 'PRIVATE', address: 'entry', hash: 'l1hash', runtimeCodeHash: 'codehash' },
    l2: { confirmed: true, raw: 'PRIVATE', address: 'board', hash: 'l2hash' } };
  const manifest = publicManifest(state);
  assert(!JSON.stringify(manifest).includes('PRIVATE'));
  assert.equal(manifest.environment, 'testnet');
  assert.equal(manifest.l1Request.chainId, 11155111);
  assert.equal(manifest.boardArtifactHash, binding.boardArtifactHash);
  assert.throws(() => publicManifest({ ...state, l2: {} }), /confirmed/);
});

test('Vercel config isolates workers and does not rewrite missing assets to HTML', () => {
  const config = vercelConfig();
  assert.equal(config.version, 3);
  const [headers, filesystem, app, missing] = config.routes;
  assert.equal(headers.headers['Cross-Origin-Embedder-Policy'], 'credentialless');
  assert.equal(headers.headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(filesystem.handle, 'filesystem');
  for (const route of ['/reports', '/fee-lab', '/l1-post-lab']) assert(new RegExp(`^${app.src}$`).test(route));
  for (const route of ['/missing.js', '/onnx/missing.wasm', '/df-local.json', '/.env']) assert(!new RegExp(`^${app.src}$`).test(route));
  assert.equal(missing.status, 404);
});

test('L1 recovery validates signed creation bytecode, chain and expected address without reading a key', async () => {
  const inbox = JSON.parse(fs.readFileSync(new URL('../../.local/billboard-l1-out/BillboardInbox.sol/BillboardInbox.json', import.meta.url)));
  const signer = Wallet.createRandom(); // Ephemeral fixture, never funded or sent.
  const data = await new ContractFactory(inbox.abi, inbox.bytecode.object).getDeployTransaction(config.rollupAddress, config.rollupVersion);
  const raw = await signer.signTransaction({ ...data, nonce: 0, chainId: 11155111, gasLimit: 1_000_000, gasPrice: 1 });
  const stage = { raw, hash: keccak256(raw), address: getCreateAddress({ from: signer.address, nonce: 0 }) };
  const adapter = adapters({ binding, inbox }, { state: {} }, '/must-not-read').l1;
  await adapter.validate(stage);
  await assert.rejects(adapter.validate({ ...stage, hash: 'wrong' }));
  await assert.rejects(adapter.validate({ ...stage, address: config.rollupAddress }));
});

test('release rejects wrong artifacts before creating output', async t => {
  const destination = path.join(path.dirname(temporary(t)), 'release');
  await assert.rejects(buildRelease({ environment: 'testnet', boardArtifactHash: 'wrong' }, destination), /mismatch/);
  assert(!fs.existsSync(destination));
});

test('L2 preparation captures SDK transaction before broadcasting and restores serialized bytes', async t => {
  const journal = openJournal(temporary(t), binding);
  journal.state.l1 = { address: config.rollupAddress }; // Offline constructor fixture only.
  const artifact = loadContractArtifact(JSON.parse(fs.readFileSync(new URL('../../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url))));
  const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: Fr.ZERO });
  const transaction = Tx.random();
  let broadcast = 0;
  let stopped = false;
  const fees = new GasFees(1n, 1n);
  const node = {
    async sendTx() { broadcast++; },
    async getBlock() { return { header: { globalVariables: { gasFees: fees } } }; },
    async getPredictedMinFees() { return [fees]; },
    async getTxReceipt() { return { status: 'dropped' }; },
    async getContract() { return { currentContractClassId: { toString: () => binding.boardClassId } }; },
    async getPublicStorageAt() { return new Fr(BigInt(journal.state.l1.address)); },
  };
  const createWallet = async (provingNode, options) => {
    assert.equal(options.pxeConfig.proverEnabled, true);
    return {
      async createSchnorrInitializerlessAccount() { return { address: AztecAddress.fromBigIntUnsafe(123n) }; },
      async registerContract() {},
      async getContractClassMetadata() { return { isContractClassPubliclyRegistered: false }; },
      async sendTx() { return provingNode.sendTx(transaction); },
      async stop() { stopped = true; },
    };
  };
  const adapter = adapters({ node, artifact, sponsor, binding }, journal, undefined, createWallet).l2;
  const prepared = await adapter.prepare();
  assert(journal.state.account);
  assert(stopped);
  assert.equal(broadcast, 0);
  await adapter.validate(prepared);
  assert.equal(prepared.hash, transaction.getTxHash().toString());
  await assert.rejects(adapter.validate({ ...prepared, hash: 'corrupt' }));
  await adapter.broadcast(prepared);
  assert.equal(broadcast, 1);
  await adapter.verify(prepared, { executionResult: 'success', blockNumber: 1 });
  await assert.rejects(adapter.verify(prepared, { executionResult: 'reverted' }), /reverted/);
});

test('CLI refuses deploy without --broadcast before network or key access', () => {
  const result = spawnSync(process.execPath, [new URL('../deploy-billboard-testnet.mjs', import.meta.url).pathname, 'deploy', '--key-file', '/must-not-read'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires explicit --broadcast/);
});
