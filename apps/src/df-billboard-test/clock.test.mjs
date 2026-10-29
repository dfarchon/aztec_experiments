import assert from "node:assert/strict";
import test from "node:test";

import { syncLocalClock } from "../../../scripts/sync-df-clock.mjs";

function fixture() {
  let timestamp = 1000;
  const calls = [];
  const info = {
    l1ChainId: 31337,
    nodeVersion: "6.0.0",
    realProofs: false,
  };
  const deployment = {
    nodeUrl: "http://127.0.0.1:5180",
    rollupAddress: "rollup",
  };
  const node = {
    getNodeInfo: async () => info,
    getL1ContractAddresses: async () => ({ rollupAddress: "rollup" }),
    getBlock: async () => ({ header: { globalVariables: { timestamp } } }),
  };
  const debug = {
    warpL2TimeAtLeastTo: async (target) => {
      calls.push(target);
      timestamp = target;
    },
  };
  return { node, debug, deployment, calls, info };
}
test("local clock refreshes stale anchors but never rewinds or advances fresh blocks", async () => {
  const { node, debug, deployment, calls } = fixture();
  assert.equal(await syncLocalClock(node, debug, deployment, 1100), false);
  assert.equal(await syncLocalClock(node, debug, deployment, 900), false);
  assert.equal(await syncLocalClock(node, debug, deployment, 1400), true);
  assert.deepEqual(calls, [1400]);
});
test("clock refuses remote nodes, other deployments and real-proof networks", async () => {
  const { node, debug, deployment, info, calls } = fixture();
  await assert.rejects(
    syncLocalClock(
      node,
      debug,
      { ...deployment, nodeUrl: "https://example.com" },
      2000
    ),
    /loopback/
  );
  await assert.rejects(
    syncLocalClock(
      node,
      debug,
      { ...deployment, rollupAddress: "other" },
      2000
    ),
    /mismatch/
  );
  info.realProofs = true;
  await assert.rejects(
    syncLocalClock(node, debug, deployment, 2000),
    /mismatch/
  );
  assert.deepEqual(calls, []);
});
