import assert from "node:assert/strict";
import test from "node:test";

import { createBillboardController } from "./controller.ts";

const deployment = {
  kind: "notch-stake",
  schemaVersion: 2,
  environment: "local",
  nodeUrl: "http://127.0.0.1:5180",
  rollupAddress: "0xrollup",
  rollupVersion: 1,
  board: "0xboard",
  boardClassId: "class-id",
  boardArtifactHash: "artifact-hash",
  sponsoredFpc: "0xsponsor",
  l1Stake: { rpcUrl: "http://127.0.0.1:5954", portal: "0xportal" },
};
const payer = `0x${"1".repeat(40)}`;
const owner = `0x${"2".repeat(64)}`;
const emptyStake = {
  available: true,
  payer,
  owner,
  amount: "0",
  pendingDeposit: false,
  depositPrepared: false,
  depositNeedsHash: false,
  claimNeedsHash: false,
  pendingExit: false,
  exitNeedsHash: false,
  backedUp: true,
  lastPost: "0",
};

function fixture(t, overrides = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://127.0.0.1:5001/"),
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, "location", descriptor)
      : delete globalThis.location
  );
  t.mock.method(console, "error", () => {});
  const calls = [];
  let feedError = null;
  let postError = null;
  let emitStake = () => {};
  let messages = ["first"];
  const node = {
    getNodeInfo: async () => ({
      l1ChainId: 31337,
      nodeVersion: "6.0.0",
      realProofs: false,
      rollupVersion: 1,
      l1ContractAddresses: { rollupAddress: deployment.rollupAddress },
    }),
    getContract: async () => ({
      currentContractClassId: { toString: () => "class-id" },
    }),
  };
  const sdk = {
    AztecAddress: { fromStringUnsafe: (value) => value },
    createAztecNodeClient: () => node,
  };
  const wallet = {
    async connect() {
      calls.push("connect");
      emitStake(emptyStake);
    },
    async disconnect() {
      calls.push("disconnect");
      emitStake({ ...emptyStake, payer: "", owner: "", amount: "0" });
    },
    async deposit(amount) {
      calls.push(["deposit", amount]);
      emitStake({ ...emptyStake, pendingDeposit: true, depositPrepared: true });
    },
    async resume() {
      calls.push("resume");
      emitStake({ ...emptyStake, amount: "500000000000000" });
    },
    async recoverDeposit(hash) {
      calls.push(["recoverDeposit", hash]);
    },
    async recoverClaim(hash) {
      calls.push(["recoverClaim", hash]);
    },
    async withdraw() {
      calls.push("withdraw");
    },
    async resumeExit() {
      calls.push("resumeExit");
    },
    async recoverExit(hash) {
      calls.push(["recoverExit", hash]);
    },
    async restore(file) {
      calls.push(["restore", file.name]);
    },
    backup: () => ({ filename: "account.json", contents: "{}" }),
    async post(message) {
      calls.push(["post", message]);
      if (postError) throw postError;
      messages = [...messages, message];
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const controller = createBillboardController({
    fetchPublicJson: async () => deployment,
    readSdk: () => sdk,
    sdk: () => sdk,
    loadReadLayout: async () => ({ post_count: {} }),
    loadWalletRuntime: async () => {
      calls.push("loadWalletRuntime");
    },
    readPostPage: async (_sdk, _node, _board, _layout, cursor) => {
      calls.push(["read", cursor?.before ?? null]);
      if (feedError) throw feedError;
      return {
        posts: messages.map((text, id) => ({ id, text })),
        cursor: { block: 42, total: messages.length, before: 0 },
      };
    },
    createStakePosting: (_deployment, _sdk, emit) => {
      emitStake = emit;
      return wallet;
    },
    ...overrides,
  });
  t.after(() => controller.dispose());
  return {
    controller,
    calls,
    deployment,
    wallet,
    setFeedError(value) {
      feedError = value;
    },
    setPostError(value) {
      postError = value;
    },
    emit(stake) {
      emitStake(stake);
    },
  };
}

test("public posts load without wallet code or an L1 connection", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.text),
    ["first"]
  );
  assert.equal(controller.getSnapshot().canRead, true);
  assert.equal(controller.getSnapshot().connected, false);
  assert.deepEqual(calls, [["read", null]]);
});

test("the single L1 wallet opens a private account and stake unlocks posting", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  await controller.connect();
  assert.equal(controller.getSnapshot().stake.payer, payer);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.deepEqual(calls.slice(1, 3), ["loadWalletRuntime", "connect"]);
  await controller.deposit("500000000000000");
  assert.equal(controller.getSnapshot().stake.pendingDeposit, true);
  await controller.resumeRequest();
  assert.equal(controller.getSnapshot().canPost, true);
  controller.setField("message", "new post");
  await controller.post();
  assert.equal(controller.getSnapshot().message, "");
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.text),
    ["first", "new post"]
  );
  assert(calls.some((call) => Array.isArray(call) && call[0] === "post"));
});

test("a failed post keeps its draft and paid actions remain separate", async (t) => {
  const { controller, setPostError, calls } = fixture(t);
  await controller.initialize();
  await controller.connect();
  await controller.resumeRequest();
  controller.setField("message", "keep this");
  setPostError(Error("Proof failed"));
  await controller.post();
  assert.equal(controller.getSnapshot().message, "keep this");
  assert.equal(controller.getSnapshot().actionError.message, "Proof failed");
  assert.equal(calls.filter((call) => call === "resume").length, 1);
});

test("receipt recovery routes L1 and L2 hashes to the right operation", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  await controller.connect();
  await controller.resumeRequest("0xl1", "l1");
  await controller.resumeRequest("0xl2", "l2");
  await controller.resumeWithdrawal("0xexit");
  assert.deepEqual(calls.slice(-3), [
    ["recoverDeposit", "0xl1"],
    ["recoverClaim", "0xl2"],
    ["recoverExit", "0xexit"],
  ]);
});

test("a failed refresh preserves the current feed and can retry", async (t) => {
  const { controller, setFeedError } = fixture(t);
  await controller.initialize();
  setFeedError(Error("RPC offline"));
  await controller.refresh();
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.text),
    ["first"]
  );
  assert.equal(controller.getSnapshot().actionError.message, "RPC offline");
  setFeedError(null);
  await controller.refresh();
  assert.equal(controller.getSnapshot().feedLoading, false);
});

test("old manifests fail closed before the wallet runtime loads", async (t) => {
  const { controller, calls } = fixture(t, {
    fetchPublicJson: async () => ({
      ...deployment,
      kind: "standalone-billboard",
    }),
  });
  await assert.rejects(controller.initialize(), /stake-enabled/);
  assert.equal(calls.includes("loadWalletRuntime"), false);
  assert.equal(controller.getSnapshot().canPost, false);
});
