import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { digest, publicManifest } from './state.mjs';
import { buildRelease, checkUploadBudget, netlifyConfig } from './release.mjs';

test('Netlify applies isolation headers globally and rewrites only known pages', () => {
  const config = netlifyConfig();
  assert.equal(config._headers, '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-cache\n');
  const rules = config._redirects.trim().split('\n').map(line => line.split(/\s+/));
  const pages = ['/reports', '/reports/', '/fee-lab', '/fee-lab/', '/l1-post-lab', '/l1-post-lab/'];
  // Exact allowlist also excludes wildcard rewrites of missing runtime assets.
  assert.deepEqual(rules, pages.map(page => [page, '/index.html', '200']));
});

test('invalid hosting targets fail before reading config, creating output or connecting', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'billboard-target-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const destination = path.join(temp, 'release');
  await assert.rejects(buildRelease({}, destination, 'unknown'), /target must be/);
  assert(!fs.existsSync(destination));
  for (const [action, target, message] of [
    ['release', 'unknown', /target must be/],
    ['plan', 'netlify', /only allowed with release/],
  ]) {
    const result = spawnSync(process.execPath, [new URL('../deploy-billboard-testnet.mjs', import.meta.url).pathname,
      action, '--target', target, '--config', path.join(temp, 'does-not-exist.json'), '--out', destination,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert(!fs.existsSync(destination));
  }
});

test('upload budget counts nested assets and config, and rejects oversized output', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'billboard-budget-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'static'));
  const file = path.join(temp, 'static/runtime.wasm');
  fs.writeFileSync(file, '123');
  assert.deepEqual(checkUploadBudget(temp, '{}'), { bytes: 5, files: 2 });
  // Sparse fixture: no large buffer or network required.
  fs.truncateSync(file, 99_999_998);
  assert.equal(checkUploadBudget(temp, '{}').bytes, 100_000_000);
  fs.truncateSync(file, 99_999_999);
  assert.throws(() => checkUploadBudget(temp, '{}'), /100 MB upload budget/);
});

// Explicit offline packaging smoke test: fixture addresses, no RPC, no keys,
// no deployment. Delete the fixture package after inspection.
for (const target of ['vercel', 'netlify']) test(`isolated ${target} package contains runtime assets, not local data or secrets`, {
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
  // Omitting the target must continue to produce the existing Vercel layout.
  await buildRelease(fixture, destination, target === 'vercel' ? undefined : target);
  const output = target === 'vercel' ? path.join(destination, '.vercel/output') : destination;
  const dist = path.join(output, target === 'vercel' ? 'static' : 'public');
  if (target === 'vercel') {
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'config.json'))).version, 3);
    assert(!fs.existsSync(path.join(dist, '_headers')));
  } else {
    for (const [name, content] of Object.entries(netlifyConfig())) assert.equal(fs.readFileSync(path.join(dist, name), 'utf8'), content);
    assert(!fs.existsSync(path.join(destination, '.vercel')));
  }
  await assert.rejects(buildRelease(fixture, destination, target), /already exists/);
  const files = fs.readdirSync(dist, { recursive: true }).filter(file => fs.statSync(path.join(dist, file)).isFile());
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(dist, file)).size, 0);
  for (const name of ['index.html', 'df-local.json', 'df-board-artifact.json', 'df-sponsor-artifact.json', 'aztec_bundle.js', 'df-wallet-runtime.js', 'main.worker.js', 'thread.worker.js', 'df-toxicity.worker.js']) assert(files.includes(name), `Missing ${name}`);
  assert.deepEqual(files.filter(file => file.startsWith('onnx/')).sort(), [
    'onnx/ort-wasm-simd-threaded.asyncify.mjs',
    'onnx/ort-wasm-simd-threaded.asyncify.wasm',
  ]);
  assert(!files.some(file => file.endsWith('.map')));
  if (target === 'vercel') assert(bytes + fs.statSync(path.join(output, 'config.json')).size <= 100_000_000);
  assert(files.every(file => !/(?:deployment|private|\.env|wallets|test-report)/.test(file)));
  const manifest = fs.readFileSync(path.join(dist, 'df-local.json'), 'utf8');
  assert(!manifest.includes('DO-NOT-PUBLISH'));
  assert(!manifest.includes('127.0.0.1'));
  assert.equal(digest(fs.readFileSync(path.join(dist, 'df-board-artifact.json'))), digest(board));
  // Rebuilding an existing output must retire only obsolete generated runtimes.
  const staleRuntime = path.join(dist, 'onnx/ort-wasm-simd-threaded.jspi.wasm');
  const unrelated = path.join(dist, 'onnx/keep.txt');
  fs.writeFileSync(staleRuntime, 'old generated backend');
  fs.writeFileSync(unrelated, 'leave unrelated files alone');
  const rebuild = spawnSync(process.execPath, [new URL('../build-df-harness.mjs', import.meta.url).pathname], {
    env: { ...process.env, BILLBOARD_OUTPUT_DIR: dist }, encoding: 'utf8',
  });
  assert.equal(rebuild.status, 0, rebuild.stderr);
  assert(!fs.existsSync(staleRuntime));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'leave unrelated files alone');
  assert(fs.existsSync(path.join(dist, 'onnx/ort-wasm-simd-threaded.asyncify.wasm')));
  assert.equal(fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8') : null, before);
  console.log(`Verified offline ${target} fixture: ${files.length} public files, ${(bytes / 1_000_000).toFixed(2)} MB; local deployment unchanged.`);
});
