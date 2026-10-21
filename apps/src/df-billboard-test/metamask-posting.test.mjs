import assert from "node:assert/strict";
import test from "node:test";

import { createMetaMaskPosting } from "./metamask-posting.ts";
import { withWalletLock } from "./wallet-lock.ts";

function locks() {
  const held = new Set();
  return {
    async request(name, options, run) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return run(null);
      held.add(name);
      try {
        return await run({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t) {
  const data = new Map(),
    events = new Map(),
    snapshots = [];
  const clients = [];
  t.after(() => clients.forEach((client) => client.dispose()));
  const state = {
    account: "payer",
    chain: "0x7a69",
    payments: 0,
    published: 0,
    keys: 0,
    failWrite: false,
    reject: false,
    publishError: null,
    sendGate: null,
    entered: null,
  };
  const config = {
    kind: "local-sponsored-l1-post",
    rollupAddress: "rollup",
    board: "board",
    sponsoredFpc: "sponsor",
    nodeUrl: "http://127.0.0.1:5180",
    l1: { chainId: 31337, rpcUrl: "http://127.0.0.1:5954", entry: "entry" },
  };
  const key = "l1-post-lab/6.0.0-rc.3/rollup/board";
  const win = new EventTarget();
  win.ensureAztecSetup = async (local) => {
    Object.assign(local, {
      wallet: {},
      address: "owner",
      pxe: { stop: async () => {} },
    });
    return true;
  };
  for (const [name, value] of Object.entries({
    navigator: { locks: locks() },
    window: win,
    localStorage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, value) => {
        if (state.failWrite) throw Error("Storage full");
        data.set(k, value);
      },
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, name, previous)
        : delete globalThis[name]
    );
  }
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({}),
  }));
  const injected = {
    request: async ({ method }) =>
      method === "eth_chainId" ? state.chain : [state.account],
    on: (name, cb) => {
      const set = events.get(name) ?? new Set();
      set.add(cb);
      events.set(name, set);
    },
    removeListener: (name, cb) => events.get(name)?.delete(cb),
  };
  const requestPost = async () => {
    if (state.reject)
      throw Object.assign(Error("User rejected"), { code: "ACTION_REJECTED" });
    state.payments++;
    state.entered?.resolve();
    if (state.sendGate) await state.sendGate.promise;
    if (state.failAfterSend) state.failWrite = true;
    if (state.unknownSend) throw Error("Broadcast outcome unknown");
    return { hash: "0xpaid" };
  };
  requestPost.estimateGas = async () => 1n;
  const sdk = {
    Fr: { random: () => String(++state.keys) },
    Fq: { random: () => String(++state.keys), fromString: (v) => v },
    AztecAddress: { fromStringUnsafe: (v) => v },
    getFeeJuiceBalance: async () => 1n,
  };
  const api = {
    findMetaMask: async () => injected,
    switchEthereumChain: async () => {},
    validateRequestConfig: async () => ({}),
    verifyRequestEntry: async () => {},
    rpc: () => ({ destroy() {}, waitForTransaction: async () => {} }),
    browser: () => ({
      getSigner: async () => ({ getAddress: async () => state.account }),
    }),
    entry: () => ({ requestPost }),
    readRequestReceipt: async (_config, job) => {
      job.messageKey = "message";
      job.leafIndex = "1";
      return true;
    },
    recoverRequest: async (_config, job, _rpc, hash) => ({
      ...job,
      l1Tx: hash,
    }),
    createRequestSession: async () => ({
      node: {},
      create: async (text) => ({
        text,
        salt: "salt",
        secret: "secret",
        secretHash: "hash",
        commitment: `commitment-${text}`,
      }),
      ready: async () => true,
      publish: async (job, persist) => {
        if (state.publishError) throw state.publishError;
        job.postId = String(++state.published);
        persist();
      },
    }),
  };
  const create = () => {
    const index = snapshots.length;
    snapshots.push(null);
    const client = createMetaMaskPosting(
      config,
      sdk,
      (view) => {
        snapshots[index] = view;
      },
      () => {},
      api
    );
    clients.push(client);
    return client;
  };
  return {
    state,
    data,
    key,
    snapshots,
    create,
    events,
    notifyStorage() {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: key });
      win.dispatchEvent(event);
    },
  };
}

test("wallet lock fails closed, rejects concurrent operations and releases after failure", async () => {
  const manager = locks(),
    gate = deferred();
  const first = withWalletLock("account", () => gate.promise, manager);
  await assert.rejects(
    withWalletLock("account", async () => {}, manager),
    /another tab/
  );
  assert.equal(await withWalletLock("other", async () => 2, manager), 2);
  gate.resolve();
  await first;
  await assert.rejects(
    withWalletLock(
      "account",
      async () => {
        throw Error("failed");
      },
      manager
    ),
    /failed/
  );
  assert.equal(await withWalletLock("account", async () => 3, manager), 3);
  await assert.rejects(
    withWalletLock("account", async () => {}, null),
    /cannot safely coordinate/
  );
});

test("real posting module prevents two tabs from paying at once and keeps both records", async (t) => {
  const f = fixture(t),
    first = f.create(),
    second = f.create();
  await first.connect();
  await second.connect();
  assert.equal(f.state.keys, 3, "both tabs reuse the same stored identity");
  f.state.sendGate = deferred();
  f.state.entered = deferred();
  const sending = first.post("first");
  await f.state.entered.promise;
  await assert.rejects(second.post("second"), /another tab/);
  assert.equal(f.state.payments, 1);
  f.state.sendGate.resolve();
  await sending;
  await second.post("second");
  assert.deepEqual(
    JSON.parse(f.data.get(f.key)).jobs.map((job) => job.text),
    ["second", "first"]
  );
  assert.equal(f.state.payments, 2);
});

test("a different tab resumes a paid request without paying again; storage events update its view", async (t) => {
  const f = fixture(t),
    first = f.create(),
    second = f.create();
  await first.connect();
  await second.connect();
  f.state.publishError = Error("RPC unavailable");
  await assert.rejects(first.post("recover me"), /RPC unavailable/);
  f.notifyStorage();
  assert.equal(f.snapshots[1].jobs[0].l1Tx, "0xpaid");
  await assert.rejects(second.post("new"), /existing request/);
  f.state.publishError = null;
  first.dispose();
  const reloaded = f.create();
  await reloaded.connect();
  assert.equal(await reloaded.resume(), "recover me");
  assert.equal(f.state.payments, 1);
  assert.equal(f.state.published, 1);
  f.notifyStorage();
  assert.equal(f.snapshots[1].jobs[0].postId, "1");
  assert.equal("secret" in f.snapshots[1].jobs[0], false);
});

test("wallet rejection removes only the new request and permits a later retry", async (t) => {
  const f = fixture(t),
    client = f.create();
  await client.connect();
  f.state.reject = true;
  await assert.rejects(client.post("rejected"), /User rejected/);
  assert.equal(JSON.parse(f.data.get(f.key)).jobs.length, 0);
  f.state.reject = false;
  await client.post("retry");
  assert.equal(f.state.payments, 1);
});

test("storage failure prevents payment and a retry reloads durable data", async (t) => {
  const f = fixture(t),
    client = f.create();
  await client.connect();
  f.state.failWrite = true;
  await assert.rejects(client.post("no payment"), /Storage full/);
  assert.equal(f.state.payments, 0);
  f.state.failWrite = false;
  await client.post("retry");
  assert.equal(f.state.payments, 1);
  assert.equal(JSON.parse(f.data.get(f.key)).jobs.length, 1);
});

test("initial account storage failure is retryable without a payment or a half-created session", async (t) => {
  const f = fixture(t),
    client = f.create();
  f.state.failWrite = true;
  await assert.rejects(client.connect(), /Storage full/);
  assert.equal(f.data.has(f.key), false);
  f.state.failWrite = false;
  await client.connect();
  assert.ok(f.data.has(f.key));
  assert.equal(f.state.payments, 0);
});

test("account and network changes block payment until reconnecting", async (t) => {
  const f = fixture(t),
    client = f.create();
  await client.connect();
  f.state.account = "other";
  await assert.rejects(client.post("wrong account"), /account changed/);
  for (const changed of f.events.get("accountsChanged")) changed();
  assert.equal(f.snapshots[0].payer, "");
  await client.connect();
  f.state.chain = "0x1";
  await assert.rejects(client.post("wrong chain"), /Switch MetaMask/);
  assert.equal(f.state.payments, 0);
});

test("changed or malformed saved identities are never overwritten", async (t) => {
  const f = fixture(t),
    client = f.create();
  await client.connect();
  const other = JSON.parse(f.data.get(f.key));
  other.secretKey = "different";
  const value = JSON.stringify(other);
  f.data.set(f.key, value);
  await assert.rejects(client.post("blocked"), /account changed/);
  assert.equal(f.data.get(f.key), value);
  f.data.set(f.key, "null");
  await assert.rejects(client.post("blocked"), /recovery/);
  assert.equal(f.state.payments, 0);
});

test("ambiguous broadcast and post-broadcast storage failures keep the request and never auto-pay again", async (t) => {
  for (const mode of ["unknownSend", "failAfterSend"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t),
        client = f.create();
      await client.connect();
      f.state[mode] = true;
      await assert.rejects(
        client.post("paid"),
        /Broadcast outcome unknown|Storage full/
      );
      assert.equal(f.state.payments, 1);
      f.state.failWrite = false;
      f.state[mode] = false;
      const reloaded = f.create();
      await reloaded.connect();
      await assert.rejects(reloaded.post("do not pay"), /existing request/);
      await assert.rejects(reloaded.resume(), /existing L1 transaction hash/);
      await reloaded.resume("0xexisting");
      assert.equal(f.state.payments, 1);
    });
  }
});
