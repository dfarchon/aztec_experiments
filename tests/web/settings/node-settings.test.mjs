import assert from "node:assert/strict";
import test from "node:test";

import { Interface, keccak256 } from "ethers";

import { validateRpc } from "../../../web/src/app/network.ts";
import { testL1RpcConnection } from "../../../web/src/features/settings/l1-connection.ts";
import { testNodeConnection } from "../../../web/src/features/settings/node-connection.ts";
import {
  applyL1RpcPreference,
  applyNodePreference,
  l1RpcPreferenceKey,
  nodePreferenceKey,
  readL1RpcPreference,
  readNodePreference,
  saveL1RpcPreference,
  saveNodePreference,
} from "../../../web/src/features/settings/node-preferences.ts";
import { accountStorageKey } from "../../../web/src/features/wallet/account-storage.ts";
import { portalABI } from "../../../web/src/features/wallet/portal.ts";
import { accountRecoveryMessage } from "../../../web/src/features/wallet/wallet-recovery.ts";

const base = {
  kind: "notch-stake",
  schemaVersion: 2,
  environment: "mainnet",
  nodeUrl: "https://default.example",
  rollupAddress: "0xrollup",
  rollupVersion: "42",
  board: "0xboard",
  boardClassId: "0xclass",
  l1Stake: {
    chainId: 1,
    deploymentBlock: 10,
    inbox: "0xinbox",
    portal: "0xportal",
    rpcUrl: "https://l1.example",
    runtimeCodeHash: keccak256("0x6000"),
  },
};
const nodeInfo = () => ({
  l1ChainId: 1,
  nodeVersion: "6.0.0",
  realProofs: true,
  rollupVersion: "42",
  l1ContractAddresses: { rollupAddress: "0xrollup", inboxAddress: "0xinbox" },
});
function memory() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

test("RPC overrides change transports without changing account or deployment identity", () => {
  const store = memory();
  const nodeChoice = { enabled: true, url: "http://localhost:8080" };
  const l1Choice = { enabled: true, url: "http://localhost:8545" };
  const before = JSON.stringify(base);
  saveNodePreference(store, base, nodeChoice);
  saveL1RpcPreference(store, base, l1Choice);
  const result = applyL1RpcPreference(
    applyNodePreference(base, readNodePreference(store, base)),
    readL1RpcPreference(store, base)
  );
  assert.equal(result.nodeUrl, nodeChoice.url);
  assert.equal(result.customNode, true);
  assert.equal(result.l1Stake.rpcUrl, l1Choice.url);
  assert.equal(result.l1Stake.portal, base.l1Stake.portal);
  assert.equal(result.customL1Rpc, true);
  assert.equal(result.walletL1RpcUrl, base.l1Stake.rpcUrl);
  assert.equal(
    accountStorageKey(result, "0xPayer"),
    accountStorageKey(base, "0xPayer")
  );
  assert.equal(
    accountRecoveryMessage(result, "0xPayer"),
    accountRecoveryMessage(base, "0xPayer")
  );
  assert.equal(JSON.stringify(base), before);
  assert.equal(
    readNodePreference(store, { ...base, environment: "testnet" }).enabled,
    false
  );
  assert.equal(
    readNodePreference(store, { ...base, rollupAddress: "0xother" }).enabled,
    false
  );
  assert.equal(
    applyNodePreference(base, { ...nodeChoice, enabled: false }).nodeUrl,
    base.nodeUrl
  );
  assert.equal(
    applyL1RpcPreference(base, { ...l1Choice, enabled: false }).l1Stake.rpcUrl,
    base.l1Stake.rpcUrl
  );
  assert.equal(
    readL1RpcPreference(store, {
      ...base,
      l1Stake: { ...base.l1Stake, portal: "0xother" },
    }).enabled,
    false
  );
  assert.match(l1RpcPreferenceKey(base), /mainnet\/1\/0xportal/);
});

test("corrupt or inaccessible preferences do not damage account data or defaults", () => {
  const store = memory();
  store.setItem(nodePreferenceKey(base), '{"enabled":"true","url":42}');
  assert.equal(readNodePreference(store, base).enabled, false);
  store.setItem(nodePreferenceKey(base), "bad JSON");
  assert.equal(readNodePreference(store, base).enabled, false);
  assert.equal(
    readNodePreference(
      {
        getItem: () => {
          throw Error("blocked");
        },
      },
      base
    ).enabled,
    false
  );
  assert.throws(
    () =>
      saveNodePreference(
        {
          setItem: () => {
            throw Error("quota");
          },
        },
        base,
        { enabled: true, url: "https://node.example" }
      ),
    /quota/
  );
});

test("mainnet localhost is an explicit transport exception, not a change of chain", () => {
  for (const url of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ]) {
    assert.throws(() => validateRpc(url, "mainnet"));
    assert.doesNotThrow(() => validateRpc(url, "mainnet", true));
  }
  for (const url of [
    "http://remote.example",
    "http://192.168.1.2",
    "https://user:pass@node.example",
    "javascript:alert(1)",
    "https://node.example/#secret",
  ]) {
    assert.throws(() => validateRpc(url, "mainnet", true));
  }
});

test("connection validation checks node identity and board class before activation", async (t) => {
  const requests = [];
  let info = nodeInfo(),
    contract = { currentContractClassId: "0xclass" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, ...request });
    return Response.json({
      id: request.id,
      result: request.method === "node_getNodeInfo" ? info : contract,
    });
  });
  assert.equal(
    await testNodeConnection(base, "  http://localhost:8080  "),
    "http://localhost:8080"
  );
  assert.deepEqual(
    requests.map((x) => x.method),
    ["node_getNodeInfo", "node_getContract"]
  );
  for (const wrong of [
    { l1ChainId: 11155111 },
    { nodeVersion: "7.0.0" },
    { rollupVersion: "43" },
    { realProofs: false },
    {
      l1ContractAddresses: { rollupAddress: "other", inboxAddress: "0xinbox" },
    },
  ]) {
    info = { ...nodeInfo(), ...wrong };
    await assert.rejects(
      testNodeConnection(base, "https://node.example"),
      /Node .* mismatch/
    );
  }
  info = nodeInfo();
  contract = { currentContractClassId: "wrong" };
  await assert.rejects(
    testNodeConnection(base, "https://node.example"),
    /expected Notch contract/
  );
});

test("L1 RPC validation checks chain, block, Portal code and binding", async (t) => {
  const portal = new Interface(portalABI);
  const deployment = {
    ...base,
    board: `0x${"b".repeat(64)}`,
    rollupVersion: "42",
    l1Stake: {
      ...base.l1Stake,
      portal: `0x${"1".repeat(40)}`,
      inbox: `0x${"2".repeat(40)}`,
    },
  };
  let chainId = 1n,
    blockNumber = 20n,
    code = "0x6000",
    board = deployment.board,
    inbox = deployment.l1Stake.inbox,
    version = 42n,
    maximum = 2_000_000_000_000_000n;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    let result;
    if (request.method === "eth_chainId") result = `0x${chainId.toString(16)}`;
    else if (request.method === "eth_blockNumber")
      result = `0x${blockNumber.toString(16)}`;
    else if (request.method === "eth_getCode") result = code;
    else if (request.method === "eth_call") {
      const fn = [
        ["board", board],
        ["INBOX", inbox],
        ["ROLLUP_VERSION", version],
        ["MAX_STAKE", maximum],
      ].find(([name]) =>
        request.params[0].data.startsWith(
          portal.getFunction(name).selector.toLowerCase()
        )
      );
      result = portal.encodeFunctionResult(fn[0], [fn[1]]);
    } else throw new Error(`Unexpected method ${request.method}`);
    return Response.json({ id: request.id, jsonrpc: "2.0", result });
  });
  assert.equal(
    await testL1RpcConnection(deployment, "http://localhost:8545"),
    "http://localhost:8545"
  );
  for (const change of [
    () => (chainId = 11155111n),
    () => (blockNumber = 9n),
    () => (code = "0x6001"),
    () => (board = `0x${"c".repeat(64)}`),
    () => (inbox = `0x${"3".repeat(40)}`),
    () => (version = 43n),
    () => (maximum = 1n),
  ]) {
    const previous = {
      chainId,
      blockNumber,
      code,
      board,
      inbox,
      version,
      maximum,
    };
    change();
    await assert.rejects(
      testL1RpcConnection(deployment, "http://localhost:8545"),
      /L1|Portal|Rollup|stake policy/
    );
    ({ chainId, blockNumber, code, board, inbox, version, maximum } = previous);
  }
});

test("CORS, invalid RPC and cancellation fail without persisting a choice", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Failed to fetch");
  });
  await assert.rejects(
    testNodeConnection(base, "https://node.example"),
    /CORS/
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    testNodeConnection(base, "https://node.example", abort.signal),
    /cancelled or timed out/
  );
});

test("node mismatch diagnostics show the exact expected and received versions", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    return Response.json({
      id: request.id,
      result: { ...nodeInfo(), nodeVersion: "7.0.0" },
    });
  });
  await assert.rejects(
    testNodeConnection(base, "https://node.example"),
    /Node version mismatch: expected 6\.0\.0, received 7\.0\.0/
  );
});
