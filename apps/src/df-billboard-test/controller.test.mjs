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
    nodeVersion: "6.0.0-rc.3",
    realProofs: false,
  };
  const node = {
    getNodeInfo: async () => info,
    getL1ContractAddresses: async () => ({ rollupAddress: "rollup" }),
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
    ...overrides,
    sdk: () => sdk,
    deriveAccountAddress: async () => ({ address }),
    ensureAztecSetup: async (state, _, options) => {
      assert.equal(options.blockMonitor, false);
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
  assert.equal(config.board, deployment.board);
  assert.equal(config.l1, deployment.l1Request);
  assert.equal(
    calls.some((call) => call[1] === "/df-l1-post-lab.json"),
    false
  );
  controller.setField("walletMode", "metamask");
  await controller.connect();
  assert.equal(controller.getSnapshot().address, "0xpayer");
  controller.setField("message", "one shared board");
  controller.setField("publishToL1", true);
  assert.equal(controller.getSnapshot().publishToL1, false);
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

test("legacy reading preferences migrate without enabling broader basic rules", async (t) => {
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

test("old hint-only preferences do not silently enable promotion or AI folding", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v3",
    JSON.stringify({
      adEnabled: true,
      adMode: "hint",
      aiHints: true,
      aiConsentVersion: AI_MODEL_VERSION,
      keywordEnabled: true,
      keywords: ["代练"],
    })
  );
  await controller.initialize();
  const view = controller.getSnapshot();
  assert.equal(view.rulesEnabled, false);
  assert.equal(view.aiHints, false);
  assert.equal(view.aiConsentGiven, false);
  assert.equal(view.keywordEnabled, true);
  assert.deepEqual(view.keywords, ["代练"]);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
});

test("malformed preferences and unavailable preference storage do not block reading controls", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem("df-signal:reading-preferences:v2", "broken");
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
  await controller.post();
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
  await controller.post();
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
    /Deployment does not match the local chain/
  );
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

test("new folding settings restore AI only with explicit consent for this model revision", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v4",
    JSON.stringify({
      keywords: ["代练"],
      keywordEnabled: true,
      adEnabled: false,
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

test("v4 promotion opt-in does not become basic-rules opt-in; v5 choice persists", async (t) => {
  const { controller } = fixture(t);
  localStorage.setItem(
    "df-signal:reading-preferences:v4",
    JSON.stringify({
      adEnabled: true,
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
    "df-signal:reading-preferences:v4",
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
