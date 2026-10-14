// Local automine stops advancing L1/L2 while idle, but public simulation uses
// elapsed wall time. Keep anchor blocks within DF's 300-second freshness bound.
// Never run against a public network or drive time backwards.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec/stdlib/interfaces/client';

export async function syncLocalClock(node, debug, deployment, now = Math.floor(Date.now() / 1000)) {
  const url = new URL(deployment.nodeUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Clock sync requires a loopback node');
  const info = await node.getNodeInfo();
  const l1 = await node.getL1ContractAddresses();
  if (Number(info.l1ChainId) !== 31337 || info.nodeVersion !== '5.0.1' || info.realProofs !== false ||
      l1.rollupAddress.toString() !== deployment.rollupAddress) throw new Error('Clock sync refused: local deployment mismatch');
  const block = await node.getBlock('latest');
  if (!block) throw new Error('Local L2 block unavailable');
  const before = Number(block.header.globalVariables.timestamp);
  if (now - before < 120) return false;
  await debug.warpL2TimeAtLeastTo(now);
  const after = await node.getBlock('latest');
  if (Number(after?.header.globalVariables.timestamp) < now) throw new Error('Local clock did not advance');
  console.log(`DF local clock synced: ${before} → ${after.header.globalVariables.timestamp}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deployment = JSON.parse(fs.readFileSync(new URL('../apps/dist/df-local.json', import.meta.url)));
  const node = createAztecNodeClient(deployment.nodeUrl);
  const debug = createAztecNodeDebugClient(deployment.nodeUrl);
  await syncLocalClock(node, debug, deployment);
  if (process.argv.includes('--watch')) {
    for (;;) {
      await delay(30_000);
      try { await syncLocalClock(node, debug, deployment); }
      catch (error) { console.error(`DF clock sync failed: ${error.message}`); }
    }
  }
}
