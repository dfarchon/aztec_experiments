import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  frontendEnvironment,
  frontendManifest,
} from "../../scripts/public-frontend.mjs";

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

test("RPC overrides preserve deployment identity and never mutate versioned manifests", () => {
  for (const network of ["mainnet", "testnet"]) {
    const before = read(`deployments/${network}.json`).toString();
    const original = frontendManifest(network);
    const configured = frontendManifest(network, {
      AZTEC_RPC_URL: "https://aztec.example/key-for-test",
      L1_RPC_URL: "https://ethereum.example/?key=test",
    });
    assert.equal(configured.nodeUrl, "https://aztec.example/key-for-test");
    assert.equal(
      configured.l1Stake.rpcUrl,
      "https://ethereum.example/?key=test"
    );
    configured.nodeUrl = original.nodeUrl;
    configured.l1Stake.rpcUrl = original.l1Stake.rpcUrl;
    assert.deepEqual(configured, original);
    assert.equal(read(`deployments/${network}.json`).toString(), before);
  }
});

test("invalid endpoints fail without leaking endpoint credentials", () => {
  for (const value of [
    "",
    "secret-test-value",
    "http://rpc.example",
    "https://user:secret@rpc.example",
    "https://localhost",
    "https://rpc.example/#secret",
  ]) {
    assert.throws(
      () => frontendManifest("mainnet", { AZTEC_RPC_URL: value }),
      (error) => {
        assert.match(error.message, /AZTEC_RPC_URL must be/);
        assert(!error.message.includes("secret"));
        return true;
      }
    );
  }
  assert.throws(() => frontendManifest(undefined), /NOTCH_NETWORK/);
});

test("shell and Netlify values override ignored local settings", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notch-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, ".env.local"),
    'NOTCH_NETWORK=testnet\nAZTEC_RPC_URL="https://local.example/?key=test"\n'
  );
  const env = frontendEnvironment(
    { AZTEC_RPC_URL: "https://shell.example" },
    directory
  );
  assert.equal(env.AZTEC_RPC_URL, "https://shell.example");
  assert.equal(env.NOTCH_NETWORK, "testnet");
  assert.deepEqual(
    frontendEnvironment(
      { NOTCH_NETWORK: "mainnet" },
      path.join(directory, "missing")
    ),
    { NOTCH_NETWORK: "mainnet" }
  );
});
