import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";

const compiled = await build({
  entryPoints: [
    fileURLToPath(
      new URL("../../../web/src/appearance/clouds.worker.ts", import.meta.url)
    ),
  ],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});

function fixture() {
  let draws = 0,
    next = 0;
  const timers = new Map(),
    replies = [];
  const self = { postMessage: (message) => replies.push(message) };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    self,
    performance: { now: () => 2000 },
    setTimeout: (run, delay) => {
      assert(Number.isFinite(delay) && delay > 0);
      const id = ++next;
      timers.set(id, { run, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const context = {
    setTransform() {},
    clearRect() {
      draws++;
    },
    fillText() {},
  };
  const send = (message) => self.onmessage({ data: message });
  const init = (mode = "normal", drawable = true) =>
    send({
      type: "init",
      canvas: { getContext: () => (drawable ? context : null) },
      theme: "dark",
      mode,
      width: 32,
      height: 32,
      dpr: 1,
      panel: null,
    });
  return { send, init, timers, replies, draws: () => draws };
}

test("switching an active worker to static cancels its timer and stale callbacks cannot restart it", () => {
  const f = fixture();
  f.init();
  assert.equal(f.timers.size, 1);
  const stale = [...f.timers.values()][0].run;
  f.send({ type: "mode", mode: "static" });
  assert.equal(f.timers.size, 0);
  const draws = f.draws();
  stale();
  assert.equal(f.draws(), draws);
  assert.equal(f.timers.size, 0);
  f.send({ type: "theme", theme: "light" });
  assert.equal(f.draws(), draws + 1);
  assert.equal(f.timers.size, 0);
});

test("mode changes keep exactly one valid timer and paused workers stop drawing", () => {
  const f = fixture();
  f.init();
  assert.equal([...f.timers.values()][0].delay, 50);
  f.send({ type: "mode", mode: "low" });
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 125);
  const stale = [...f.timers.values()][0].run;
  f.send({ type: "mode", mode: "paused" });
  assert.equal(f.timers.size, 0);
  const draws = f.draws();
  stale();
  assert.equal(f.draws(), draws);
  f.send({ type: "mode", mode: "normal" });
  assert.equal(f.timers.size, 1);
  f.send({ type: "mode", mode: "normal" });
  assert.equal(f.timers.size, 1);
});

test("the worker acknowledges successful initialization and rejects a missing drawing context", () => {
  const f = fixture();
  f.init("static");
  assert.equal(f.replies[0].type, "ready");
  assert.equal(f.draws(), 1);
  assert.equal(f.timers.size, 0);
  const failed = fixture();
  assert.throws(() => failed.init("normal", false), /drawing context/);
  assert.equal(failed.replies.length, 0);
  assert.equal(failed.timers.size, 0);
});
