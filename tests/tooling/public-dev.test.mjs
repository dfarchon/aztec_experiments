import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root));

test("both public deployments have a versioned, matching board artifact", () => {
  const artifact = read("deployments/artifacts/notch-board.json");
  const hash = createHash("sha256").update(artifact).digest("hex");
  for (const [network, chainId] of [
    ["mainnet", 1],
    ["testnet", 11155111],
  ]) {
    const manifest = JSON.parse(read(`deployments/${network}.json`));
    assert.equal(manifest.environment, network);
    assert.equal(manifest.chainId, chainId);
    assert.equal(manifest.l1Stake.chainId, chainId);
    assert.equal(manifest.boardArtifactHash, hash);
    assert.equal(new URL(manifest.nodeUrl).protocol, "https:");
  }
});

test("dependency installation does not require generated contract or SDK files", () => {
  const { scripts } = JSON.parse(read("package.json"));
  for (const hook of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(scripts[hook], undefined);
});

test("unknown development networks are rejected before asset preparation", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("scripts/dev-network.mjs", root).pathname, "unknown"],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose mainnet or testnet/);
});
