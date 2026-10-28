import assert from "node:assert/strict";
import test from "node:test";

import {
  accountSetupOptions,
  createAccountKeys,
  readStored,
  writeStored,
} from "./accounts.ts";
import { createFeedReader, readPostPage } from "./feed-reader.ts";
import {
  environment,
  networkPolicy,
  validateChain,
  validateRpc,
  waitForInbox,
} from "./network.ts";

test("shared account helpers keep identities, namespaces and recovery writes isolated", () => {
  let counter = 0;
  const sdk = {
    Fr: { random: () => String(++counter) },
    Fq: { random: () => String(++counter), fromString: (value) => value },
  };
  const browser = createAccountKeys(sdk),
    metamask = createAccountKeys(sdk);
  assert.notDeepEqual(browser, metamask);
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  writeStored(storage, "browser", browser);
  writeStored(storage, "metamask", { ...metamask, jobs: [{ l1Tx: "paid" }] });
  assert.deepEqual(readStored(storage, "browser"), browser);
  assert.equal(readStored(storage, "metamask").jobs[0].l1Tx, "paid");
  assert.equal(
    accountSetupOptions(sdk, browser, "browser-pxe", false).dataDirPrefix,
    "browser-pxe"
  );
  assert.equal(
    accountSetupOptions(sdk, metamask, "metamask-pxe", true).proverEnabled,
    true
  );
  assert.throws(
    () =>
      writeStored(
        {
          setItem() {
            throw Error("full");
          },
        },
        "metamask",
        metamask
      ),
    /full/
  );
  data.set("broken", "{");
  assert.throws(() => readStored(storage, "broken"));
  data.set("broken", "null");
  assert.throws(() => readStored(storage, "broken"), /recovery/);
  assert.equal(readStored(storage, "absent"), null);
});

test("network policies fail closed on RPC, version, rollup and proof mismatches", () => {
  assert.equal(environment(undefined), "local");
  assert.throws(() => environment("mainnet"));
  validateRpc("http://127.0.0.1:5180", "local");
  validateRpc("https://rpc.example", "testnet");
  for (const [url, env] of [
    ["https://rpc.example", "local"],
    ["http://rpc.example", "testnet"],
    ["https://localhost", "testnet"],
    ["https://user:secret@rpc.example", "testnet"],
  ])
    assert.throws(() => validateRpc(url, env));
  for (const env of ["local", "testnet"]) {
    const p = networkPolicy(env);
    const info = {
      l1ChainId: p.chainId,
      nodeVersion: "6.0.0",
      realProofs: p.realProofs,
      rollupVersion: 1,
    };
    const config = { rollupAddress: "rollup", rollupVersion: "1" };
    validateChain(env, config, info, "rollup");
    if (env === "testnet")
      assert.throws(() =>
        validateChain(env, { rollupAddress: "rollup" }, info, "rollup")
      );
    for (const change of [
      { realProofs: !p.realProofs },
      { l1ChainId: 1 },
      { nodeVersion: "other" },
      { rollupVersion: 2 },
    ])
      assert.throws(() =>
        validateChain(env, config, { ...info, ...change }, "rollup")
      );
    assert.throws(() => validateChain(env, config, info, "other"));
  }
});

test("public inbox waits never advance time and timeout remains retryable", async () => {
  let advanced = 0,
    reads = 0;
  const advance = async () => {
    advanced++;
  };
  await waitForInbox(
    "testnet",
    async () => ++reads === 2,
    advance,
    () => {},
    () => false,
    async () => {}
  );
  assert.equal(advanced, 0);
  await assert.rejects(
    waitForInbox(
      "testnet",
      async () => false,
      advance,
      () => {},
      () => false,
      async () => {}
    ),
    /Resume later without paying again/
  );
  assert.equal(advanced, 0);
  reads = 0;
  await waitForInbox(
    "local",
    async () => ++reads === 2,
    advance,
    () => {},
    () => false,
    async () => {}
  );
  assert.equal(advanced, 1);
  await assert.rejects(
    waitForInbox(
      "testnet",
      async () => true,
      advance,
      () => {},
      () => true,
      async () => {}
    ),
    /session closed/
  );
});

function feedFixture(total) {
  class Fr {
    constructor(value) {
      this.value = BigInt(value);
    }
    toBigInt() {
      return this.value;
    }
    toString() {
      return String(this.value);
    }
  }
  const sdk = {
    Fr,
    AztecAddress: { fromStringUnsafe: (value) => value },
    deriveStorageSlotInMap: async (slot, key) => `${slot}/${key}`,
  };
  const reads = [];
  let fail = false;
  const node = {
    getBlockNumber: async () => 42,
    getPublicStorageAt: async (block, _address, slot) => {
      reads.push([block, slot]);
      if (fail) throw Error("RPC failure");
      if (slot === "count") return new Fr(total);
      if (slot.startsWith("length/")) return new Fr(1);
      return new Fr(Number(slot.split("/")[1]) % 17 === 0 ? 65n << 240n : 0n);
    },
  };
  const layout = {
    post_count: { slot: "count" },
    post_lengths: { slot: "length" },
    post_data: { slot: "data" },
  };
  return {
    read: (cursor) => readPostPage(sdk, node, "board", layout, cursor),
    sdk,
    node,
    layout,
    reads,
    fail(value) {
      fail = value;
    },
  };
}

function controlledBatchFixture(total) {
  const f = feedFixture(total),
    batches = [],
    read = f.node.getPublicStorageAt;
  let active = 0,
    peak = 0;
  f.node.getPublicStorageMany = (block, address, slots) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      batches.push({
        id: Number(slots[0].split("/")[1]),
        block,
        slots,
        resolve: async (alter = (values) => values) =>
          resolve(
            alter(
              await Promise.all(slots.map((slot) => read(block, address, slot)))
            )
          ),
        reject,
      });
    }).finally(() => active--);
  };
  return { ...f, batches, active: () => active, peak: () => peak };
}
const flushFeedReads = () => new Promise((resolve) => setImmediate(resolve));

test("feed loads ten recent posts, uses one snapshot and retries without advancing a cursor", async () => {
  const f = feedFixture(25);
  const first = await f.read();
  assert.deepEqual(
    first.posts.map((p) => p.id),
    [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
  );
  assert.equal(f.reads.length, 181);
  assert.ok(first.posts.every((p) => p.text === "A"));
  f.fail(true);
  await assert.rejects(f.read(first.cursor), /RPC failure/);
  assert.equal(first.cursor.before, 15);
  f.fail(false);
  const second = await f.read(first.cursor),
    third = await f.read(second.cursor);
  assert.equal(third.cursor.before, 0);
  assert.equal(
    new Set([...first.posts, ...second.posts, ...third.posts].map((p) => p.id))
      .size,
    25
  );
  assert.ok(f.reads.every(([block]) => block === 42));
  assert.equal(f.reads.filter(([, slot]) => slot === "count").length, 1);
  assert.equal((await feedFixture(0).read()).posts.length, 0);
  assert.equal((await feedFixture(1).read()).posts.length, 1);
});

test("feed caps RPC concurrency, drains failures and caches only the same snapshot", async () => {
  const f = feedFixture(25),
    reader = createFeedReader();
  const original = f.node.getPublicStorageAt;
  let active = 0,
    peak = 0,
    reject = false;
  f.node.getPublicStorageAt = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (reject) throw Error("rate limited");
      return await original(...args);
    } finally {
      active--;
    }
  };
  const read = (cursor) => reader(f.sdk, f.node, "board", f.layout, cursor);
  const first = await read();
  assert.equal(peak, 8);
  assert.equal(active, 0);
  first.posts[0].text = "UI mutation";
  const before = f.reads.length;
  assert.equal((await read()).posts[0].text, "A");
  assert.equal(f.reads.length - before, 1, "same snapshot only re-reads count");
  reject = true;
  await assert.rejects(read(first.cursor), /rate limited/);
  assert.equal(active, 0, "failure drains outstanding requests before retry");
  reject = false;
  const older = await read(first.cursor);
  assert.equal(older.cursor.before, 5);
  f.node.getBlockNumber = async () => 43;
  const changed = f.reads.length;
  await read();
  assert.equal(
    f.reads.length - changed,
    181,
    "new snapshot is never served from old cache"
  );
  const otherBoard = f.reads.length;
  await reader(f.sdk, f.node, "other", f.layout);
  assert.equal(f.reads.length - otherBoard, 181);
});

test("feed cache is bounded and does not cross node instances", async () => {
  const f = feedFixture(120),
    reader = createFeedReader();
  let cursor;
  do {
    cursor = (await reader(f.sdk, f.node, "board", f.layout, cursor)).cursor;
  } while (cursor.before);
  let before = f.reads.length;
  await reader(f.sdk, f.node, "board", f.layout);
  assert.equal(
    f.reads.length - before,
    181,
    "oldest cached page was evicted after 100 posts"
  );
  before = f.reads.length;
  await reader(f.sdk, { ...f.node }, "board", f.layout);
  assert.equal(
    f.reads.length - before,
    181,
    "different node must re-read chain state"
  );
});

test("feed batches read newest first and publish only complete prefixes before the full page", async () => {
  const f = controlledBatchFixture(4),
    progress = [];
  let settled = false;
  const result = readPostPage(
    f.sdk,
    f.node,
    "board",
    f.layout,
    undefined,
    undefined,
    (posts, total) => {
      progress.push({ ids: posts.map((post) => post.id), total });
    }
  ).then((page) => {
    settled = true;
    return page;
  });
  await flushFeedReads();
  assert.deepEqual(
    f.batches.map((batch) => batch.id),
    [3, 2]
  );
  await f.batches[1].resolve();
  await flushFeedReads();
  assert.deepEqual(
    progress,
    [],
    "older completed posts wait for the newest post"
  );
  assert.deepEqual(
    f.batches.map((batch) => batch.id),
    [3, 2, 1]
  );
  await f.batches[0].resolve();
  await flushFeedReads();
  assert.deepEqual(progress, [{ ids: [2, 3], total: 4 }]);
  assert.equal(
    settled,
    false,
    "first posts are available while the page is still loading"
  );
  await f.batches[2].resolve();
  await f.batches[3].resolve();
  const page = await result;
  assert.deepEqual(
    progress.map(({ ids }) => ids),
    [
      [2, 3],
      [1, 2, 3],
      [0, 1, 2, 3],
    ]
  );
  assert.deepEqual(
    page.posts.map((post) => post.id),
    [0, 1, 2, 3]
  );
  assert.deepEqual(page.cursor, { block: 42, total: 4, before: 0 });
  assert.equal(f.peak(), 2);
  assert.equal(f.active(), 0);
  for (const { id, block, slots } of f.batches) {
    assert.equal(block, 42);
    assert.deepEqual(slots, [
      `length/${id}`,
      ...Array.from({ length: 17 }, (_, i) => `data/${id * 17 + i}`),
    ]);
  }
});

test("failed batches drain without late progress and retry the same cursor without duplicate posts", async () => {
  const f = controlledBatchFixture(15),
    reader = createFeedReader(),
    cursor = { block: 42, total: 15, before: 5 },
    progress = [];
  const read = () =>
    reader(f.sdk, f.node, "board", f.layout, cursor, (posts) =>
      progress.push(posts.map((post) => post.id))
    );
  let settled = false;
  const failure = assert.rejects(read(), /batch failed/).then(() => {
    settled = true;
  });
  await flushFeedReads();
  await f.batches[0].resolve();
  await flushFeedReads();
  assert.deepEqual(progress, [[4]]);
  assert.deepEqual(
    f.batches.map((batch) => batch.id),
    [4, 3, 2]
  );
  f.batches[2].reject(Error("batch failed"));
  await flushFeedReads();
  assert.equal(settled, false, "failure waits for the other in-flight batch");
  assert.equal(f.active(), 1);
  await f.batches[1].resolve();
  await failure;
  assert.equal(f.active(), 0);
  assert.deepEqual(
    progress,
    [[4]],
    "late successful reads do not publish after an error"
  );
  assert.deepEqual(cursor, { block: 42, total: 15, before: 5 });
  const retry = read();
  await flushFeedReads();
  assert.deepEqual(
    progress.at(-1),
    [3, 4],
    "retry immediately publishes validated cached posts"
  );
  assert.deepEqual(
    f.batches.slice(3).map((batch) => batch.id),
    [2, 1]
  );
  await f.batches[3].resolve();
  await flushFeedReads();
  await f.batches[4].resolve();
  await f.batches[5].resolve();
  const page = await retry;
  assert.deepEqual(
    page.posts.map((post) => post.id),
    [0, 1, 2, 3, 4]
  );
  assert.equal(page.cursor.before, 0);
  assert.equal(f.peak(), 2);
  assert.deepEqual(
    f.batches.map((batch) => batch.id),
    [4, 3, 2, 2, 1, 0]
  );
});

test("batched posts with nonzero message padding are never displayed as valid text", async () => {
  const f = controlledBatchFixture(1),
    progress = [];
  const result = readPostPage(
    f.sdk,
    f.node,
    "board",
    f.layout,
    undefined,
    undefined,
    (posts) => progress.push(posts)
  );
  await flushFeedReads();
  await f.batches[0].resolve((values) => [
    ...values.slice(0, -1),
    new f.sdk.Fr(1n),
  ]);
  const { posts } = await result;
  assert.deepEqual(posts, [{ id: 0, decodeError: true }]);
  assert.deepEqual(progress, [posts]);
});

test("completing a partially cached page returns posts before old cache entries are evicted", async () => {
  const f = feedFixture(10),
    cache = new Map(
      Array.from({ length: 100 }, (_, index) => {
        const id = index + 9;
        return [`board:42:${id}`, { id, text: "A" }];
      })
    );
  const { posts } = await readPostPage(
    f.sdk,
    f.node,
    "board",
    f.layout,
    undefined,
    cache
  );
  assert.deepEqual(
    posts.map((post) => post.id),
    Array.from({ length: 10 }, (_, id) => id)
  );
  assert.ok(posts.every((post) => post.text === "A"));
  assert.equal(cache.size, 100);
  assert.equal(
    cache.has("board:42:9"),
    false,
    "eviction does not erase the returned page"
  );
});
