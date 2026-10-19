import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';

// Match the browser/CLI WASM path instead of initializing native proving CRS.
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../shared/aztec_bundle.js', import.meta.url), 'utf8'));
const a = globalThis.__aztec;
assert.equal(a.SDK_VERSION, '6.0.0-rc.3');
// Noir initialization must work without a document URL or any runtime fetch.
// In the old build, wallet sync failed later when the simulator fetched WASM.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected fetch during embedded Noir initialization'); };
try {
  await Promise.all([a.initializeNoirRuntime(), a.initializeNoirRuntime()]);
} finally {
  globalThis.fetch = originalFetch;
}
for (const name of ['createPXE', 'Contract', 'BaseWallet', 'SchnorrInitializerlessAccountContract', 'createIndexedDBStore', 'GasFees', 'getFeeJuiceBalance']) {
  assert.equal(typeof a[name], 'function', name);
}
const artifact = a.loadContractArtifact(JSON.parse(fs.readFileSync(new URL('../apps/src/billboard/billboard_artifact.json', import.meta.url))));
await a.getContractClassFromArtifact(artifact);
const config = { rollupAddress: '0x01', l1ChainId: 31337, dataDirectory: `smoke-${Date.now()}` };
const store = await a.createIndexedDBStore('pxe', config);
await store.openSingleton('smoke').set('persisted');
await store.close();
const reopened = await a.createIndexedDBStore('pxe', config);
assert.equal(await reopened.openSingleton('smoke').getAsync(), 'persisted');
const isolated = await a.createIndexedDBStore('pxe', { ...config, l1ChainId: 31338 });
assert.equal(await isolated.openSingleton('smoke').getAsync(), undefined);
await reopened.delete();
await isolated.delete();

// Execute both shared fee-juice helpers in a browser-like realm without Buffer.
// Compare with Node SHA-256 plus the SDK secret hash, including zero padding.
const browser = vm.createContext({ window: { __aztec: a }, crypto: globalThis.crypto, log: () => {} });
vm.runInContext(fs.readFileSync(new URL('../shared/aztec-lib.js', import.meta.url), 'utf8'), browser);
assert.equal(vm.runInContext('typeof Buffer', browser), 'undefined');
// React opts out of the legacy indicator before any DOM or polling starts.
const monitorRealm = vm.createContext({
  window: { __aztec: { createAztecNodeClient: () => ({ getNodeInfo: async () => ({ l1ChainId: 31337 }) }) } },
  log: () => {},
});
vm.runInContext(fs.readFileSync(new URL('../shared/aztec-lib.js', import.meta.url), 'utf8'), monitorRealm);
monitorRealm.getNodeUrl = () => 'http://127.0.0.1:5180';
monitorRealm.wrapWithRetry = node => node;
monitorRealm.deriveAccountAddress = async () => ({ address: 'test' });
let monitorStarts = 0;
monitorRealm.startBlockMonitor = () => { monitorStarts++; };
const stopAfterMonitor = new Error('Stop before CRS setup');
monitorRealm.initCRS = async () => { throw stopAfterMonitor; };
for (const blockMonitor of [false, undefined, true]) {
  await assert.rejects(
    monitorRealm.ensureAztecSetup({}, 'test', { secretKey: 'test', salt: '0', blockMonitor }),
    error => error === stopAfterMonitor,
  );
  assert.equal(monitorStarts, blockMonitor === false ? 0 : blockMonitor === undefined ? 1 : 2);
}
const recipient = new a.Fr(9n), secret = new a.Fr(7n), amount = 100n, index = 2n;
const shaField = bytes => BigInt('0x' + createHash('sha256').update(bytes).digest('hex').slice(0, 62));
const content = shaField(Buffer.concat([
  Buffer.from('63f44968', 'hex'), recipient.toBuffer(), new a.Fr(amount).toBuffer(),
]));
const secretHash = await a.computeSecretHash(secret);
const expectedHash = new a.Fr(shaField(Buffer.concat([3n, 31337n, 3n, 1n, content,
  BigInt(secretHash.toString()), index].map(n => new a.Fr(n).toBuffer()))));
const node = {
  getNodeInfo: async () => ({ l1ChainId: 31337, rollupVersion: 1 }),
  getL1ToL2MessageMembershipWitness: async (_block, hash) => {
    assert.equal(hash.toString(), expectedHash.toString());
    return [index];
  },
  getL1ToL2MessageCheckpoint: async () => 1,
  getCheckpointNumber: async () => 1,
  findLeavesIndexes: async () => [undefined],
};
assert.equal((await browser.computeL1ToL2MsgHash(node, recipient, amount, secret, index)).toString(), expectedHash.toString());
await browser.preflightL1ToL2Message(node, recipient, amount, secret, index, 'test');
// Application contracts must never be registered with the user's account seed.
const registrations = [];
browser.window.__aztec = { ...a, BaseWallet: class {
  registerContract(...args) { registrations.push(args); }
} };
const adapter = browser.createAztecWallet({}, {}, {}, 'test');
const ownAddress = {};
adapter._accountManager = { address: { equals: address => address === ownAddress } };
adapter._secretKey = { privateAccountSeed: true };
await adapter.registerContract({ address: ownAddress }, {});
await adapter.registerContract({ address: {} }, {});
const explicit = {};
await adapter.registerContract({ address: {} }, {}, explicit);
assert.equal(registrations[0][2], adapter._secretKey);
assert.equal(registrations[1][2], undefined);
assert.equal(registrations[2][2], explicit);
// Browser wallet must honor the SDK's NO_WAIT shape and save a recovery hash
// before broadcasting. Otherwise a successful tx looks like a failed post.
const order = [];
const fakeHash = a.TxHash.random();
const gas = new a.Gas(100, 100);
const fees = { gasSettings: a.GasSettings.from({ gasLimits: gas, teardownGasLimits: gas,
  maxFeesPerGas: new a.GasFees(1n, 1n), maxPriorityFeesPerGas: new a.GasFees(0n, 0n) }) };
browser.toAztec = value => String(value);
browser.window.__aztec = { ...a, BaseWallet: class {
  constructor(pxe) { this.pxe = pxe; }
  async completeFeeOptions() { return fees; }
  async simulateViaEntrypoint() { return { gasUsed: { totalGas: gas, teardownGas: gas } }; }
  async createTxExecutionRequestFromPayloadAndFee() { return {}; }
  scopesFrom(...args) { return a.BaseWallet.prototype.scopesFrom.call(this, ...args); }
  senderForTagsFrom(...args) { return a.BaseWallet.prototype.senderForTagsFrom.call(this, ...args); }
} };
const preparedWallet = browser.createAztecWallet({
  proveTx: async (_request, options) => {
    assert.equal(options.scopes.length, 1);
    assert(options.scopes[0].equals(a.AztecAddress.ZERO));
    return { toTx: async () => ({ getTxHash: () => fakeHash }) };
  },
}, {}, {
  sendTx: async () => { order.push('send'); },
  getTxReceipt: async () => { throw new Error('NO_WAIT must not poll'); },
}, 'test');
preparedWallet.onTxPrepared = hash => { assert.equal(hash, fakeHash.toString()); order.push('saved'); };
const immediate = await preparedWallet.sendTx({}, { from: a.AztecAddress.ZERO, wait: a.NO_WAIT });
assert.equal(immediate.txHash.toString(), fakeHash.toString());
assert.deepEqual(order, ['saved', 'send']);
preparedWallet.onTxPrepared = () => { throw new Error('Storage unavailable'); };
await assert.rejects(() => preparedWallet.sendTx({}, { from: a.AztecAddress.ZERO, wait: a.NO_WAIT }), /Storage unavailable/);
assert.deepEqual(order, ['saved', 'send']);
console.log('PASS embedded Noir WASM (no URL/fetch), SDK exports, artifact/class derivation, store persistence, network isolation and Buffer-free message helpers');
