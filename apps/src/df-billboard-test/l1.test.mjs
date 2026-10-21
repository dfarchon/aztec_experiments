import assert from "node:assert/strict";
import test from "node:test";

import { createL1Queue, switchLocalEthereumChain } from "./l1.ts";

test("both MetaMask flows add an unknown local chain but never bypass rejection", async () => {
  const calls = [];
  let added = false;
  const provider = {
    async request(request) {
      calls.push(request);
      if (request.method === "eth_chainId") return "0x1";
      if (request.method === "wallet_switchEthereumChain" && !added)
        throw { code: 4902 };
      if (request.method === "wallet_addEthereumChain") added = true;
    },
  };
  await switchLocalEthereumChain(provider, "0x7a69", "http://127.0.0.1:5954");
  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]
  );
  assert.deepEqual(calls[2].params[0].rpcUrls, ["http://127.0.0.1:5954"]);
  const rejected = [];
  await assert.rejects(
    () =>
      switchLocalEthereumChain(
        {
          async request({ method }) {
            rejected.push(method);
            if (method === "eth_chainId") return "0x1";
            throw Object.assign(new Error("Rejected"), { code: 4001 });
          },
        },
        "0x7a69",
        "http://127.0.0.1:5954"
      ),
    /Rejected/
  );
  assert.deepEqual(rejected, ["eth_chainId", "wallet_switchEthereumChain"]);
});

const hash = `0x${"a".repeat(64)}`;
const l1Hash = `0x${"b".repeat(64)}`;
const address = `0x${"1".repeat(40)}`;
function fixture(t, saved = new Map()) {
  const state = {
    proven: false,
    mined: false,
    rejected: false,
    invalid: false,
    sends: 0,
  };
  const observed = [];
  const ports = {
    validate: async () => {
      if (state.invalid) throw new Error("wrong network");
    },
    discover: async () => ({
      id: "7",
      leaf: "leaf",
      index: 0,
    }),
    witness: async () => (state.proven ? [1, 1, 0n, []] : null),
    checkPublished: async () => state.mined,
    checkReceipt: async () => (state.mined ? "success" : "pending"),
    estimate: async () => ({ gas: "120000", fee: "0.001" }),
    connect: async () => address,
    send: async (_, __, from) => {
      assert.equal(from, address);
      if (state.rejected) throw new Error("User rejected transaction");
      state.sends++;
      return l1Hash;
    },
    prove: async () => {
      state.proven = true;
    },
    faucet: async (from) => assert.equal(from, address),
  };
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const queue = createL1Queue(
    ports,
    storage,
    "rollup:board:publisher",
    (view) => observed.push(view)
  );
  t.after(() => queue.dispose());
  const add = async () => {
    queue.add(hash, "hello L1");
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { queue, state, observed, ports, saved, add };
}

test("proof waiting, ready, signing, confirmation and publication are distinct states", async (t) => {
  const { queue, state, observed, add } = fixture(t);
  await queue.initialize();
  await add();
  assert.equal(queue.snapshot().jobs[0].stage, "waiting-proof");
  await queue.prove();
  assert.equal(queue.snapshot().jobs[0].stage, "ready");
  assert.equal(queue.snapshot().jobs[0].postId, "7");
  await queue.connect();
  await queue.publish(hash);
  assert.equal(queue.snapshot().jobs[0].stage, "confirming");
  assert.equal(queue.snapshot().jobs[0].l1Tx, l1Hash);
  state.mined = true;
  await queue.refresh();
  assert.equal(queue.snapshot().jobs[0].stage, "published");
  assert.deepEqual(
    [...new Set(observed.flatMap((view) => view.jobs.map((job) => job.stage)))],
    ["waiting-proof", "ready", "signing", "confirming", "published"]
  );
  await queue.publish(hash);
  assert.equal(state.sends, 1);
});

test("MetaMask rejection permits retry without creating another L2 job", async (t) => {
  const { queue, state, add } = fixture(t);
  state.proven = true;
  await add();
  await queue.connect();
  state.rejected = true;
  await queue.publish(hash);
  assert.equal(queue.snapshot().jobs[0].stage, "ready");
  assert.match(queue.snapshot().jobs[0].error, /rejected/);
  assert.equal(state.sends, 0);
  state.rejected = false;
  await queue.publish(hash);
  assert.equal(state.sends, 1);
  assert.equal(queue.snapshot().jobs.length, 1);
});

test("successful status refresh clears a transient RPC error", async (t) => {
  const { queue, ports, state, add } = fixture(t);
  const discover = ports.discover;
  ports.discover = async () => {
    throw new Error("Temporary RPC failure");
  };
  await add();
  assert.match(queue.snapshot().jobs[0].error, /Temporary/);
  ports.discover = discover;
  state.proven = true;
  await queue.refresh();
  assert.equal(queue.snapshot().jobs[0].stage, "ready");
  assert.equal(queue.snapshot().jobs[0].error, undefined);
});

test("reload recovers pending L1 hash without submitting again", async (t) => {
  const first = fixture(t);
  first.state.proven = true;
  await first.add();
  await first.queue.connect();
  await first.queue.publish(hash);
  const second = fixture(t, first.saved);
  second.state.proven = true;
  await second.queue.initialize();
  assert.equal(second.queue.snapshot().jobs[0].stage, "confirming");
  await second.queue.connect();
  await second.queue.publish(hash);
  assert.equal(second.state.sends, 0);
  second.state.mined = true;
  await second.queue.refresh();
  assert.equal(second.queue.snapshot().jobs[0].stage, "published");
});

test("failed network validation and wallet changes do not trigger a send", async (t) => {
  const { queue, state, add } = fixture(t);
  state.proven = true;
  await add();
  await queue.connect();
  state.invalid = true;
  await queue.publish(hash);
  assert.equal(state.sends, 0);
  assert.match(queue.snapshot().jobs[0].error, /wrong network/);
  queue.disconnect();
  state.invalid = false;
  await queue.publish(hash);
  assert.equal(state.sends, 0);
  assert.match(queue.snapshot().error, /MetaMask/);
});

test("duplicate additions and externally published messages never cause a second payment", async (t) => {
  const { queue, state, add } = fixture(t);
  state.proven = true;
  await add();
  await add();
  assert.equal(queue.snapshot().jobs.length, 1);
  await queue.connect();
  state.mined = true;
  await queue.publish(hash);
  assert.equal(state.sends, 0);
  assert.equal(queue.snapshot().jobs[0].stage, "published");
});

test("stale polling result cannot overwrite a newly submitted L1 hash", async (t) => {
  const { queue, state, ports, add } = fixture(t);
  state.proven = true;
  await add();
  await queue.connect();
  let release;
  ports.estimate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const oldPoll = queue.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  await queue.publish(hash);
  assert.equal(queue.snapshot().jobs[0].stage, "confirming");
  release({ gas: "1", fee: "0" });
  await oldPoll;
  assert.equal(queue.snapshot().jobs[0].stage, "confirming");
  assert.equal(queue.snapshot().jobs[0].l1Tx, l1Hash);
});

test("reverted L1 transaction permits retry but an unknown pending one does not", async (t) => {
  const { queue, state, ports, add } = fixture(t);
  state.proven = true;
  await add();
  await queue.connect();
  await queue.publish(hash);
  await queue.publish(hash);
  assert.equal(state.sends, 1);
  ports.checkReceipt = async () => "reverted";
  await queue.refresh();
  assert.equal(queue.snapshot().jobs[0].stage, "ready");
  assert.equal(queue.snapshot().jobs[0].l1Tx, undefined);
  ports.checkReceipt = async () => "pending";
  await queue.publish(hash);
  assert.equal(state.sends, 2);
});

test("malformed records are ignored and only durable public fields are saved", async (t) => {
  const { queue, saved, add } = fixture(t);
  saved.set(
    "rollup:board:publisher",
    JSON.stringify([{ l2Tx: "bad", text: "bad" }])
  );
  await queue.initialize();
  assert.equal(queue.snapshot().jobs.length, 0);
  await add();
  const record = JSON.parse(saved.get("rollup:board:publisher"))[0];
  assert.deepEqual(Object.keys(record).sort(), ["l2Tx", "postId", "text"]);
  assert(!JSON.stringify(record).includes("secretKey"));
});

test("unavailable storage leaves new jobs visible with a recovery warning", async (t) => {
  const { queue, saved } = fixture(t);
  saved.set = () => {
    throw new Error("Storage full");
  };
  queue.add(hash, "still visible");
  assert.equal(queue.snapshot().jobs[0].l2Tx, hash);
  assert.match(queue.snapshot().error, /Unable to save L1 progress/);
});
