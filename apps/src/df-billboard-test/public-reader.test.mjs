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
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      boardArtifactHash: "expected",
      storageLayout: {
        post_count: { slot: "0x02" },
        post_lengths: { slot: "0x03" },
        post_data: { slot: "0x04" },
      },
    }),
  }));
  await assert.rejects(loadReadLayout("wrong"), /does not match/);
  assert.equal(
    (await loadReadLayout("expected")).post_data.slot.toBigInt(),
    4n
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
