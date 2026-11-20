import assert from "node:assert/strict";
import test from "node:test";

import { createAztecRuntime } from "../../../runtime/wallet-runtime.mjs";

test("the heavy Aztec SDK is lazy, shared, timed out and retryable", async (t) => {
  const scripts = [];
  const sdk = { loaded: true };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document"
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        remove() {
          this.removed = true;
        },
      }),
      head: { append: (script) => scripts.push(script) },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __aztec: sdk },
  });
  t.after(() => {
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });

  const { loadAztecSdk } =
    await import("../../../web/src/features/wallet/runtime-sdk.ts");
  assert.equal(scripts.length, 0);
  const first = loadAztecSdk();
  assert.equal(loadAztecSdk(), first);
  const failed = assert.rejects(first, /timed out/);
  t.mock.timers.tick(120_000);
  await failed;
  assert.equal(scripts[0].removed, true);

  const retry = loadAztecSdk();
  assert.equal(scripts[1].src, "/aztec_bundle.js");
  scripts[1].onload();
  assert.equal(await retry, sdk);
  assert.equal(await loadAztecSdk(), sdk);
  assert.equal(scripts.length, 2);
});

test("proof resources are prepared once and retry after failure", async () => {
  let starts = 0;
  let fail = true;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const runtime = createAztecRuntime(
    {
      BarretenbergSync: {
        initSingleton: async () => {
          starts++;
          if (fail) throw new Error("CRS unavailable");
        },
        getSingleton: () => ({
          srsInitSrs() {},
          srsInitGrumpkinSrs() {},
        }),
      },
    },
    { nodeUrl: "http://127.0.0.1:5180" }
  );
  try {
    const first = runtime.prepareProofEnvironment();
    assert.equal(first, runtime.prepareProofEnvironment());
    await assert.rejects(first, /CRS unavailable/);
    fail = false;
    await runtime.prepareProofEnvironment();
    await runtime.prepareProofEnvironment();
    assert.equal(starts, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("wallet registration never applies the private account seed to app contracts", async () => {
  const registrations = [];
  const runtime = createAztecRuntime(
    {
      BaseWallet: class {
        registerContract(...args) {
          registrations.push(args);
        }
      },
    },
    { nodeUrl: "http://127.0.0.1:5180" }
  );
  const wallet = runtime.createWallet({}, {}, {});
  const ownAddress = {};
  const secretKey = { privateAccountSeed: true };
  wallet._accountManager = {
    address: { equals: (value) => value === ownAddress },
  };
  wallet._secretKey = secretKey;
  await wallet.registerContract({ address: ownAddress }, {});
  await wallet.registerContract({ address: {} }, {});
  const explicit = {};
  await wallet.registerContract({ address: {} }, {}, explicit);
  assert.equal(registrations[0][2], secretKey);
  assert.equal(registrations[1][2], undefined);
  assert.equal(registrations[2][2], explicit);
});

test("wallet saves a recovery hash before submission and honors NO_WAIT", async () => {
  const order = [];
  const noWait = Symbol("no-wait");
  const fakeHash = { toString: () => "0xrecovery" };
  const gas = {
    l2Gas: 1n,
    daGas: 1n,
    mul: () => gas,
    computeFee: () => ({ toBigInt: () => 1n }),
  };
  const fees = {
    gasSettings: {
      maxFeesPerGas: { computeFee: () => 1n },
    },
  };
  const runtime = createAztecRuntime(
    {
      NO_WAIT: noWait,
      GasSettings: { from: (value) => value },
      BaseWallet: class {
        constructor(pxe) {
          this.pxe = pxe;
        }
        async completeFeeOptions() {
          return fees;
        }
        async simulateViaEntrypoint() {
          return { gasUsed: { totalGas: gas, teardownGas: gas } };
        }
        async createTxExecutionRequestFromPayloadAndFee() {
          return {};
        }
        scopesFrom() {
          return [{}];
        }
        senderForTagsFrom() {
          return {};
        }
      },
    },
    { nodeUrl: "http://127.0.0.1:5180" }
  );
  const wallet = runtime.createWallet(
    {
      proveTx: async () => ({
        toTx: async () => ({ getTxHash: () => fakeHash }),
      }),
    },
    {},
    {
      sendTx: async () => {
        order.push("send");
      },
      getTxReceipt: async () => {
        throw new Error("NO_WAIT must not poll");
      },
    }
  );
  wallet.onTxPrepared = (hash) => {
    assert.equal(hash, "0xrecovery");
    order.push("saved");
  };
  const result = await wallet.sendTx(
    {},
    { from: {}, additionalScopes: [], wait: noWait }
  );
  assert.equal(result.txHash, fakeHash);
  assert.deepEqual(order, ["saved", "send"]);

  wallet.onTxPrepared = () => {
    throw new Error("Storage unavailable");
  };
  await assert.rejects(
    () => wallet.sendTx({}, { from: {}, additionalScopes: [], wait: noWait }),
    /Storage unavailable/
  );
  assert.deepEqual(order, ["saved", "send"]);
});
