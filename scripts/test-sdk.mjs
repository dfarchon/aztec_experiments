import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';

// Match the browser/CLI WASM path instead of initializing native proving CRS.
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(new URL('../shared/aztec_bundle.js', import.meta.url), 'utf8'));
const a = globalThis.__aztec;
assert.equal(a.SDK_VERSION, '5.0.1');
// Noir initialization must work without a document URL or any runtime fetch.
// In the old build, wallet sync failed later when the simulator fetched WASM.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected fetch during embedded Noir initialization'); };
try {
  await Promise.all([a.initializeNoirRuntime(), a.initializeNoirRuntime()]);
} finally {
  globalThis.fetch = originalFetch;
}
for (const name of ['createPXE', 'Contract', 'BaseWallet', 'SchnorrInitializerlessAccountContract', 'createIndexedDBStore']) {
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
console.log('PASS embedded Noir WASM (no URL/fetch), SDK exports, artifact/class derivation, store persistence, network isolation and Buffer-free message helpers');
