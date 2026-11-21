// Run the source frontend against an existing public deployment, without local chains.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [network, ...viteArgs] = process.argv.slice(2);
assert(['mainnet', 'testnet'].includes(network), 'Choose mainnet or testnet');
const manifest = JSON.parse(fs.readFileSync(path.join(root, `deployments/${network}.json`), 'utf8'));
assert.equal(manifest.environment, network);
assert.equal(manifest.chainId, network === 'mainnet' ? 1 : 11155111);
assert.equal(manifest.l1Stake.chainId, manifest.chainId);
const artifact = path.join(root, 'deployments/artifacts/notch-board.json');
assert.equal(createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), manifest.boardArtifactHash,
  'Public artifact does not match the deployed board');
const output = path.join(root, `.local/frontend/${network}`);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'df-local.json'), JSON.stringify(manifest, null, 2) + '\n');
const env = { ...process.env, BILLBOARD_OUTPUT_DIR: output, BILLBOARD_BOARD_ARTIFACT: artifact };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
      else if (code === 0) resolve();
      else reject(new Error(`${args[0]} exited with code ${code}`));
    });
  });
}

console.log(`Notch ${network}: ${manifest.nodeUrl}\nBoard: ${manifest.board}`);
if (network === 'mainnet') console.log('Mainnet transactions use real ETH.');
await run(['scripts/build-sdk.mjs']);
await run(['scripts/build-df-harness.mjs']);
await run(['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts', ...viteArgs]);
