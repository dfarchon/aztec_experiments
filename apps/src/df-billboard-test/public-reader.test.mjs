import assert from "node:assert/strict";
import test from "node:test";

import { DomainSeparator } from "@aztec-labs/constants";

import {
  createPublicNode,
  loadReadLayout,
  MAP_SLOT_SEPARATOR,
  PublicField,
  publicReadSDK,
} from "./public-reader.ts";

test("read-only map slots match Aztec 6.0.0 SDK vectors", async () => {
  assert.equal(
    MAP_SLOT_SEPARATOR,
    BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT)
  );
  // Generated with the pinned SDK's deriveStorageSlotInMap, including the
  // highest packed field index of a u32 post ID.
  const vectors = [
    [
      3n,
      0n,
      "0x175e16b24d70777144417466f6e47d99e4060080ddbe9106eac6c0edfc4a4ce4",
    ],
    [
      3n,
      1n,
      "0x19d85eb93cdc773ceebf95f44d6135aceea42db777461ac3e29a1bb1249273d3",
    ],
    [
      4n,
      0n,
      "0x0e5d24a0735cd8941ff8ee49d3cf1c777e0c9a73f34ce4bccb0993f9162ff20b",
    ],
    [
      4n,
      169n,
      "0x1146125df65edb31e41875d53d7cd66e310ef290ac3350d7340ecfe08a4230b4",
    ],
    [
      4n,
      73014444031n,
      "0x1020a47f38471cd4d82966a523e23df598ca5d7d7401885b5062b7734693473e",
    ],
  ];
  for (const [slot, key, expected] of vectors)
    assert.equal(
      (
        await publicReadSDK.deriveStorageSlotInMap(
          new PublicField(slot),
          new PublicField(key)
        )
      ).toString(),
      expected
    );
  assert.throws(() => new PublicField(-1n));
  assert.throws(() => new PublicField(1n << 254n));
});

test("public reader serializes pinned block reads and handles RPC errors without wallet code", async (t) => {
  const calls = [];
  let failure;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    calls.push(body);
    if (failure === "timeout")
      throw new DOMException("RPC timed out", "TimeoutError");
    return {
      ok: failure !== "http",
      status: 503,
      json: async () => ({
        id: failure === "id" ? -1 : body.id,
        ...(failure === "rpc"
          ? { error: { message: "Node unavailable" } }
          : { result: body.method === "node_getBlockNumber" ? 42 : "0x05" }),
      }),
    };
  });
  const node = createPublicNode("https://rpc.example");
  assert.equal(await node.getBlockNumber(), 42);
  const board = `0x${"1".repeat(64)}`;
  assert.equal(
    (await node.getPublicStorageAt(42, board, new PublicField(2n))).toBigInt(),
    5n
  );
  assert.deepEqual(calls[1].params, [42, board, `0x${"0".repeat(63)}2`]);
  for (failure of ["http", "rpc", "id", "timeout"])
    await assert.rejects(node.getBlockNumber());
  failure = undefined;
  assert.equal(
    await node.getBlockNumber(),
    42,
    "a failed request does not poison retries"
  );
});

test("read layout is bound to the deployed artifact", async (t) => {
  let withTimestamp = false;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      boardArtifactHash: "expected",
      storageLayout: {
        post_count: { slot: "0x02" },
        post_lengths: { slot: "0x03" },
        post_data: { slot: "0x04" },
        ...(withTimestamp ? { post_timestamps: { slot: "0x06" } } : {}),
      },
    }),
  }));
  await assert.rejects(loadReadLayout("wrong"), /does not match/);
  assert.equal(
    (await loadReadLayout("expected")).post_data.slot.toBigInt(),
    4n
  );
  assert.equal((await loadReadLayout("expected")).post_timestamps, undefined);
  withTimestamp = true;
  assert.equal(
    (await loadReadLayout("expected")).post_timestamps.slot.toBigInt(),
    6n
  );
});

test("storage reads use batches of three, bound concurrency and restore response order", async (t) => {
  const requests = [];
  let active = 0,
    peak = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    requests.push(body);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return {
      ok: true,
      json: async () =>
        Array.isArray(body)
          ? body
              .map((call) => ({ id: call.id, result: call.params[2] }))
              .reverse()
          : { id: body.id, result: 42 },
    };
  });
  const node = createPublicNode("https://rpc.example");
  const board = `0x${"1".repeat(64)}`;
  const slots = Array.from(
    { length: 19 },
    (_, index) => new PublicField(BigInt(index))
  );
  assert.equal(await node.getBlockNumber(), 42);
  const values = await node.getPublicStorageMany(42, board, slots);
  assert.equal(
    requests.length,
    8,
    "19 fields use seven HTTP batches after the block read"
  );
  assert.ok(requests.slice(1).every((request) => request.length <= 3));
  assert.equal(peak, 3);
  assert.equal(active, 0);
  const calls = requests.slice(1).flat();
  assert.deepEqual(
    values.map((value) => value.toBigInt()),
    slots.map((slot) => slot.toBigInt())
  );
  assert.equal(
    new Set([requests[0].id, ...calls.map((call) => call.id)]).size,
    20
  );
  for (const [index, call] of calls.entries()) {
    assert.equal(call.method, "node_getPublicStorageAt");
    assert.deepEqual(call.params, [42, board, slots[index].toString()]);
  }
  assert.deepEqual(await node.getPublicStorageMany(42, board, []), []);
  await assert.rejects(
    node.getPublicStorageMany(42, board, [...slots, slots[0]]),
    /19 slots/
  );
  assert.equal(
    requests.length,
    8,
    "empty and oversized batches do not make requests"
  );
});

test("a slow storage batch does not block queued batches or reorder fields", async (t) => {
  const pending = [];
  let active = 0,
    peak = 0;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    const calls = JSON.parse(options.body);
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) =>
      pending.push(() =>
        resolve({
          ok: true,
          json: async () =>
            calls
              .map((call) => ({ id: call.id, result: call.params[2] }))
              .reverse(),
        })
      )
    ).finally(() => active--);
  });
  const slots = Array.from(
    { length: 18 },
    (_, i) => new PublicField(BigInt(i))
  );
  const result = createPublicNode("https://rpc.example").getPublicStorageMany(
    42,
    `0x${"1".repeat(64)}`,
    slots
  );
  assert.equal(pending.length, 3);
  for (const [index, expectedRequests] of [
    [2, 4],
    [1, 5],
    [3, 6],
  ]) {
    pending[index]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      pending.length,
      expectedRequests,
      "finished requests refill while the first batch remains pending"
    );
    assert.equal(active, 3);
  }
  pending[5]();
  pending[4]();
  pending[0]();
  assert.deepEqual(
    (await result).map((field) => field.toBigInt()),
    slots.map((slot) => slot.toBigInt())
  );
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test("failed storage batches stop queued work and drain in-flight requests", async (t) => {
  const pending = [];
  t.mock.method(globalThis, "fetch", (_url, options) => {
    const calls = JSON.parse(options.body);
    return new Promise((resolve) =>
      pending.push((missing = false) =>
        resolve({
          ok: true,
          json: async () =>
            calls
              .slice(missing ? 1 : 0)
              .map((call) => ({ id: call.id, result: "0x01" })),
        })
      )
    );
  });
  const node = createPublicNode("https://rpc.example");
  let settled = false;
  const failure = assert
    .rejects(
      node.getPublicStorageMany(
        42,
        `0x${"1".repeat(64)}`,
        Array.from({ length: 18 }, (_, i) => new PublicField(BigInt(i)))
      ),
      /Incomplete board RPC batch/
    )
    .then(() => {
      settled = true;
    });
  assert.equal(pending.length, 3);
  pending[0](true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "batch failure waits for all in-flight requests"
  );
  assert.equal(pending.length, 3);
  pending[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pending.length,
    3,
    "successful in-flight reads do not refill after an error"
  );
  assert.equal(settled, false);
  pending[2]();
  await failure;
  assert.equal(
    pending.length,
    3,
    "failed batches are neither retried nor followed by queued work"
  );
});

test("storage batches reject incomplete, ambiguous, and failed responses without retrying", async (t) => {
  let alter = (results) => results;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests++;
    const calls = JSON.parse(options.body);
    return {
      ok: true,
      json: async () =>
        alter(calls.map((call) => ({ id: call.id, result: "0x01" }))),
    };
  });
  const node = createPublicNode("https://rpc.example");
  const board = `0x${"1".repeat(64)}`;
  const slots = [new PublicField(1n), new PublicField(2n)];
  const invalidResponses = [
    (results) => results[0],
    (results) => results.slice(1),
    (results) => [results[0], results[0]],
    (results) => [results[0], { ...results[1], id: -1 }],
    (results) => [
      results[0],
      { id: results[1].id, error: { message: "Node unavailable" } },
    ],
    (results) => [results[0], { id: results[1].id }],
  ];
  for (alter of invalidResponses)
    await assert.rejects(node.getPublicStorageMany(42, board, slots));
  assert.equal(
    requests,
    invalidResponses.length,
    "failed batches are not retried or split into singleton calls"
  );
});

test("storage batches reject malformed field values", async (t) => {
  let value;
  t.mock.method(globalThis, "fetch", async (_url, options) => ({
    ok: true,
    json: async () =>
      JSON.parse(options.body).map((call) => ({ id: call.id, result: value })),
  }));
  const node = createPublicNode("https://rpc.example");
  for (value of [
    null,
    true,
    1,
    "",
    " ",
    "invalid",
    "-1",
    `0x${(1n << 254n).toString(16)}`,
  ])
    await assert.rejects(
      node.getPublicStorageMany(42, `0x${"1".repeat(64)}`, [
        new PublicField(1n),
      ])
    );
});

test("initial controller graph excludes wallet modules and stays below 150 KB", async () => {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [new URL("./controller.ts", import.meta.url).pathname],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: "out",
    write: false,
    metafile: true,
    minify: true,
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find((key) =>
    outputs[key].entryPoint?.endsWith("/controller.ts")
  );
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const item of outputs[file].imports)
      if (!item.external && item.kind !== "dynamic-import") visit(item.path);
  }
  visit(entry);
  const initialInputs = [...seen]
    .flatMap((file) => Object.keys(outputs[file].inputs))
    .join("\n");
  assert.doesNotMatch(
    initialInputs,
    /metamask-posting|node_modules\/ethers\/|@aztec-foundation|wallet-runtime\.js/
  );
  assert(
    [...seen].reduce((sum, file) => sum + outputs[file].bytes, 0) < 150_000
  );
  assert(
    Object.values(outputs).some((file) =>
      file.entryPoint?.endsWith("/metamask-posting.ts")
    )
  );
});
