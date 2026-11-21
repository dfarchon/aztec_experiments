import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { publicNetwork } from '../../protocol/networks.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function publicRpc(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'Public RPC must be HTTPS without embedded credentials');
  assert(!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Loopback RPC is not a public network');
  return value;
}

export function checkNetwork(config, info, chainId) {
  publicRpc(config.nodeUrl);
  publicRpc(config.l1RpcUrl);
  const policy = publicNetwork(config.environment);
  assert.equal(config.chainId, policy.chainId, 'L1 chain does not match the selected environment');
  if (config.environment === 'mainnet') assert(config.sponsoredFpc, 'Mainnet requires an explicit Sponsored FPC address');
  assert.equal(Number(chainId), config.chainId, 'L1 RPC is on the wrong chain');
  assert.equal(info.l1ChainId, config.chainId, 'Aztec is on the wrong L1');
  assert.equal(info.nodeVersion, config.nodeVersion, 'Aztec version changed');
  assert.equal(info.realProofs, true, 'Synthetic proofs are forbidden');
  assert.equal(String(info.rollupVersion), config.rollupVersion, 'Rollup version changed');
  assert.equal(info.l1ContractAddresses.rollupAddress.toString().toLowerCase(), config.rollupAddress.toLowerCase(), 'Rollup address changed');
  assert.equal(info.l1ContractAddresses.inboxAddress.toString().toLowerCase(), config.inboxAddress.toLowerCase(), 'Inbox address changed');
}

// Private journal: signed transactions and the generated Aztec deployment account.
// fsync + same-directory rename prevents a partial checkpoint from being used.
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected a regular private file');
  assert.equal(stat.mode & 0o077, 0, `Restrict file permissions to 600: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid private JSON file; contents are omitted'); }
}

export function openJournal(file, binding) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.closeSync(fd);
  try {
    const state = fs.existsSync(file) ? readPrivateJson(file) : { schemaVersion: 1, binding };
    assert.equal(state.schemaVersion, 1, 'Unsupported deployment journal');
    assert.deepEqual(state.binding, binding, 'Network/config/artifacts changed; do not reuse this deployment journal');
    return { state, save: () => atomicJson(file, state), close: () => fs.unlinkSync(lock) };
  } catch (error) {
    fs.unlinkSync(lock);
    throw error;
  }
}

// Always checkpoint a signed transaction BEFORE broadcasting it. Resume only the
// exact recorded transaction; never silently replace a pending/reverted deploy.
export async function runStage(journal, name, adapter) {
  let stage = journal.state[name];
  if (!stage) {
    stage = await adapter.prepare();
    journal.state[name] = stage;
    journal.save();
  }
  await adapter.validate(stage);
  let receipt = await adapter.receipt(stage);
  if (!receipt) {
    await adapter.broadcast(stage);
    receipt = await adapter.wait(stage);
  }
  assert(receipt, `${name}: confirmation timed out; resume with the same journal`);
  const result = await adapter.verify(stage, receipt);
  Object.assign(stage, result, { confirmed: true });
  journal.save();
  return stage;
}

export function publicManifest(state) {
  assert.equal(state.schemaVersion, 1);
  assert(state.l1?.confirmed && state.l2?.confirmed && state.bind?.confirmed, 'Portal, board and binding must be confirmed before export');
  const { config, boardArtifactHash, boardClassId, sponsoredFpc } = state.binding;
  // Explicit allowlist. Never spread the private journal into public output.
  return {
    kind: 'notch-stake', schemaVersion: 2, environment: config.environment ?? 'testnet',
    nodeUrl: publicRpc(config.nodeUrl), chainId: config.chainId,
    rollupVersion: config.rollupVersion, rollupAddress: config.rollupAddress,
    board: state.l2.address, boardArtifactHash, boardClassId,
    sponsoredFpc, sponsorSalt: state.binding.sponsorSalt ?? '0', deploymentTx: state.l2.hash,
    l1Stake: {
      chainId: config.chainId, rpcUrl: publicRpc(config.l1RpcUrl),
      portal: state.l1.address, inbox: config.inboxAddress,
      runtimeCodeHash: state.l1.runtimeCodeHash,
      deploymentBlock: state.l1.blockNumber,
    },
  };
}
