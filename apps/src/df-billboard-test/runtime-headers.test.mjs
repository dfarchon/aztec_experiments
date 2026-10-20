import assert from "node:assert/strict";
import test from "node:test";

import config from "./vite.config.ts";

const plugin = config.plugins.find(
  (entry) => entry.name === "df-local-runtime-assets"
);

for (const hook of ["configureServer", "configurePreviewServer"]) {
  test(`${hook} applies isolation headers before runtime responses and redirects`, () => {
    const middleware = [];
    plugin[hook]({
      middlewares: { use: (handler) => middleware.push(handler) },
    });
    for (const url of [
      "/",
      "/df-toxicity.worker.js?v=regression",
      "/main.worker.js",
      "/onnx/ort-wasm-simd-threaded.asyncify.mjs",
      "/onnx/ort-wasm-simd-threaded.asyncify.wasm",
      "/df-missing-runtime-for-test.js",
      "/billboard-readme.md",
      "/df-billboard-test.html",
    ]) {
      const response = {
        headers: {},
        ended: false,
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        writeHead(status, headers = {}) {
          this.status = status;
          for (const [name, value] of Object.entries(headers))
            this.setHeader(name, value);
        },
        end() {
          this.ended = true;
        },
      };
      let index = 0;
      const next = () => {
        const handler = middleware[index++];
        if (handler) handler({ url, method: "HEAD" }, response, next);
      };
      next();
      assert.equal(
        response.headers["cross-origin-opener-policy"],
        "same-origin",
        url
      );
      assert.equal(
        response.headers["cross-origin-embedder-policy"],
        "credentialless",
        url
      );
      if (url === "/df-billboard-test.html") {
        assert.equal(response.status, 302);
        assert.equal(response.ended, true);
      }
    }
  });
}
