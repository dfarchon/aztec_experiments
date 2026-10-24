import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, publicManifest } from './state.mjs';
import { buildRelease } from './release.mjs';

// Explicit offline packaging smoke test: fixture addresses, no RPC, no keys,
// no deployment. Delete the fixture package after inspection.
test('isolated Vercel package contains runtime assets, not local data or secrets', {
  timeout: 180_000,
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'billboard-release-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const board = fs.readFileSync(new URL('../../df-billboard/target/df_billboard-DFBillboard.json', import.meta.url));
  const localFile = new URL('../../apps/dist/df-local.json', import.meta.url);
  const before = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8') : null;
  const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
  const fixture = publicManifest({ schemaVersion: 1,
    binding: { config, boardArtifactHash: digest(board), boardClassId: 'offline-fixture', sponsoredFpc: 'offline-fixture' },
    account: { secret: 'DO-NOT-PUBLISH-THIS-FIXTURE-SECRET' },
    l1: { confirmed: true, address: 'offline-fixture', runtimeCodeHash: 'offline-fixture', raw: 'DO-NOT-PUBLISH' },
    l2: { confirmed: true, address: 'offline-fixture', hash: 'offline-fixture', raw: 'DO-NOT-PUBLISH' },
  });
  const destination = path.join(temp, 'release');
  await buildRelease(fixture, destination);
  const output = path.join(destination, '.vercel/output');
  const dist = path.join(output, 'static');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'config.json'))).version, 3);
  const files = fs.readdirSync(dist, { recursive: true }).filter(file => fs.statSync(path.join(dist, file)).isFile());
  for (const name of ['index.html', 'df-local.json', 'df-board-artifact.json', 'df-sponsor-artifact.json', 'aztec_bundle.js', 'df-wallet-runtime.js', 'main.worker.js', 'thread.worker.js', 'df-toxicity.worker.js']) assert(files.includes(name), `Missing ${name}`);
  assert(files.some(file => file.startsWith('onnx/') && file.endsWith('.wasm')));
  assert(files.every(file => !/(?:deployment|private|\.env|wallets|test-report)/.test(file)));
  const manifest = fs.readFileSync(path.join(dist, 'df-local.json'), 'utf8');
  assert(!manifest.includes('DO-NOT-PUBLISH'));
  assert(!manifest.includes('127.0.0.1'));
  assert.equal(digest(fs.readFileSync(path.join(dist, 'df-board-artifact.json'))), digest(board));
  if (before !== null) assert.equal(fs.readFileSync(localFile, 'utf8'), before);
  console.log(`Verified offline release fixture: ${files.length} public files; local deployment unchanged.`);
});
