// Prepare chain/WASM assets. React UI compilation and routing belong to Vite.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = process.env.BILLBOARD_OUTPUT_DIR ? path.resolve(process.env.BILLBOARD_OUTPUT_DIR) : path.join(root, 'web/dist');
fs.mkdirSync(dist, { recursive: true });
// Vite writes content-hashed bundles here. Rebuild them from scratch while
// preserving generated root runtime assets and the local deployment manifest.
fs.rmSync(path.join(dist, 'assets'), { recursive: true, force: true });
const boardArtifact = path.join(root, 'df-billboard/target/df_billboard-DFBillboard.json');
if (!fs.existsSync(boardArtifact)) throw new Error(`Missing ${boardArtifact}. Run npm run build:contract first.`);
// Keep the artifact matching the running deployment until it is redeployed.
const publishedArtifact = path.join(dist, 'df-board-artifact.json');
const manifestFile = path.join(dist, 'df-local.json');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expected = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)).boardArtifactHash : null;
if (!expected || digest(boardArtifact) === expected) {
  fs.copyFileSync(boardArtifact, publishedArtifact);
} else if (!fs.existsSync(publishedArtifact) || digest(publishedArtifact) !== expected) {
  throw new Error('Compiled board differs from the local deployment; redeploy the harness before preparing its assets.');
}
// Public reads need only storage slots, not the 2+ MB proving artifact.
const { storageLayout } = loadContractArtifact(JSON.parse(fs.readFileSync(publishedArtifact, 'utf8')));
fs.writeFileSync(path.join(dist, 'df-read-config.json'), JSON.stringify({
  boardArtifactHash: digest(publishedArtifact),
  storageLayout: Object.fromEntries(['post_count', 'post_lengths', 'post_data', 'post_timestamps'].map(key => [key, storageLayout[key]])),
}) + '\n');
fs.copyFileSync(fileURLToPath(import.meta.resolve('@aztec-labs/noir-contracts.js/artifacts/sponsored_fpc_contract-SponsoredFPC')),
  path.join(dist, 'df-sponsor-artifact.json'));
for (const obsolete of [
  'billboard-readme.md',
  'censor.html',
  'deploy.html',
  'df-billboard-app.css',
  'df-billboard-app.css.map',
  'df-billboard-app.js',
  'df-billboard-app.js.map',
  'df-billboard-report.css',
  'df-billboard-report.js',
  'df-config-artifact.json',
  'df-core-artifact.json',
  'df-fee-lab.json',
  'df-hash.js',
  'df-helpers.js',
  'df-aztec-lib.js',
  'df-l1-post-artifact.json',
  'df-l1-post-lab.json',
  'df-message.js',
  'df-moderation.js',
  'df-planet-artifact.json',
  'df-player-artifact.json',
  'df-test-report.json',
  'df-toxicity.worker.js',
  'df-wallet-runtime.js',
  'fee-juice.html',
  'thread_worker.js',
  'user.html',
]) {
  fs.rmSync(path.join(dist, obsolete), { force: true });
}
for (const obsoleteDirectory of ['onnx', 'zkapi']) {
  fs.rmSync(path.join(dist, obsoleteDirectory), { recursive: true, force: true });
}
for (const name of ['aztec_bundle.js', 'main.worker.js', 'thread.worker.js']) {
  const sourceFile = path.join(root, 'runtime/generated', name);
  if (!fs.existsSync(sourceFile)) throw new Error(`Missing ${sourceFile}. Run npm run build:runtime.`);
  fs.copyFileSync(sourceFile, path.join(dist, name));
}
// Compatibility for static hosts as well as Vite's redirect middleware.
for (const [file, route] of [['df-billboard-test.html', '/'], ['df-billboard-report.html', '/']]) {
  fs.writeFileSync(path.join(dist, file), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${route}"><title>Dark Forest Billboard</title></head><body><a href="${route}">Continue to Billboard</a></body></html>`);
}
console.log(`Prepared Notch runtime assets in ${dist}`);
