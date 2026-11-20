import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { build } from "esbuild";

test("Noir WASM initializes without a document URL or network fetch", async () => {
  const compiled = await build({
    entryPoints: [
      new URL("../../runtime/noir-runtime.mjs", import.meta.url).pathname,
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    loader: { ".wasm": "binary" },
    write: false,
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports
  );

  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const previousFetch = globalThis.fetch;
  globalThis.self = globalThis;
  globalThis.fetch = () => {
    throw new Error("Unexpected fetch during embedded Noir initialization");
  };
  try {
    await Promise.all([
      module.exports.initializeNoirRuntime(),
      module.exports.initializeNoirRuntime(),
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSelf) Object.defineProperty(globalThis, "self", previousSelf);
    else delete globalThis.self;
  }
  assert.equal(typeof module.exports.initializeNoirRuntime, "function");
});
