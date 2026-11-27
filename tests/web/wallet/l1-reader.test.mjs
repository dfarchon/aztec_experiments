import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcProvider } from "ethers";

import {
  L1ReadProvider,
  L1ReadQueue,
} from "../../../web/src/features/wallet/l1-reader.ts";
import { createL1Provider } from "../../../web/src/features/wallet/portal.ts";

const payload = (
  id,
  method = "eth_call",
  params = [{ to: "0x1", data: "0x1234" }, "latest"]
) => ({ id, jsonrpc: "2.0", method, params });
const result = (id, value = "0x1") => [{ id, jsonrpc: "2.0", result: value }];
const queue = (options = {}) =>
  new L1ReadQueue({ interval: 0, retryBase: 1, random: () => 0, ...options });
const alive = () => true;

test("concurrent identical reads share a request, retain caller IDs and do not cache settled data", async () => {
  const reader = queue();
  let calls = 0;
  let finish;
  const first = reader.request(
    payload(1),
    () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    alive
  );
  const second = reader.request(
    payload(2, "eth_call", [{ data: "0x1234", to: "0x1" }, "latest"]),
    () => {
      throw new Error("duplicate transport");
    },
    alive
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  finish(result(1));
  assert.deepEqual(
    (await Promise.all([first, second])).map((r) => r.id),
    [1, 2]
  );
  assert.equal(calls, 1);
  const fresh = await reader.request(
    payload(3),
    async () => {
      calls++;
      return result(3, "0x2");
    },
    alive
  );
  assert.equal(fresh.result, "0x2");
  assert.equal(calls, 2);
});

test("different reads run one at a time with a minimum interval", async () => {
  const reader = queue({ interval: 20 });
  let running = 0,
    maxRunning = 0;
  const starts = [];
  await Promise.all(
    [1, 2, 3].map((id) =>
      reader.request(
        payload(id, "eth_getTransactionReceipt", [String(id)]),
        async () => {
          starts.push(Date.now());
          maxRunning = Math.max(maxRunning, ++running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
          return result(id);
        },
        alive
      )
    )
  );
  assert.equal(maxRunning, 1);
  for (let i = 1; i < starts.length; i++)
    assert(starts[i] - starts[i - 1] >= 18);
});

test("id-less gateway rate errors and HTTP 429 retry, including all queued callers", async () => {
  for (const failure of [
    [{ code: -32005, message: "Too Many Requests" }],
    [{ id: 1, error: { code: -32005, message: "rate limit exceeded" } }],
    Object.assign(new Error("server error"), { response: { statusCode: 429 } }),
  ]) {
    let calls = 0;
    const first = queue().request(
      payload(1),
      async () => {
        if (++calls === 1) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return result(1);
      },
      alive
    );
    assert.equal((await first).result, "0x1");
    assert.equal(calls, 2);
  }
});

test("rate retries are bounded, then the queue remains usable", async () => {
  const reader = queue();
  let calls = 0;
  await assert.rejects(
    reader.request(
      payload(1),
      async () => {
        calls++;
        return [{ code: -32005, message: "Too Many Requests" }];
      },
      alive
    ),
    /L1 network is busy/
  );
  assert.equal(calls, 4);
  assert.equal(
    (await reader.request(payload(2), async () => result(2), alive)).id,
    2
  );
});

test("contract reverts and log range restrictions are returned once without retries", async () => {
  for (const message of [
    "execution reverted",
    "query returned too many logs",
  ]) {
    let calls = 0;
    const error = { id: 1, error: { code: -32005, message } };
    assert.deepEqual(
      await queue().request(
        payload(1),
        async () => {
          calls++;
          return [error];
        },
        alive
      ),
      error
    );
    assert.equal(calls, 1);
  }
});

test("destroyed readers neither send queued work nor continue retries", async () => {
  let active = false,
    calls = 0;
  await assert.rejects(
    queue().request(
      payload(1),
      async () => {
        calls++;
        return result(1);
      },
      () => active
    ),
    /cancelled/
  );
  assert.equal(calls, 0);
  active = true;
  await assert.rejects(
    queue().request(
      payload(2),
      async () => {
        calls++;
        active = false;
        return [{ message: "Too Many Requests" }];
      },
      () => active
    ),
    /cancelled/
  );
  assert.equal(calls, 1);
});

test("one disconnected caller does not cancel another caller's shared read", async () => {
  const reader = queue();
  let active = true,
    calls = 0;
  const first = reader.request(
    payload(1),
    async () => {
      calls++;
      return result(1);
    },
    () => active
  );
  const rejected = assert.rejects(first, /cancelled/);
  const second = reader.request(
    payload(2),
    async () => {
      throw new Error("duplicate");
    },
    alive
  );
  active = false;
  assert.equal((await second).id, 2);
  await rejected;
  assert.equal(calls, 1);
});

test("provider factory disables batches and shares reads across provider instances", async (t) => {
  let calls = 0;
  t.mock.method(JsonRpcProvider.prototype, "_send", async (request) => {
    assert(!Array.isArray(request));
    calls++;
    return result(request.id);
  });
  const config = {
    l1Stake: { rpcUrl: "https://rpc.example/shared-reader-test" },
  };
  const a = createL1Provider(config),
    b = createL1Provider(config);
  t.after(() => {
    a.destroy();
    b.destroy();
  });
  assert(a instanceof L1ReadProvider);
  assert.equal(a._getOption("batchMaxCount"), 1);
  assert.equal(await a._getConnection().retryFunc(), false);
  const answers = await Promise.all([a._send(payload(5)), b._send(payload(6))]);
  assert.equal(calls, 1);
  assert.deepEqual(
    answers.map(([r]) => r.id),
    [5, 6]
  );
});

test("transaction submission and signatures are never coalesced or retried", async (t) => {
  let calls = 0;
  t.mock.method(JsonRpcProvider.prototype, "_send", async (request) => {
    calls++;
    return [
      { id: request.id, error: { code: -32005, message: "Too Many Requests" } },
    ];
  });
  const provider = new L1ReadProvider("https://rpc.example/non-read-test");
  t.after(() => provider.destroy());
  for (const method of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "personal_sign",
  ]) {
    await Promise.all([
      provider._send(payload(1, method, ["same"])),
      provider._send(payload(2, method, ["same"])),
    ]);
  }
  assert.equal(calls, 6);
});

test("ethers send recovers from an id-less limit response without BAD_DATA", async (t) => {
  let calls = 0;
  t.mock.method(JsonRpcProvider.prototype, "_send", async (request) => {
    if (request.method === "eth_chainId") return result(request.id);
    if (++calls === 1) return [{ code: -32005, message: "Too Many Requests" }];
    return result(request.id, "0xbeef");
  });
  const provider = new L1ReadProvider(
    "https://rpc.example/ethers-send-retry-test"
  );
  t.after(() => provider.destroy());
  assert.equal(
    await provider.send("eth_call", [
      { to: "0x1", data: "0xc98517c5" },
      "latest",
    ]),
    "0xbeef"
  );
  assert.equal(calls, 2);
});
