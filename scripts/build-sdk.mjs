import { build } from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const expected = fs.readFileSync(`${root}/.aztec-version`, 'utf8').trim();
const manifest = JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8'));
for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (!name.startsWith('@aztec/')) continue;
  const installed = JSON.parse(fs.readFileSync(`${root}/node_modules/${name}/package.json`, 'utf8')).version;
  if (version !== expected || installed !== expected) throw new Error(`${name}: expected ${expected}, declared ${version}, installed ${installed}`);
}
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  conditions: ['browser'],
  loader: { '.wasm': 'binary' },
  define: { 'import.meta.url': '__billboardModuleUrl' },
  banner: { js: 'var __billboardModuleUrl = typeof document !== "undefined" ? document.currentScript?.src : globalThis.location?.href;' },
  plugins: [polyfillNode()],
  logLevel: 'info',
};
await build({ ...common, entryPoints: ['shared/sdk-entry.mjs'], outfile: 'shared/aztec_bundle.js', globalName: '__aztec' });
// Bundle upstream worker entrypoints directly, rather than patching generated
// variable names or extracting classes from an opaque SDK bundle.
for (const [source, output] of [
  ['bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_main/factory/browser/main.worker.js', 'main.worker.js'],
  ['bb.js/dest/browser/barretenberg_wasm/barretenberg_wasm_thread/factory/browser/thread.worker.js', 'thread.worker.js'],
]) {
  await build({ ...common, entryPoints: [`node_modules/@aztec/${source}`], outfile: `shared/${output}` });
}
