// Prepare chain/WASM assets. React UI compilation and routing belong to Vite.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildDFReport } from './build-df-report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'apps/dist');
const source = path.join(root, 'apps/src/df-billboard-test');
fs.mkdirSync(dist, { recursive: true });
const boardArtifact = path.join(root, 'df-billboard/target/df_billboard-DFBillboard.json');
if (!fs.existsSync(boardArtifact)) throw new Error(`Missing ${boardArtifact}. Run npm run build:df first.`);
// Keep a running deployment's matching artifact while an isolated experiment
// compiles a newer class. Its deployment publishes its own artifact/manifest.
const publishedArtifact = path.join(dist, 'df-board-artifact.json');
const manifestFile = path.join(dist, 'df-local.json');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expected = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)).boardArtifactHash : null;
if (!expected || digest(boardArtifact) === expected) {
  fs.copyFileSync(boardArtifact, publishedArtifact);
} else if (!fs.existsSync(publishedArtifact) || digest(publishedArtifact) !== expected) {
  throw new Error('Compiled board differs from the local deployment; redeploy the harness before preparing its assets.');
}
fs.copyFileSync(fileURLToPath(import.meta.resolve('@aztec/noir-contracts.js/artifacts/sponsored_fpc_contract-SponsoredFPC')),
  path.join(dist, 'df-sponsor-artifact.json'));
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
console.log('Prepared standalone billboard runtime assets in apps/dist');
