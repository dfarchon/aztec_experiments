import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './state.mjs';

export function vercelConfig() {
  return {
    version: 3,
    routes: [
      { src: '/(.*)', headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      }, continue: true },
      { handle: 'filesystem' },
      // Only actual app routes receive HTML. Missing WASM/JS/JSON stays 404.
      { src: '/(?:reports|fee-lab|l1-post-lab)/?', dest: '/index.html' },
      { src: '/.*', status: 404 },
    ],
  };
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const boardFile = path.join(root, 'df-billboard/target/df_billboard-DFBillboard.json');
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}): ${args[0]}`)));
});

export async function buildRelease(manifest, destination) {
  assert.equal(manifest.environment, 'testnet');
  assert.equal(digest(fs.readFileSync(boardFile)), manifest.boardArtifactHash, 'Recompile/deploy mismatch; cannot publish');
  assert(!fs.existsSync(destination), 'Release directory already exists; choose a new directory');
  const output = path.join(destination, '.vercel/output');
  const dist = path.join(output, 'static');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'df-local.json'), JSON.stringify(manifest, null, 2) + '\n');
  const env = { ...process.env, BILLBOARD_OUTPUT_DIR: dist };
  // Rebuild SDK to prevent stale local runtime assets from entering a release.
  await run(['scripts/build-sdk.mjs'], env);
  await run(['node_modules/typescript/bin/tsc', '-p', 'apps/src/df-billboard-test/tsconfig.json'], env);
  await run(['scripts/build-df-harness.mjs'], env);
  await run(['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/src/df-billboard-test/vite.config.ts'], env);
  assert.equal(digest(fs.readFileSync(path.join(dist, 'df-board-artifact.json'))), manifest.boardArtifactHash);
  // Write deployable config LAST. A failed build is not a valid release.
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify(vercelConfig(), null, 2) + '\n');
  console.log(`Vercel prebuilt output: ${output}\nNot uploaded. From ${destination}, link the intended Vercel project, then run vercel deploy --prebuilt.`);
}
