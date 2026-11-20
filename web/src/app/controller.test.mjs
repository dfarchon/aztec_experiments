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
const selectedProvider = { request: async () => [] };
const emptyStake = {
  available: true,
  payer,
  owner: "",
  aztecReady: false,
  amount: "0",
  stakeChoice: "500000000000000",
  remaining: null,
  pendingDeposit: false,
  pendingAmount: "0",
  depositL1Confirmed: false,
  depositPrepared: false,
  depositNeedsHash: false,
  claimNeedsHash: false,
  pendingExit: false,
  exitNeedsHash: false,
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
  let resumePending = false;
  let initializePending = false;
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
    async connect(provider) {
      calls.push(["connect", provider]);
      emitStake(emptyStake);
    },
    async disconnect() {
      calls.push("disconnect");
      emitStake({ ...emptyStake, payer: "", owner: "", amount: "0" });
    },
    selectStakeAmount(amount) {
      calls.push(["selectStakeAmount", amount]);
    },
    async stake(amount) {
      calls.push(["stake", amount]);
      emitStake({
        ...emptyStake,
        pendingDeposit: true,
        pendingAmount: amount,
        depositL1Confirmed: true,
      });
    },
    async resume() {
      calls.push("resume");
      if (resumePending) return false;
      emitStake({
        ...emptyStake,
        pendingDeposit: true,
        depositL1Confirmed: true,
        pendingAmount: "500000000000000",
      });
      return true;
    },
    async initializeAztec() {
      calls.push("initializeAztec");
      emitStake({
        ...emptyStake,
        owner,
        aztecReady: true,
        amount: "500000000000000",
        remaining: 5,
        pendingDeposit: initializePending,
        depositL1Confirmed: initializePending,
      });
      return !initializePending;
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
  const walletRuntime = {
    Fq: { fromString: (value) => value },
    deriveAccountAddress: async () => ({
      address: { toString: () => owner },
    }),
    prepareProofEnvironment: async () => {},
    setupAccount: async () => true,
  };
  const controller = createBillboardController({
    fetchPublicJson: async () => deployment,
    readSdk: () => sdk,
    loadReadLayout: async () => ({ post_count: {} }),
    loadWalletRuntime: async () => {
      calls.push("loadWalletRuntime");
      return walletRuntime;
    },
    readPostPage: async (_sdk, _node, _board, _layout, cursor) => {
      calls.push(["read", cursor?.before ?? null]);
      if (feedError) throw feedError;
      return {
        posts: messages.map((text, id) => ({ id, text })),
        cursor: { block: 42, total: messages.length, before: 0 },
      };
    },
    createWalletFlow: (_deployment, _sdk, emit) => {
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
    setResumePending(value) {
      resumePending = value;
    },
    setInitializePending(value) {
      initializePending = value;
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

test("L1 wallet connects without waiting for the public feed or Aztec runtime", async (t) => {
  const { controller, calls } = fixture(t, {
    readPostPage: async () => new Promise(() => {}),
  });
  await controller.connect(selectedProvider);
  assert.equal(controller.getSnapshot().stake.payer, payer);
  assert.equal(controller.getSnapshot().canRead, false);
  assert(!calls.includes("loadWalletRuntime"));
});

test("stake confirmation automatically initializes Aztec and unlocks posting", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  assert.equal(controller.getSnapshot().stake.payer, payer);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.deepEqual(calls.slice(1, 2), [["connect", selectedProvider]]);
  assert(!calls.includes("loadWalletRuntime"));
  controller.selectStakeAmount("1000000000000000");
  await controller.stake("1000000000000000");
  assert.equal(controller.getSnapshot().stake.pendingDeposit, false);
  assert(calls.includes("loadWalletRuntime"));
  assert(calls.includes("initializeAztec"));
  assert(
    calls.findIndex((call) => Array.isArray(call) && call[0] === "stake") <
      calls.indexOf("initializeAztec")
  );
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

test("a payer may stake before the private account is ready but cannot post", async (t) => {
  const { controller, emit } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  emit({ ...emptyStake, owner: "", amount: "500000000000000" });
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().canPost, false);
});

test("a failed public feed read does not block a ready L1 wallet", async (t) => {
  const { controller } = fixture(t, {
    readPostPage: async () => {
      throw new Error("Feed RPC offline");
    },
  });
  await controller.initialize();
  assert.equal(controller.getSnapshot().actionError.label, "Load posts");
  assert.equal(controller.getSnapshot().stake.available, true);
  await controller.connect(selectedProvider);
  assert.equal(controller.getSnapshot().connected, true);
});

test("a failed post keeps its draft and paid actions remain separate", async (t) => {
  const { controller, setPostError, calls } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
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
  await controller.connect(selectedProvider);
  await controller.resumeRequest("0xl1", "l1");
  await controller.resumeRequest("0xl2", "l2");
  await controller.resumeWithdrawal("0xexit");
  assert.deepEqual(
    calls.filter(
      (call) =>
        Array.isArray(call) &&
        ["recoverDeposit", "recoverClaim", "recoverExit"].includes(call[0])
    ),
    [
      ["recoverDeposit", "0xl1"],
      ["recoverClaim", "0xl2"],
      ["recoverExit", "0xexit"],
    ]
  );
});

test("an unconfirmed L1 stake remains pending without an error toast or another payment", async (t) => {
  const { controller, calls, emit, setResumePending } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  emit({
    ...emptyStake,
    pendingDeposit: true,
    pendingAmount: "500000000000000",
    depositPrepared: true,
  });
  setResumePending(true);
  await controller.resumeRequest();
  assert.equal(controller.getSnapshot().stake.pendingDeposit, true);
  assert.equal(controller.getSnapshot().actionError, null);
  assert.equal(controller.getSnapshot().progress, null);
  assert(!calls.includes("loadWalletRuntime"));
});

test("a confirmed saved stake can resume setup after reconnecting", async (t) => {
  const { controller, calls, emit } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  emit({
    ...emptyStake,
    pendingDeposit: true,
    depositL1Confirmed: true,
    pendingAmount: "500000000000000",
  });
  await controller.resumeRequest();
  assert(calls.includes("initializeAztec"));
  assert.equal(controller.getSnapshot().canPost, true);
});

test("importing an account initializes it without preparing another stake", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  const file = new File(
    ['{"kind":"notch-account","version":1}'],
    "account.json",
    {
      type: "application/json",
    }
  );
  await controller.importStakeBackup(file);
  assert.deepEqual(
    calls.filter(
      (call) =>
        call === "loadWalletRuntime" ||
        call === "initializeAztec" ||
        (Array.isArray(call) && ["restore", "stake"].includes(call[0]))
    ),
    ["loadWalletRuntime", ["restore", "account.json"], "initializeAztec"]
  );
  assert.equal(controller.getSnapshot().actionError, null);
});

test("Aztec initialization can wait for its claim without a failure toast", async (t) => {
  const { controller, setInitializePending } = fixture(t);
  await controller.initialize();
  await controller.connect(selectedProvider);
  setInitializePending(true);
  await controller.initializeAztec();
  assert.equal(controller.getSnapshot().stake.aztecReady, true);
  assert.equal(controller.getSnapshot().stake.pendingDeposit, true);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.equal(controller.getSnapshot().actionError, null);
  assert.equal(controller.getSnapshot().progress, null);
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
  assert.equal(controller.getSnapshot().stake.available, false);
});

test("proof resources load during L1 confirmation, before account setup", async (t) => {
  let releaseConfirmation;
  const confirmation = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  let started;
  const loading = new Promise((resolve) => {
    started = resolve;
  });
  const { controller, wallet, calls, emit } = fixture(t, {
    loadWalletRuntime: async () => {
      calls.push("loadWalletRuntime");
      started();
    },
  });
  await controller.connect(selectedProvider);
  wallet.stake = async (_amount, onSubmitted) => {
    onSubmitted();
    await confirmation;
    emit({ ...emptyStake, pendingDeposit: true, depositL1Confirmed: true });
  };
  const action = controller.stake("500000000000000");
  await loading;
  assert.equal(controller.getSnapshot().busy, true);
  assert(!calls.includes("initializeAztec"));
  releaseConfirmation();
  await action;
  assert(calls.includes("initializeAztec"));
  assert.equal(controller.getSnapshot().canPost, true);
});

test("failed resource preparation preserves the paid deposit for retry", async (t) => {
  const { controller, wallet, calls, emit } = fixture(t, {
    loadWalletRuntime: async () => {
      throw new Error("Resource download failed");
    },
  });
  await controller.connect(selectedProvider);
  let payments = 0;
  wallet.stake = async (_amount, onSubmitted) => {
    payments++;
    emit({ ...emptyStake, pendingDeposit: true, depositL1Confirmed: true });
    onSubmitted();
  };
  await controller.stake("500000000000000");
  assert.equal(payments, 1);
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().stake.pendingDeposit, true);
  assert.match(
    controller.getSnapshot().actionError.message,
    /Resource download failed/
  );
  assert(!calls.includes("initializeAztec"));
});

function savedSession() {
  const data = new Map([
    [
      `notch-wallet-session/${deployment.board}`,
      JSON.stringify({
        payer,
        walletId: "io.metamask",
        walletName: "MetaMask",
      }),
    ],
  ]);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected state was not reached");
}
function restorableFixture(t, options = {}) {
  const storage = savedSession();
  const f = fixture(t, {
    storage,
    listEthereumWallets: async () => [
      { id: "io.metamask", name: "MetaMask", provider: selectedProvider },
    ],
    ...options,
  });
  f.wallet.connect = async (provider, session) => {
    f.calls.push(["silentConnect", provider, session]);
    f.emit({ ...emptyStake, amount: "500000000000000", setupComplete: true });
  };
  return { ...f, storage };
}

test("refresh silently restores an authorized Ready account without another stake", async (t) => {
  const f = restorableFixture(t);
  let finish;
  f.wallet.initializeAztec = async () => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    f.emit({
      ...emptyStake,
      owner,
      aztecReady: true,
      setupComplete: true,
      amount: "500000000000000",
      remaining: 3,
    });
  };
  await f.controller.initialize();
  await until(() => Boolean(finish));
  assert.equal(f.controller.getSnapshot().restoring, true);
  assert.equal(f.controller.getSnapshot().walletOpen, false);
  assert.equal(f.controller.getSnapshot().canPost, false);
  f.controller.setWalletPanel(true);
  f.controller.setWalletPanel(false);
  assert.equal(f.controller.getSnapshot().restoring, true);
  finish();
  await until(() => !f.controller.getSnapshot().busy);
  assert.equal(f.controller.getSnapshot().canPost, true);
  assert.equal(f.controller.getSnapshot().stake.remaining, 3);
  assert(!f.calls.some((call) => Array.isArray(call) && call[0] === "stake"));
  assert.equal(
    f.calls.find(
      (call) => Array.isArray(call) && call[0] === "silentConnect"
    )[2].payer,
    payer
  );
});

test("pending first setup reconnects but never starts a payment or claim automatically", async (t) => {
  const f = restorableFixture(t);
  f.wallet.connect = async () =>
    f.emit({
      ...emptyStake,
      pendingDeposit: true,
      depositL1Confirmed: true,
      setupComplete: false,
    });
  await f.controller.initialize();
  await until(
    () =>
      Boolean(f.controller.getSnapshot().stake.payer) &&
      !f.controller.getSnapshot().busy
  );
  assert.equal(f.controller.getSnapshot().stake.pendingDeposit, true);
  assert(!f.calls.includes("loadWalletRuntime"));
  assert(!f.calls.includes("initializeAztec"));
});

test("revoked authorization or missing selected wallet does not initialize an account", async (t) => {
  for (const available of [true, false]) {
    const f = restorableFixture(
      t,
      available ? {} : { listEthereumWallets: async () => [] }
    );
    f.wallet.connect = async () => false;
    await f.controller.initialize();
    await until(() => !f.controller.getSnapshot().busy);
    assert.equal(f.controller.getSnapshot().connected, false);
    assert(!f.calls.includes("loadWalletRuntime"));
  }
});

test("restore failure can retry without locking the account panel", async (t) => {
  const f = restorableFixture(t);
  f.wallet.initializeAztec = async () => {
    throw Error("Node unavailable");
  };
  await f.controller.initialize();
  await until(() => !!f.controller.getSnapshot().actionError);
  assert.equal(f.controller.getSnapshot().restoring, false);
  assert.equal(f.controller.getSnapshot().canPost, false);
  let finish;
  f.wallet.initializeAztec = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const retry = f.controller.initializeAztec();
  await until(() => Boolean(finish));
  assert.equal(f.controller.getSnapshot().restoring, true);
  finish();
  await retry;
});

test("disconnect removes automatic reconnection preference", async (t) => {
  const f = restorableFixture(t);
  await f.controller.initialize();
  await until(
    () => f.controller.getSnapshot().canPost && !f.controller.getSnapshot().busy
  );
  await f.controller.disconnect();
  assert.equal(
    f.storage.getItem(`notch-wallet-session/${deployment.board}`),
    null
  );
  assert.equal(f.controller.getSnapshot().connected, false);
});

test("a changed wallet invalidates an in-flight restore and its error", async (t) => {
  const f = restorableFixture(t);
  let fail;
  f.wallet.initializeAztec = async () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  await f.controller.initialize();
  await until(() => Boolean(fail));
  f.emit({ ...emptyStake, payer: "" });
  fail(Error("Old session ended"));
  await until(() => !f.controller.getSnapshot().busy);
  assert.equal(f.controller.getSnapshot().connected, false);
  assert.equal(f.controller.getSnapshot().canPost, false);
  assert.equal(f.controller.getSnapshot().actionError, null);
  assert.equal(
    f.storage.getItem(`notch-wallet-session/${deployment.board}`),
    null
  );
});

test("pending withdrawal restores the existing account before completing its saved exit", async (t) => {
  for (const hash of [undefined, "saved-withdrawal-hash"]) {
    const f = fixture(t);
    await f.controller.connect(selectedProvider);
    f.emit({
      ...emptyStake,
      amount: "500000000000000",
      pendingExit: true,
      setupComplete: true,
      aztecReady: false,
    });
    await f.controller.resumeWithdrawal(hash);
    const resume = hash
      ? f.calls.findIndex(
          (call) => Array.isArray(call) && call[0] === "recoverExit"
        )
      : f.calls.indexOf("resumeExit");
    assert(f.calls.indexOf("initializeAztec") < resume);
    assert(resume >= 0);
    assert(!f.calls.some((call) => Array.isArray(call) && call[0] === "stake"));
  }
});

test("failed initialization leaves a pending exit intact and does not request withdrawal", async (t) => {
  const f = fixture(t);
  await f.controller.connect(selectedProvider);
  f.emit({
    ...emptyStake,
    pendingExit: true,
    amount: "500000000000000",
    aztecReady: false,
  });
  f.wallet.initializeAztec = async () => {
    throw Error("Node unavailable");
  };
  await f.controller.resumeWithdrawal();
  assert.equal(f.controller.getSnapshot().stake.pendingExit, true);
  assert.match(
    f.controller.getSnapshot().actionError.message,
    /Node unavailable/
  );
  assert(!f.calls.includes("resumeExit"));
  f.wallet.initializeAztec = async () => false;
  await f.controller.resumeWithdrawal();
  assert.equal(f.controller.getSnapshot().stake.pendingExit, true);
  assert(!f.calls.includes("resumeExit"));
});
