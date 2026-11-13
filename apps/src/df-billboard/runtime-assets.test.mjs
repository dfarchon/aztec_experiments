import assert from "node:assert/strict";
import test from "node:test";

test("wallet script loading is lazy, shared, timed out and retryable", async (t) => {
  const scripts = [];
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
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
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, "document", previous)
      : delete globalThis.document
  );
  const { loadAztecRuntime } = await import("./runtime-assets.ts");
  assert.equal(scripts.length, 0);
  const first = loadAztecRuntime();
  assert.equal(loadAztecRuntime(), first);
  const failed = assert.rejects(first, /timed out/);
  t.mock.timers.tick(120_000);
  await failed;
  assert.equal(scripts[0].removed, true);
  const retry = loadAztecRuntime();
  scripts[1].onload();
  await Promise.resolve();
  assert.equal(scripts[2].src, "/df-wallet-runtime.js");
  scripts[2].onerror();
  await assert.rejects(retry, /Unable to load/);
  const last = loadAztecRuntime();
  assert.equal(
    scripts[3].src,
    "/df-wallet-runtime.js",
    "already loaded SDK is reused"
  );
  scripts[3].onload();
  await last;
  await loadAztecRuntime();
  assert.equal(scripts.length, 4);
});
