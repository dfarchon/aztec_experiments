import assert from "node:assert/strict";
import test from "node:test";

import { GasFees } from "@aztec-labs/stdlib/gas";

import {
  AI_CACHE_NAME,
  AI_CATEGORY_THRESHOLDS,
  AI_MODEL_VERSION,
} from "./ai-config.ts";
import { createBillboardController } from "./controller.ts";

const address = `0x${"1".repeat(64)}`;
function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}
function pack(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(527);
  padded.set(bytes);
  return [
    Array.from({ length: 17 }, (_, i) =>
      [...padded.slice(i * 31, (i + 1) * 31)].reduce(
        (value, byte) => (value << 8n) + BigInt(byte),
        0n
      )
    ),
    bytes.length,
  ];
}
function fixture(t, overrides = {}) {
  const deployment = {
    kind: "standalone-billboard",
    schemaVersion: 1,
    nodeUrl: "http://127.0.0.1:5180",
    rollupAddress: "rollup",
    board: "board",
    boardClassId: "board-class",
    sponsoredFpc: "sponsor",
    sponsorSalt: "0",
  };
  const account = {
    address,
    secretKey: "0x123",
    salt: "0",
    signingKey: "456",
    label: "Test account",
  };
  const calls = [];
  let sponsorBalance = 100n;
  let postFailure;
  const posts = [
    pack("hello forest"),
    [Array(17).fill(1n << 248n), 1],
    pack("<img src=x>"),
  ];
  for (const [key, value] of Object.entries({
    window: {},
    location: new URL("http://127.0.0.1:5001/"),
    localStorage: storage(),
    sessionStorage: storage(),
    navigator: { locks: { request: async (_name, _options, run) => run({}) } },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : delete globalThis[key]
    );
  }
  localStorage.setItem("df-signal:accounts:rollup", JSON.stringify([account]));
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(["fetch", url]);
    if (url === "/df-local.json")
      return { ok: true, json: async () => deployment };
    const name = /^\/df-(\w+)-artifact.json$/.exec(url)?.[1];
    return {
      ok: Boolean(name),
      json: async () => ({
        name,
        storageLayout: {
          post_count: { slot: new Fr(2) },
          post_lengths: { slot: new Fr(3) },
          post_data: { slot: new Fr(4) },
        },
      }),
    };
  });
  t.mock.method(console, "error", () => {});
  class Fr {
    constructor(value) {
      this.value = BigInt(value);
    }
    toString() {
      return String(this.value);
    }
    toBigInt() {
      return this.value;
    }
    static fromString(value) {
      return new Fr(value);
    }
  }
  const info = {
    l1ChainId: 31337,
    rollupVersion: 1,
    nodeVersion: "6.0.0",
    realProofs: false,
    l1ContractAddresses: { rollupAddress: "rollup" },
  };
  const node = {
    getNodeInfo: async () => info,
    getContract: async (address) => ({
      address,
      currentContractClassId: "board-class",
    }),
    getBlockNumber: async () => 42,
    getBlock: async () => ({
      header: { globalVariables: { gasFees: new GasFees(0n, 900n) } },
    }),
    getPredictedMinFees: async () => [new GasFees(0n, 250n)],
    getPublicStorageAt: async (block, contract, slot) => {
      calls.push(["read", block, contract, slot.toString()]);
      const [base, key] = slot.toString().split(":").map(Number);
      return new Fr(
        base === 2
          ? posts.length
          : base === 3
            ? posts[key][1]
            : posts[Math.floor(key / 17)][0][key % 17]
      );
    },
  };
  const sdk = {
    Fr,
    GasFees,
    Fq: { fromString: (value) => value },
    AztecAddress: { ZERO: "0", fromStringUnsafe: (value) => value },
    createAztecNodeClient: () => node,
    loadContractArtifact: (value) => value,
    deriveStorageSlotInMap: async (base, key) => ({
      toString: () => `${base}:${key}`,
    }),
    getFeeJuiceBalance: async (owner) => {
      calls.push(["balance", owner]);
      return sponsorBalance;
    },
    getContractInstanceFromInstantiationParams: async () => ({
      address: "sponsor",
    }),
    SponsoredFeePaymentMethod: class {
      constructor(address) {
        this.address = address;
      }
    },
    Contract: {
      at: async (_address, artifact) => {
        assert(
          ["board", "sponsor"].includes(artifact.name),
          "Must not load DF game contracts"
        );
        return {
          methods:
            artifact.name === "board"
              ? {
                  post: (bytes, length) => ({
                    send: async (options) => {
                      if (postFailure) {
                        const error = postFailure;
                        postFailure = undefined;
                        throw error;
                      }
                      calls.push(["post", bytes, length, options]);
                      posts.push(
                        pack(
                          new TextDecoder().decode(
                            new Uint8Array(bytes.slice(0, length))
                          )
                        )
                      );
                      return {
                        receipt: {
                          executionResult: "success",
                          txHash: "post-tx",
                        },
                      };
                    },
                  }),
                }
              : {},
        };
      },
    },
  };
  const controller = createBillboardController({
    loadWalletRuntime: async () => {
      calls.push(["loadWalletRuntime"]);
    },
    loadReadLayout: async () => ({
      post_count: { slot: new Fr(2) },
      post_lengths: { slot: new Fr(3) },
      post_data: { slot: new Fr(4) },
    }),
    ...overrides,
    sdk: () => sdk,
    deriveAccountAddress: async () => ({ address }),
    ensureAztecSetup: async (state, _, options) => {
      if (overrides.ensureAztecSetup)
        return overrides.ensureAztecSetup(state, _, options);
      assert.equal(options.blockMonitor, false);
      assert.equal(options.proverEnabled, info.realProofs);
      options.onProgress(1, 8, "测试钱包");
      Object.assign(state, {
        address,
        wallet: {},
        aztecNode: node,
        pxe: {
          registerContractClass: async (artifact) =>
            calls.push(["registerClass", artifact.name]),
          registerContract: async (instance) =>
            calls.push(["register", instance.address]),
        },
      });
      return true;
    },
  });
  t.after(() => controller.dispose());
  return {
    controller,
    calls,
    address,
    sdk,
    node,
    info,
    deployment,
    posts,
    setSponsorBalance: (value) => {
      sponsorBalance = value;
    },
    failNextPost: (error) => {
      postFailure = error;
    },
  };
}

test("MetaMask and Aztec use one board, one feed and the same composer", async (t) => {
  let emitRequest;
  let config;
  const request = { available: true, payer: "", jobs: [] };
  const { controller, deployment, posts, calls } = fixture(t, {
    createMetaMaskPosting: (value, _sdk, emit) => {
      config = value;
      emitRequest = () =>
        emit({ ...request, jobs: request.jobs.map((job) => ({ ...job })) });
      return {
        connect: async () => {
          request.payer = "0xpayer";
          emitRequest();
        },
        post: async (text) => {
          calls.push(["metamaskPost", config.board, text]);
          posts.push(pack(text));
          return text;
        },
        disconnect: () => {
          request.payer = "";
          emitRequest();
        },
        dispose() {},
      };
    },
  });
  deployment.rollupVersion = "1";
  deployment.l1Request = { entry: "entry", rpcUrl: "http://127.0.0.1:5954" };
  await controller.initialize();
  assert.equal(
    config,
    undefined,
    "MetaMask module stays unloaded while reading"
  );
  assert.equal(
    calls.some((call) => call[1] === "/df-l1-post-lab.json"),
    false
  );
  controller.setField("walletMode", "metamask");
  await controller.connect();
  assert.equal(config.board, deployment.board);
  assert.equal(config.l1, deployment.l1Request);
  assert.equal(controller.getSnapshot().address, "0xpayer");
  assert.equal(
    calls.some((call) => call[1] === "/df-board-artifact.json"),
    false,
    "MetaMask owns its artifacts; the controller must not fetch a second copy"
  );
  controller.setField("message", "one shared board");
  controller.setField("publishToL1", true);
  assert.equal("publishToL1" in controller.getSnapshot(), false);
  await controller.post();
  assert.equal(controller.getSnapshot().message, "");
  assert.ok(
    controller
      .getSnapshot()
      .posts.some((post) => post.text === "one shared board")
  );
  // An extension account/network change must immediately disable new payments.
  request.payer = "";
  emitRequest();
  assert.equal(controller.getSnapshot().connected, false);
  assert.equal(controller.getSnapshot().canPost, false);
  await controller.disconnect();
  controller.setField("walletMode", "local");
  await controller.connect();
  assert.equal(controller.getSnapshot().address, address);
  assert.equal(controller.getSnapshot().canPost, true);
  assert.equal(
    calls.filter((call) => call[1] === "/df-board-artifact.json").length,
    1
  );
});

test("pending MetaMask posts survive wallet switching and resume without another payment", async (t) => {
  const job = { commitment: "request", text: "pending text", l1Tx: "0xpaid" };
  const request = { available: true, payer: "", jobs: [job] };
  let payments = 0;
  const { controller, deployment, posts } = fixture(t, {
    createMetaMaskPosting: (_config, _sdk, emit) => {
      const publish = () =>
        emit({ ...request, jobs: request.jobs.map((job) => ({ ...job })) });
      return {
        connect: async () => {
          request.payer = "0xpayer";
          publish();
        },
        post: async () => {
          payments++;
        },
        resume: async () => {
          job.postId = "3";
          posts.push(pack(job.text));
          publish();
          return job.text;
        },
        disconnect: () => {
          request.payer = "";
          publish();
        },
        dispose() {},
      };
    },
  });
  deployment.l1Request = {};
  await controller.initialize();
  controller.setField("walletMode", "metamask");
  await controller.connect();
  assert.equal(controller.getSnapshot().canPost, false);
  await controller.disconnect();
  await controller.connect();
  controller.setField("message", job.text);
  await controller.resumeRequest();
  assert.equal(payments, 0);
  assert.equal(controller.getSnapshot().message, "");
  assert.equal(controller.getSnapshot().canPost, true);
  assert.equal(controller.getSnapshot().request.jobs[0].postId, "3");
});

test("old boards never fall back to the isolated MetaMask deployment", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  assert.equal(controller.getSnapshot().request.available, false);
  controller.setField("walletMode", "metamask");
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, false);
  assert.match(controller.getSnapshot().actionError.message, /no L1 entry/);
  assert.equal(
    calls.some((call) => call[1] === "/df-l1-post-lab.json"),
    false
  );
});

test("initialization is idempotent, subscribable and does not publish test keys", async (t) => {
  const { controller, calls } = fixture(t);
  const initial = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), initial);
  let updates = 0;
  const unsubscribe = controller.subscribe(() => updates++);
  await Promise.all([controller.initialize(), controller.initialize()]);
  assert.equal(calls.filter((call) => call[1] === "/df-local.json").length, 1);
  assert.ok(updates > 0);
  assert.equal(controller.getSnapshot().savedAccount, address);
  assert.equal(
    calls.some((call) => call[1] === "/df-local-accounts.json"),
    false
  );
  controller.setField("walletMode", "test");
  assert.equal(controller.getSnapshot().walletMode, "local");
  assert.equal(
    JSON.stringify(controller.getSnapshot()).includes("secretKey"),
    false
  );
  assert.equal(initial.deployment, null);
  unsubscribe();
  const previous = updates;
  controller.setField("message", "hello");
  assert.equal(updates, previous);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
  controller.setAiHints(false);
});

test("startup checks run concurrently and all must finish before reading posts", async (t) => {
  const started = [];
  const pending = Object.fromEntries(
    ["node", "layout", "contract"].map((name) => [
      name,
      Promise.withResolvers(),
    ])
  );
  const { controller, node, sdk, calls } = fixture(t, {
    loadReadLayout: async () => {
      started.push("layout");
      await pending.layout.promise;
      return {
        post_count: { slot: new sdk.Fr(2) },
        post_lengths: { slot: new sdk.Fr(3) },
        post_data: { slot: new sdk.Fr(4) },
      };
    },
  });
  for (const [name, method] of [
    ["node", "getNodeInfo"],
    ["contract", "getContract"],
  ]) {
    const read = node[method];
    t.mock.method(node, method, async (...args) => {
      started.push(name);
      await pending[name].promise;
      return read(...args);
    });
  }
  const initialized = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["contract", "layout", "node"]);
  pending.node.resolve();
  pending.contract.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().canRead, false);
  assert.equal(
    calls.some(([name]) => name === "read"),
    false
  );
  pending.layout.resolve();
  await initialized;
  assert.equal(controller.getSnapshot().feedLoaded, true);
});

test("failed startup drains other checks before retry and never publishes late results", async (t) => {
  const pending = Promise.withResolvers();
  let failLayout = true;
  const { controller, node, sdk, calls } = fixture(t, {
    loadReadLayout: async () => {
      if (failLayout) throw Error("Read configuration unavailable");
      return {
        post_count: { slot: new sdk.Fr(2) },
        post_lengths: { slot: new sdk.Fr(3) },
        post_data: { slot: new sdk.Fr(4) },
      };
    },
  });
  const readContract = node.getContract;
  t.mock.method(node, "getContract", async (...args) => {
    await pending.promise;
    return readContract(...args);
  });
  let settled = false;
  const failed = assert
    .rejects(controller.initialize(), /Read configuration unavailable/)
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(controller.getSnapshot().canRead, false);
  pending.resolve();
  await failed;
  assert.equal(
    calls.some(([name]) => name === "read"),
    false
  );
  failLayout = false;
  await controller.initialize();
  assert.equal(controller.getSnapshot().feedLoaded, true);
  assert.equal(controller.getSnapshot().actionError, null);
});

test("startup still rejects wrong rollup and contract class before reading storage", async (t) => {
  for (const mismatch of ["rollup", "class"]) {
    await t.test(mismatch, async (t) => {
      const { controller, info, deployment, calls } = fixture(t);
      if (mismatch === "rollup")
        info.l1ContractAddresses.rollupAddress = "other";
      else deployment.boardClassId = "other";
      await assert.rejects(controller.initialize(), /mismatch|does not match/);
      assert.equal(controller.getSnapshot().canRead, false);
      assert.equal(controller.getSnapshot().posts.length, 0);
      assert.equal(
        calls.some(([name]) => name === "read"),
        false
      );
    });
  }
});

test("invalid board addresses fail before launching startup checks", async (t) => {
  const layout = t.mock.fn();
  const { controller, sdk, node } = fixture(t, { loadReadLayout: layout });
  const info = t.mock.method(node, "getNodeInfo");
  const contract = t.mock.method(node, "getContract");
  t.mock.method(sdk.AztecAddress, "fromStringUnsafe", () => {
    throw Error("Invalid board address");
  });
  await assert.rejects(controller.initialize(), /Invalid board address/);
  assert.equal(layout.mock.callCount(), 0);
  assert.equal(info.mock.callCount(), 0);
  assert.equal(contract.mock.callCount(), 0);
});

test("browser connection saves credentials once and reuses the signing-key conversion", async (t) => {
  for (const mode of ["local", "create", "import"]) {
    await t.test(mode, async (t) => {
      const { controller, sdk } = fixture(t);
      const key = "df-signal:accounts:rollup";
      const account = JSON.parse(localStorage.getItem(key))[0];
      sdk.Fr.random = () => new sdk.Fr(123);
      sdk.Fq.random = () => ({ toString: () => "456" });
      await controller.initialize();
      const writes = t.mock.method(localStorage, "setItem");
      const conversions = t.mock.method(sdk.Fq, "fromString");
      controller.setField("walletMode", mode);
      if (mode === "import")
        controller.setField("accountFile", {
          size: 256,
          text: async () => JSON.stringify(account),
        });
      await controller.connect();
      assert.equal(controller.getSnapshot().connected, true);
      assert.equal(
        writes.mock.calls.filter(({ arguments: args }) => args[0] === key)
          .length,
        mode === "local" ? 0 : 1
      );
      assert.equal(conversions.mock.callCount(), mode === "create" ? 2 : 1);
      assert.equal(localStorage.getItem("df-signal:active:rollup"), address);
    });
  }
});

test("imported credentials remain saved when PXE initialization fails", async (t) => {
  const key = "df-signal:accounts:rollup";
  const { controller } = fixture(t, {
    ensureAztecSetup: async () => {
      assert.equal(JSON.parse(localStorage.getItem(key))[0].secretKey, "0x789");
      throw Error("PXE unavailable");
    },
  });
  const account = {
    ...JSON.parse(localStorage.getItem(key))[0],
    secretKey: "0x789",
  };
  await controller.initialize();
  const writes = t.mock.method(localStorage, "setItem");
  controller.setField("walletMode", "import");
  controller.setField("accountFile", {
    size: 256,
    text: async () => JSON.stringify(account),
  });
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, false);
  assert.match(controller.getSnapshot().actionError.message, /PXE unavailable/);
  assert.equal(
    writes.mock.calls.filter(({ arguments: args }) => args[0] === key).length,
    1
  );
  assert.equal(JSON.parse(localStorage.getItem(key))[0].secretKey, "0x789");
});

test("retired preference fields cannot be enabled through the setter", async (t) => {
  const { controller } = fixture(t);
  const key = "df-signal:reading-preferences:v2";
  localStorage.setItem(
    key,
    JSON.stringify({ mergeDuplicates: false, adMode: "fold", aiHints: true })
  );
  await controller.initialize();
  assert.equal("mergeDuplicates" in controller.getSnapshot(), false);
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentGiven, false);
  controller.setField("adMode", "fold");
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  controller.setField("rulesEnabled", true);
  // Retired preferences must not be reintroduced through the generic setter.
  controller.setField("mergeDuplicates", true);
  assert.equal("mergeDuplicates" in controller.getSnapshot(), false);
  const saved = JSON.parse(
    localStorage.getItem("df-signal:reading-preferences:v5")
  );
  assert.equal("mergeDuplicates" in saved, false);
  assert.equal(saved.rulesEnabled, true);
  assert.equal(saved.aiConsentVersion, null);
});

test("legacy preferences are ignored without deleting stored accounts or requests", async (t) => {
  const { controller } = fixture(t);
  for (const version of [2, 3, 4]) {
    localStorage.setItem(
      `df-signal:reading-preferences:v${version}`,
      JSON.stringify({
        rulesEnabled: true,
        aiHints: true,
        aiConsentVersion: AI_MODEL_VERSION,
        keywordEnabled: true,
        keywords: ["old"],
      })
    );
  }
  const requestKey = "l1-post-lab/6.0.0-rc.3/rollup/board";
  localStorage.setItem(
    requestKey,
    JSON.stringify({ jobs: [{ l1Tx: "pending-tx" }] })
  );
  const keys = [
    "df-signal:accounts:rollup",
    requestKey,
    ...[2, 3, 4].map((version) => `df-signal:reading-preferences:v${version}`),
  ];
  const before = keys.map((key) => [key, localStorage.getItem(key)]);
  await controller.initialize();
  const view = controller.getSnapshot();
  assert.equal(view.rulesEnabled, false);
  assert.equal(view.aiHints, false);
  assert.equal(view.aiConsentGiven, false);
  assert.equal(view.keywordEnabled, false);
  assert.deepEqual(view.keywords, []);
  for (const [key, value] of before)
    assert.equal(localStorage.getItem(key), value);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
});

test("malformed preferences and unavailable preference storage do not block reading controls", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem("df-signal:reading-preferences:v5", "broken");
  await controller.initialize();
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  t.mock.method(localStorage, "setItem", () => {
    throw new Error("quota");
  });
  assert.doesNotThrow(() => controller.setField("rulesEnabled", true));
  assert.equal(controller.getSnapshot().rulesEnabled, true);
});

test("public feed loads without a wallet and uses one block snapshot", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  assert.equal(controller.getSnapshot().connected, false);
  assert.equal(controller.getSnapshot().canRead, true);
  assert.equal(controller.getSnapshot().feedLoaded, true);
  assert.equal(controller.getSnapshot().posts[1].decodeError, true);
  assert.equal(controller.getSnapshot().posts[2].text, "<img src=x>");
  assert(
    calls.filter(([name]) => name === "read").every(([, block]) => block === 42)
  );
  await controller.refresh();
  assert.equal(controller.getSnapshot().posts.length, 3);
});

test("initial posts appear before the page finishes and concurrent refresh shares the read", async (t) => {
  const { controller, node, calls } = fixture(t);
  const remaining = Promise.withResolvers();
  const firstPost = Promise.withResolvers();
  const batches = [];
  node.getPublicStorageMany = async (block, contract, slots) => {
    const id = Number(slots[0].toString().split(":")[1]);
    batches.push(id);
    if (id !== 2) await remaining.promise;
    return Promise.all(
      slots.map((slot) => node.getPublicStorageAt(block, contract, slot))
    );
  };
  t.after(remaining.resolve);
  t.after(
    controller.subscribe(() => {
      if (controller.getSnapshot().posts.length === 1) firstPost.resolve();
    })
  );
  const initial = controller.initialize();
  await firstPost.promise;
  const partial = controller.getSnapshot();
  assert.equal(partial.feedLoading, true);
  assert.equal(partial.feedLoaded, false);
  assert.equal(partial.totalPosts, 3);
  assert.deepEqual(
    partial.posts.map((post) => post.id),
    [2]
  );
  assert.equal(partial.posts[0].text, "<img src=x>");
  assert.equal(partial.feedRevision, 0);
  controller.confirmAiHints();
  assert.equal(controller.getSnapshot().aiHints, false);
  await controller.clearAiCache();
  assert.deepEqual(controller.getSnapshot().posts, partial.posts);
  const refresh = controller.refresh();
  remaining.resolve();
  await Promise.all([initial, refresh]);
  assert.equal(
    calls.filter(([name, , , slot]) => name === "read" && slot === "2").length,
    1,
    "initialization and refresh share one count and block snapshot"
  );
  assert.deepEqual(batches.sort(), [0, 1, 2]);
  assert.equal(controller.getSnapshot().feedLoading, false);
  assert.equal(controller.getSnapshot().feedLoaded, true);
  assert.equal(controller.getSnapshot().feedRevision, 1);
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.id),
    [0, 1, 2]
  );
});

test("an interrupted initial page keeps its completed prefix and retries without advancing pagination", async (t) => {
  const { controller, node, posts } = fixture(t);
  posts.push(...Array.from({ length: 22 }, (_, i) => pack(`post ${i}`)));
  const remaining = Promise.withResolvers();
  const firstPost = Promise.withResolvers();
  let fail = true;
  node.getPublicStorageMany = async (block, contract, slots) => {
    const id = Number(slots[0].toString().split(":")[1]);
    if (fail && id !== 24) {
      await remaining.promise;
      if (id === 23) throw Error("batch interrupted");
    }
    return Promise.all(
      slots.map((slot) => node.getPublicStorageAt(block, contract, slot))
    );
  };
  t.after(remaining.resolve);
  t.after(
    controller.subscribe(() => {
      if (controller.getSnapshot().posts.length === 1) firstPost.resolve();
    })
  );
  const failed = assert.rejects(controller.initialize(), /batch interrupted/);
  await firstPost.promise;
  remaining.resolve();
  await failed;
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.id),
    [24]
  );
  assert.equal(controller.getSnapshot().feedLoaded, false);
  assert.equal(controller.getSnapshot().feedLoading, false);
  assert.equal(controller.getSnapshot().feedRevision, 0);
  assert.equal(controller.getSnapshot().hasOlderPosts, false);
  fail = false;
  posts.push(pack("new snapshot"));
  node.getBlockNumber = async () => 43;
  await controller.initialize();
  assert.equal(controller.getSnapshot().actionError, null);
  assert.equal(controller.getSnapshot().totalPosts, 26);
  assert.equal(controller.getSnapshot().posts.length, 10);
  assert.equal(controller.getSnapshot().posts[0].id, 16);
  assert.equal(controller.getSnapshot().posts.at(-1).text, "new snapshot");
  await controller.loadOlder();
  await controller.loadOlder();
  assert.deepEqual(
    controller.getSnapshot().posts.map((post) => post.id),
    Array.from({ length: 26 }, (_, id) => id)
  );
  assert.equal(controller.getSnapshot().hasOlderPosts, false);
});

test("partly completed refresh and older-page reads retain the committed feed on failure", async (t) => {
  for (const operation of ["refresh", "loadOlder"]) {
    await t.test(operation, async (t) => {
      const { controller, node, posts } = fixture(t);
      posts.push(...Array.from({ length: 22 }, (_, i) => pack(`post ${i}`)));
      await controller.initialize();
      const before = controller.getSnapshot();
      if (operation === "refresh") {
        posts.push(pack("not committed"));
        node.getBlockNumber = async () => 43;
      }
      let completed = 0;
      node.getPublicStorageMany = async (block, contract, slots) => {
        const id = Number(slots[0].toString().split(":")[1]);
        if (id !== (operation === "refresh" ? 25 : 14)) {
          await new Promise(setImmediate);
          throw Error("batch interrupted");
        }
        const values = await Promise.all(
          slots.map((slot) => node.getPublicStorageAt(block, contract, slot))
        );
        completed++;
        return values;
      };
      await controller[operation]();
      const after = controller.getSnapshot();
      assert.equal(completed, 1);
      assert.deepEqual(after.posts, before.posts);
      assert.equal(after.totalPosts, before.totalPosts);
      assert.equal(after.feedRevision, before.feedRevision);
      assert.equal(after.hasOlderPosts, before.hasOlderPosts);
      assert.equal(after.feedLoading, false);
      assert.match(after.actionError.message, /batch interrupted/);
    });
  }
});

test("wallet connects directly to sponsored posting without DF state or a deposit", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().canPost, true);
  assert.equal(controller.getSnapshot().address, address);
  assert.equal("join" in controller, false);
  controller.setField("walletMode", "extension");
  assert.equal(controller.getSnapshot().walletMode, "local");
  controller.setField("message", "你好，独立留言板");
  const posting = controller.post();
  assert.equal(controller.getSnapshot().posting, true);
  assert.equal(controller.getSnapshot().progress.completed, false);
  assert.equal(controller.getSnapshot().connecting, false);
  await posting;
  assert.equal(controller.getSnapshot().posting, false);
  assert.equal(controller.getSnapshot().progress.completed, true);
  const sent = calls.find(([name]) => name === "post");
  assert.equal(sent[2], new TextEncoder().encode("你好，独立留言板").length);
  assert.equal(sent[1].length, 512);
  assert.equal(sent[3].fee.paymentMethod.address, "sponsor");
  assert.equal(sent[3].fee.gasSettings.maxFeesPerGas.feePerL2Gas, 1800n);
  assert.equal(controller.getSnapshot().posts.at(-1).text, "你好，独立留言板");
  assert.equal(controller.getSnapshot().message, "");
  assert.deepEqual(
    calls.filter(([name]) => name === "register").map(([, id]) => id),
    ["board", "sponsor"]
  );
  assert(
    !calls.some(
      ([name, url]) => name === "fetch" && /core|config|player|planet/.test(url)
    )
  );
});

test("empty sponsor blocks sends without falling back to user fees; refill allows retry", async (t) => {
  const { controller, calls, setSponsorBalance } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  setSponsorBalance(0n);
  controller.setField("message", "wait for sponsor");
  await controller.post();
  assert.match(
    controller.getSnapshot().actionError.message,
    /Sponsored FPC has insufficient balance/
  );
  assert.equal(calls.filter(([name]) => name === "post").length, 0);
  assert.equal(controller.getSnapshot().canPost, true);
  setSponsorBalance(100n);
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 1);
  assert.equal(controller.getSnapshot().actionError, null);
});

test("an unfunded sponsor prevents a partial connection but does not block public reading", async (t) => {
  const { controller, setSponsorBalance } = fixture(t);
  setSponsorBalance(0n);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, false);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.equal(controller.getSnapshot().canRead, true);
  assert.match(
    controller.getSnapshot().actionError.message,
    /insufficient balance/
  );
});

test("post failures persist across feed refresh and allow retry", async (t) => {
  const { controller, calls, failNextPost } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.setField("message", "retry");
  failNextPost(new Error("24-hour post limit reached"));
  const posting = controller.post();
  assert.equal(controller.getSnapshot().posting, true);
  assert.equal(controller.getSnapshot().progress.completed, false);
  await posting;
  assert.equal(controller.getSnapshot().posting, false);
  assert.equal(controller.getSnapshot().progress.completed, true);
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().actionError.label, "Anonymous posting");
  assert.equal(controller.getSnapshot().message, "retry");
  await controller.refresh();
  assert.match(controller.getSnapshot().actionError.message, /24-hour/);
  assert.equal(controller.getSnapshot().message, "retry");
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 1);
  assert.equal(controller.getSnapshot().actionError, null);
  assert.equal(controller.getSnapshot().message, "");
});

test("confirmed posts clear the draft even when refreshing the feed fails", async (t) => {
  const { controller, calls, node } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.setField("message", "already published");
  t.mock.method(node, "getPublicStorageAt", async () => {
    throw new Error("Feed unavailable");
  });
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 1);
  assert.equal(controller.getSnapshot().message, "");
  assert.match(
    controller.getSnapshot().actionError.message,
    /Feed unavailable/
  );
  assert.equal(controller.getSnapshot().actionError.label, "Refresh posts");
  assert.match(
    controller.getSnapshot().actionError.guidance,
    /confirmed onchain/
  );
  assert.equal(controller.getSnapshot().progress.failed, false);
  assert.match(controller.getSnapshot().progress.label, /Post published/);
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 1);
});

test("wrong chain prevents connection and never enables posting", async (t) => {
  const { controller, info } = fixture(t);
  await controller.initialize();
  info.nodeVersion = "wrong";
  controller.setField("walletMode", "local");
  await controller.connect();
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().connected, false);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.match(
    controller.getSnapshot().actionError.message,
    /Deployment does not match the selected chain/
  );
});

test("confirmed MetaMask recovery stays successful when the feed fails, and refresh alone clears the warning", async (t) => {
  let resumes = 0;
  const { controller, deployment, node } = fixture(t, {
    createMetaMaskPosting: (_config, _sdk, emit) => ({
      connect: async () => emit({ available: true, payer: "payer", jobs: [] }),
      resume: async () => {
        resumes++;
        return "confirmed request";
      },
      dispose() {},
    }),
  });
  deployment.rollupVersion = "1";
  deployment.l1Request = { entry: "entry", rpcUrl: "http://127.0.0.1:5954" };
  await controller.initialize();
  controller.setField("walletMode", "metamask");
  await controller.connect();
  controller.setField("message", "confirmed request");
  const read = node.getPublicStorageAt;
  node.getPublicStorageAt = async () => {
    throw Error("offline");
  };
  await controller.resumeRequest();
  assert.equal(controller.getSnapshot().message, "");
  assert.equal(controller.getSnapshot().progress.failed, false);
  assert.equal(controller.getSnapshot().actionError.label, "Refresh posts");
  node.getPublicStorageAt = read;
  await controller.refresh();
  assert.equal(controller.getSnapshot().actionError, null);
  assert.equal(resumes, 1);
});

test("direct posting respects the cross-tab lock without submitting or clearing the draft", async (t) => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.setField("message", "keep me");
  t.mock.method(navigator.locks, "request", async (_key, _opts, run) =>
    run(null)
  );
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 0);
  assert.equal(controller.getSnapshot().message, "keep me");
  assert.match(controller.getSnapshot().actionError.message, /another tab/);
});

test("controller pagination preserves loaded posts on failure and refresh resets the snapshot", async (t) => {
  const { controller, posts, node } = fixture(t);
  const unsubscribe = controller.subscribe(() => {
    const view = controller.getSnapshot();
    if (view.feedLoaded)
      assert.equal(
        Number(view.posts.at(-1).id),
        view.totalPosts - 1,
        "posts and snapshot metadata publish together"
      );
  });
  t.after(unsubscribe);
  posts.push(...Array.from({ length: 22 }, (_, i) => pack(`page post ${i}`)));
  await controller.initialize();
  assert.equal(controller.getSnapshot().totalPosts, 25);
  assert.equal(controller.getSnapshot().posts.length, 10);
  assert.equal(controller.getSnapshot().posts[0].id, 15);
  const revision = controller.getSnapshot().feedRevision;
  await controller.loadOlder();
  assert.equal(controller.getSnapshot().posts.length, 20);
  assert.equal(controller.getSnapshot().feedRevision, revision);
  const read = node.getPublicStorageAt;
  node.getPublicStorageAt = async () => {
    throw Error("offline");
  };
  await controller.loadOlder();
  assert.equal(controller.getSnapshot().posts.length, 20);
  assert.equal(controller.getSnapshot().hasOlderPosts, true);
  node.getPublicStorageAt = read;
  await controller.loadOlder();
  assert.equal(controller.getSnapshot().posts.length, 25);
  assert.equal(controller.getSnapshot().hasOlderPosts, false);
  posts.push(pack("new post"));
  node.getBlockNumber = async () => 43;
  await controller.refresh();
  assert.equal(controller.getSnapshot().posts.length, 10);
  assert.equal(controller.getSnapshot().totalPosts, 26);
  assert.equal(controller.getSnapshot().posts.at(-1).text, "new post");
  assert.equal(controller.getSnapshot().feedRevision, revision + 1);
});

test("legacy deployment fails visibly and initialization can be retried after replacement", async (t) => {
  const { controller, deployment } = fixture(t);
  deployment.kind = "legacy";
  await assert.rejects(controller.initialize(), /Legacy DF/);
  assert.equal(controller.getSnapshot().canRead, false);
  deployment.kind = "standalone-billboard";
  await controller.initialize();
  assert.equal(controller.getSnapshot().canRead, true);
});

test("changed network is checked again before submitting", async (t) => {
  const { controller, calls, info } = fixture(t);
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.setField("message", "do not submit");
  info.realProofs = true;
  await controller.post();
  assert.equal(calls.filter(([name]) => name === "post").length, 0);
  assert.match(controller.getSnapshot().actionError.message, /does not match/);
});

test("extension discovery, emoji confirmation and capability grants preserve the connection flow", async (t) => {
  const { controller, sdk, node } = fixture(t);
  let confirmed = 0;
  const provider = {
    id: "azguard",
    name: "Azguard",
    establishSecureChannel: async () => ({
      verificationHash: "test",
      cancel() {},
      confirm: async () => {
        confirmed++;
        return {
          registerContract: async () => {},
          requestCapabilities: async (request) => {
            assert.equal(
              request.capabilities.find((item) => item.type === "transaction")
                .scope.length,
              2
            );
            return {
              granted: [
                {
                  type: "accounts",
                  accounts: [{ alias: "Test", item: address }],
                },
                { type: "contracts", canRegister: true, contracts: "*" },
                {
                  type: "simulation",
                  utilities: { scope: "*" },
                  transactions: { scope: "*" },
                },
                { type: "transaction", scope: "*" },
              ],
            };
          },
        };
      },
    }),
    disconnect: async () => {},
  };
  sdk.createAztecNodeClient = () => node;
  sdk.hashToEmoji = () => ["🌲", "🌎"];
  sdk.WalletManager = {
    configure: () => ({
      getAvailableWallets: () => ({
        wallets: (async function* () {
          yield provider;
        })(),
        done: Promise.resolve(),
        cancel() {},
      }),
    }),
  };
  await controller.initialize();
  controller.setField("walletMode", "extension");
  await controller.connect();
  assert.equal(controller.getSnapshot().pendingConnection, true);
  assert.equal(controller.getSnapshot().verification, true);
  assert.equal(controller.getSnapshot().emoji, "🌲 🌎");
  assert.equal(confirmed, 0);
  await controller.confirmWallet();
  assert.equal(confirmed, 1);
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().verification, false);
  assert.equal(controller.getSnapshot().walletOpen, false);
});

test("AI publishes labels to subscribers, reuses cache and stops when disabled", async (t) => {
  const { controller } = fixture(t);
  let requests = 0;
  let terminated = 0;
  for (const [key, value] of Object.entries({
    __DF_TOXICITY_WORKER_HASH__: "test",
    Worker: class {
      postMessage({ id, texts }) {
        requests++;
        queueMicrotask(() =>
          this.onmessage({
            data: {
              id,
              results: texts.map(() => ({
                scores: {
                  ...Object.fromEntries(
                    Object.keys(AI_CATEGORY_THRESHOLDS).map((key) => [key, 0])
                  ),
                  unsafe: 0.9,
                  harassment: 0.8,
                },
              })),
            },
          })
        );
      }
      terminate() {
        terminated++;
      }
    },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : delete globalThis[key]
    );
  }
  const analyzed = async () => {
    for (let i = 0; i < 100; i++) {
      if (controller.getSnapshot().aiStatus.startsWith("AI analyzed")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(controller.getSnapshot().aiStatus);
  };
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.confirmAiHints();
  await analyzed();
  assert.deepEqual(controller.getSnapshot().posts[0].aiLabels, ["harassment"]);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, true);
  assert.equal(requests, 1);
  controller.setAiHints(false);
  assert.equal(terminated, 1);
  controller.setAiHints(true);
  await analyzed();
  assert.equal(requests, 1);
  assert.match(controller.getSnapshot().aiStatus, /0 newly analyzed/);
});

test("keyword settings validate input, persist and remain independent of rules and AI", async (t) => {
  const { controller } = fixture(t);
  await controller.initialize();
  assert.equal(controller.saveKeywords("代练\nVPN\nvpn\n"), true);
  controller.setField("keywordEnabled", true);
  controller.setField("rulesEnabled", false);
  controller.setField("keywordMode", "word");
  assert.deepEqual(controller.getSnapshot().keywords, ["代练", "VPN"]);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.saveKeywords("长".repeat(81)), false);
  assert.deepEqual(controller.getSnapshot().keywords, ["代练", "VPN"]);
  const saved = JSON.parse(
    localStorage.getItem("df-signal:reading-preferences:v5")
  );
  assert.equal(saved.keywordEnabled, true);
  assert.equal(saved.keywordMode, "word");
  assert.equal(saved.rulesEnabled, false);
  assert.equal(saved.aiHints, false);
});

test("current settings restore AI only with explicit consent for this model revision", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v5",
    JSON.stringify({
      keywords: ["代练"],
      keywordEnabled: true,
      rulesEnabled: false,
      aiHints: true,
      aiConsentVersion: AI_MODEL_VERSION,
    })
  );
  await controller.initialize();
  assert.equal(controller.getSnapshot().aiHints, true);
  assert.deepEqual(controller.getSnapshot().keywords, ["代练"]);
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  controller.setAiHints(false);
  assert.equal(
    JSON.parse(localStorage.getItem("df-signal:reading-preferences:v5"))
      .aiHints,
    false
  );
});

test("current keyword and basic-rule choices persist", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v5",
    JSON.stringify({
      rulesEnabled: false,
      keywordEnabled: true,
      keywords: ["某词"],
    })
  );
  await controller.initialize();
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  assert.equal(controller.getSnapshot().keywordEnabled, true);
  controller.setField("rulesEnabled", true);
  const saved = localStorage.getItem("df-signal:reading-preferences:v5");
  assert.equal(JSON.parse(saved).rulesEnabled, true);
  const second = fixture(t).controller;
  localStorage.setItem("df-signal:reading-preferences:v5", saved);
  await second.initialize();
  assert.equal(second.getSnapshot().rulesEnabled, true);
});

test("new model revision invalidates old consent", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v5",
    JSON.stringify({ aiHints: true, aiConsentVersion: "old-model" })
  );
  await controller.initialize();
  assert.equal(controller.getSnapshot().aiHints, false);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
  controller.setAiHints(false);
  assert.equal(controller.getSnapshot().aiConsentOpen, false);
});

test("clear model cache is scoped and preserves wallet keys and personal keywords", async (t) => {
  const { controller } = fixture(t);
  const deleted = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      delete: async (name) => {
        deleted.push(name);
        return true;
      },
    },
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, "caches", descriptor)
      : delete globalThis.caches
  );
  await controller.initialize();
  localStorage.setItem("df-signal:accounts:rollup", "keep-wallet-data");
  controller.saveKeywords("代练");
  controller.setField("keywordEnabled", true);
  controller.confirmAiHints();
  await controller.clearAiCache();
  assert.deepEqual(deleted, [AI_CACHE_NAME]);
  assert.equal(
    localStorage.getItem("df-signal:accounts:rollup"),
    "keep-wallet-data"
  );
  assert.deepEqual(controller.getSnapshot().keywords, ["代练"]);
  assert.equal(controller.getSnapshot().keywordEnabled, true);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentGiven, false);
  assert.equal(controller.getSnapshot().aiClearing, false);
});

test("model failures preserve posts, rules and keywords; late cancelled results are ignored", async (t) => {
  const { controller } = fixture(t);
  let instance;
  for (const [key, value] of Object.entries({
    __DF_TOXICITY_WORKER_HASH__: "test",
    Worker: class {
      // The test must retain the fake worker to simulate a late response.
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        instance = this;
      }
      postMessage(message) {
        this.message = message;
      }
      terminate() {}
    },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : delete globalThis[key]
    );
  }
  await controller.initialize();
  controller.setField("walletMode", "local");
  await controller.connect();
  controller.saveKeywords("forest");
  controller.setField("keywordEnabled", true);
  controller.confirmAiHints();
  for (let i = 0; i < 100 && !instance?.message; i++)
    await new Promise((r) => setTimeout(r, 5));
  const stale = instance;
  assert.ok(stale.message);
  stale.onmessage({
    data: {
      id: stale.message.id,
      progress: { file: "model.onnx", loaded: 50, total: 100 },
    },
  });
  assert.equal(controller.getSnapshot().aiProgress.percent, 50);
  controller.setAiHints(false);
  stale.onmessage({ data: { id: stale.message.id, results: [] } });
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, undefined);
  instance = null;
  controller.setAiHints(true);
  for (let i = 0; i < 100 && !instance?.message; i++)
    await new Promise((r) => setTimeout(r, 5));
  instance.onmessage({
    data: { id: instance.message.id, error: "download failed" },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(controller.getSnapshot().aiStatus, /unavailable/);
  assert.equal(controller.getSnapshot().posts.length, 3);
  assert.equal(controller.getSnapshot().keywordEnabled, true);
  assert.equal(controller.getSnapshot().rulesEnabled, false);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, undefined);
});

test("reading and pagination do not load wallet code; wallet failures remain retryable", async (t) => {
  let loads = 0;
  const { controller, calls, deployment } = fixture(t, {
    loadWalletRuntime: async () => {
      if (++loads === 1) throw Error("wallet download failed");
    },
    createMetaMaskPosting: () => {
      throw Error("Browser wallet must not load the MetaMask adapter");
    },
  });
  deployment.l1Request = {};
  await controller.initialize();
  await controller.refresh();
  await controller.loadOlder();
  assert.equal(loads, 0);
  assert.equal(
    calls.some((call) => call[1] === "/df-board-artifact.json"),
    false
  );
  assert.equal(controller.getSnapshot().posts.length, 3);
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, false);
  assert.match(
    controller.getSnapshot().actionError.message,
    /wallet download failed/
  );
  await controller.refresh();
  assert.equal(controller.getSnapshot().posts.length, 3);
  await controller.connect();
  assert.equal(loads, 2);
  assert.equal(controller.getSnapshot().connected, true);
  await controller.disconnect();
  await controller.connect();
  assert.equal(loads, 2, "successful wallet runtime is reused");
  assert.equal(
    calls.filter((call) => call[1] === "/df-board-artifact.json").length,
    1,
    "the Aztec connection reuses its artifact"
  );
});

test("a wallet selection made while the manifest loads is preserved", async (t) => {
  for (const mode of ["extension", "create", "import"]) {
    await t.test(mode, async (t) => {
      const { controller } = fixture(t);
      const fetch = globalThis.fetch;
      const pending = Promise.withResolvers();
      t.mock.method(globalThis, "fetch", async (...args) => {
        if (args[0] === "/df-local.json") await pending.promise;
        return fetch(...args);
      });
      const initialized = controller.initialize();
      controller.setField("walletMode", mode);
      pending.resolve();
      await initialized;
      assert.equal(controller.getSnapshot().savedAccounts.length, 1);
      assert.equal(controller.getSnapshot().walletMode, mode);
    });
  }
});

test("MetaMask adapter initialization retries without reloading the shared runtime", async (t) => {
  let attempts = 0;
  const { controller, calls, deployment } = fixture(t, {
    createMetaMaskPosting: (_config, _sdk, emit) => {
      if (++attempts === 1) throw Error("MetaMask chunk unavailable");
      return {
        connect: async () =>
          emit({ available: true, payer: "0xpayer", jobs: [] }),
        dispose() {},
      };
    },
  });
  deployment.l1Request = {};
  await controller.initialize();
  controller.setField("walletMode", "metamask");
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, false);
  assert.match(
    controller.getSnapshot().actionError.message,
    /chunk unavailable/
  );
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(attempts, 2);
  assert.equal(
    calls.filter((call) => call[0] === "loadWalletRuntime").length,
    1
  );
});

test("initial read failure keeps the board available and can retry without wallet downloads", async (t) => {
  let reads = 0,
    wallets = 0;
  const { controller } = fixture(t, {
    loadReadLayout: async () => {
      reads++;
      throw Error("Read configuration timeout");
    },
    loadWalletRuntime: async () => {
      wallets++;
    },
  });
  await assert.rejects(controller.initialize(), /timeout/);
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().feedLoaded, false);
  assert.equal(controller.getSnapshot().actionError.label, "Load Billboard");
  await assert.rejects(controller.initialize(), /timeout/);
  assert.equal(reads, 2);
  assert.equal(wallets, 0);
});

test("connection loading ends after both successful and failed wallet initialization", async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? "failure" : "success", async (t) => {
      const gate = Promise.withResolvers();
      const { controller } = fixture(t, {
        loadWalletRuntime: async () => {
          await gate.promise;
          if (fail) throw Error("Wallet runtime unavailable");
        },
      });
      await controller.initialize();
      assert.equal(controller.getSnapshot().connecting, false);
      const connection = controller.connect();
      assert.equal(controller.getSnapshot().connecting, true);
      gate.resolve();
      await connection;
      assert.equal(controller.getSnapshot().connecting, false);
      assert.equal(controller.getSnapshot().connected, !fail);
      await controller.refresh();
      assert.equal(controller.getSnapshot().connecting, false);
    });
  }
});
