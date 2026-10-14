// Prepare chain/WASM assets. React UI compilation and routing belong to Vite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';
import { buildDFReport } from './build-df-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'apps/dist');
const source = path.join(root, 'apps/src/df-billboard-test');
fs.mkdirSync(dist, { recursive: true });
const artifacts = {
  core: '.local/df-upstream/contracts/target/core-Core.json',
  config: '.local/df-upstream/contracts/target/config-Config.json',
  player: '.local/df-upstream/contracts/target/player-PlayerStorage.json',
  planet: '.local/df-upstream/contracts/target/planet-PlanetStorage.json',
  board: 'df-billboard/target/df_billboard-DFBillboard.json',
};
for (const [name, relative] of Object.entries(artifacts)) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) throw new Error(`Missing ${target}. Run npm run build:df and npm run build:df:core first.`);
  fs.copyFileSync(target, path.join(dist, `df-${name}-artifact.json`));
}
fs.copyFileSync(fileURLToPath(import.meta.resolve('@aztec/noir-contracts.js/artifacts/sponsored_fpc_contract-SponsoredFPC')),
  path.join(dist, 'df-sponsor-artifact.json'));
await build({
  entryPoints: [path.join(root, 'scripts/df-hash-entry.mjs')],
  outfile: path.join(dist, 'df-hash.js'),
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: '__dfHash',
  target: 'es2022',
  conditions: ['browser'],
  loader: { '.wasm': 'binary' },
  plugins: [polyfillNode()],
  logLevel: 'warning',
});
await build({
  entryPoints: [path.join(source, 'toxicity.worker.ts')],
  outfile: path.join(dist, 'df-toxicity.worker.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
});
const ortDist = path.join(root, 'node_modules/onnxruntime-web/dist');
fs.mkdirSync(path.join(dist, 'onnx'), { recursive: true });
for (const file of fs.readdirSync(ortDist).filter(file => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(file))) {
  fs.copyFileSync(path.join(ortDist, file), path.join(dist, 'onnx', file));
}
for (const name of ['aztec_bundle.js', 'main.worker.js', 'thread.worker.js']) {
  const sourceFile = path.join(root, 'shared', name);
  if (!fs.existsSync(sourceFile)) throw new Error(`Missing ${sourceFile}. Run npm run build:sdk.`);
  fs.copyFileSync(sourceFile, path.join(dist, name));
}
fs.copyFileSync(path.join(root, 'shared/helpers.js'), path.join(dist, 'df-helpers.js'));
fs.copyFileSync(path.join(root, 'shared/aztec-lib.js'), path.join(dist, 'df-aztec-lib.js'));
buildDFReport(root, dist);
// Compatibility for static hosts as well as Vite's redirect middleware.
for (const [file, route] of [['df-billboard-test.html', '/'], ['df-billboard-report.html', '/reports']]) {
  fs.writeFileSync(path.join(dist, file), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${route}"><title>Dark Forest Billboard</title></head><body><a href="${route}">继续访问</a></body></html>`);
}
console.log('Prepared DF runtime assets in apps/dist');
