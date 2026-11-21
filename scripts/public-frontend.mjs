import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { publicRpc } from './testnet/state.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const publicBoardArtifact = path.join(root, 'deployments/artifacts/notch-board.json');

// Shell/Netlify values take priority over an untracked local file.
export function frontendEnvironment(env = process.env, directory = root) {
  const file = path.join(directory, '.env.local');
  const local = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...local, ...env };
}

export function frontendManifest(network, env = {}) {
  assert(['mainnet', 'testnet'].includes(network), 'Choose mainnet or testnet; set NOTCH_NETWORK for Netlify');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, `deployments/${network}.json`), 'utf8'));
  assert.equal(manifest.kind, 'notch-stake');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.environment, network);
  assert.equal(manifest.chainId, network === 'mainnet' ? 1 : 11155111);
  assert.equal(manifest.l1Stake.chainId, manifest.chainId);
  for (const [key, set] of [
    ['AZTEC_RPC_URL', value => { manifest.nodeUrl = value; }],
    ['L1_RPC_URL', value => { manifest.l1Stake.rpcUrl = value; }],
  ]) {
    if (env[key] === undefined) continue;
    // Do not include endpoint keys or credentials in validation errors.
    try { publicRpc(env[key]); } catch { throw new Error(`${key} must be a public HTTPS URL without basic-auth credentials or a fragment`); }
    set(env[key]);
  }
  return manifest;
}
