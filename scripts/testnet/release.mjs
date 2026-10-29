import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './state.mjs';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
};
const appRoutes = ['reports', 'fee-lab', 'l1-post-lab'];

export function vercelConfig() {
  return {
    version: 3,
    routes: [
      { src: '/(.*)', headers, continue: true },
      { handle: 'filesystem' },
      // Only actual app routes receive HTML. Missing WASM/JS/JSON stays 404.
      { src: `/(?:${appRoutes.join('|')})/?`, dest: '/index.html' },
      { src: '/.*', status: 404 },
    ],
  };
}

export function netlifyConfig() {
  return {
    _headers: '/*\n' + Object.entries(headers).map(([key, value]) => `  ${key}: ${value}\n`).join(''),
    // No catch-all rewrite: missing runtime assets must remain 404.
    _redirects: appRoutes.flatMap(route => [
      `/${route} /index.html 200\n`,
      `/${route}/ /index.html 200\n`,
    ]).join(''),
  };
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const boardFile = path.join(root, 'df-billboard/target/df_billboard-DFBillboard.json');
// Use decimal MB conservatively, without relying on archive compression.
export function checkUploadBudget(output, configText) {
  const files = fs.readdirSync(output, { recursive: true })
    .filter(file => fs.statSync(path.join(output, file)).isFile());
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(output, file)).size, Buffer.byteLength(configText));
  assert(bytes <= 100_000_000, `Release exceeds Vercel Hobby's 100 MB upload budget: ${bytes} bytes`);
  assert(files.length + 1 <= 15_000, 'Release exceeds Vercel CLI file-count limit');
  return { bytes, files: files.length + 1 };
}

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}): ${args[0]}`)));
});

export async function buildRelease(manifest, destination, target = 'vercel') {
  assert(['vercel', 'netlify'].includes(target), 'Release target must be vercel or netlify');
  assert.equal(manifest.environment, 'testnet');
  assert.equal(digest(fs.readFileSync(boardFile)), manifest.boardArtifactHash, 'Recompile/deploy mismatch; cannot publish');
  assert(!fs.existsSync(destination), 'Release directory already exists; choose a new directory');
  const output = target === 'vercel' ? path.join(destination, '.vercel/output') : destination;
  const dist = path.join(output, target === 'vercel' ? 'static' : 'public');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'df-local.json'), JSON.stringify(manifest, null, 2) + '\n');
  const env = { ...process.env, BILLBOARD_OUTPUT_DIR: dist };
  // Rebuild SDK to prevent stale local runtime assets from entering a release.
  await run(['scripts/build-sdk.mjs'], env);
  await run(['node_modules/typescript/bin/tsc', '-p', 'apps/src/df-billboard-test/tsconfig.json'], env);
  await run(['scripts/build-df-harness.mjs'], env);
  await run(['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/src/df-billboard-test/vite.config.ts'], env);
  assert.equal(digest(fs.readFileSync(path.join(dist, 'df-board-artifact.json'))), manifest.boardArtifactHash);
  if (target === 'netlify') {
    // Hosting rules are emitted only after all build steps succeed.
    for (const [name, content] of Object.entries(netlifyConfig())) fs.writeFileSync(path.join(dist, name), content);
    console.log(`Netlify publish directory: ${dist}\nNot uploaded. Publish only this directory with netlify deploy --no-build --dir public from ${destination}.`);
    return;
  }
  const configText = JSON.stringify(vercelConfig(), null, 2) + '\n';
  const size = checkUploadBudget(output, configText);
  // Write deployable config LAST. A failed build is not a valid release.
  fs.writeFileSync(path.join(output, 'config.json'), configText);
  console.log(`Hobby upload budget: ${(size.bytes / 1_000_000).toFixed(2)} / 100 MB, ${size.files} files (uncompressed).`);
  console.log(`Vercel prebuilt output: ${output}\nNot uploaded. From ${destination}, link the intended Vercel project, then run vercel deploy --prebuilt.`);
}
