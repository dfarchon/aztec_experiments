// Build the deployed frontend from public, versioned data; no keys or private journal are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRelease } from './testnet/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deployments/mainnet.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'scripts/mainnet/config.json'), 'utf8'));
assert.equal(manifest.kind, 'notch-stake');
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.environment, 'mainnet');
assert.equal(manifest.chainId, 1);
assert.equal(manifest.l1Stake.chainId, 1);
for (const key of ['nodeUrl', 'rollupVersion', 'rollupAddress', 'sponsoredFpc']) {
  assert.equal(manifest[key].toLowerCase(), config[key].toLowerCase(), `Mainnet manifest/config mismatch: ${key}`);
}
assert.equal(manifest.l1Stake.inbox.toLowerCase(), config.inboxAddress.toLowerCase());
assert.equal(manifest.l1Stake.rpcUrl, config.l1RpcUrl);
await buildRelease(manifest, path.resolve(values.out ?? path.join(root, '.local/releases/notch-mainnet')), 'netlify');
