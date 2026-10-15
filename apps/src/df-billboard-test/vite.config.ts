import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { type Connect, defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = path.resolve(root, "../../..");
const dist = path.join(repository, "apps/dist");
const worker = path.join(dist, "df-toxicity.worker.js");
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};
const aliases: Record<string, string> = {
  "/df-billboard-test.html": "/",
  "/df-billboard-report.html": "/reports",
};
const redirect: Connect.NextHandleFunction = (request, response, next) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (!aliases[url.pathname]) return next();
  response.writeHead(302, { Location: aliases[url.pathname] + url.search });
  response.end();
};

// Deployment files and SDK/WASM assets are generated outside the React source.
// Serve only known public runtime paths, never the repository or wallet files.
function localRuntimeAssets(): Plugin {
  return {
    name: "df-local-runtime-assets",
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
    configureServer(server) {
      server.middlewares.use(redirect);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost")
          .pathname;
        if (
          !/^\/(?:df-[\w.-]+\.(?:js|json)|aztec_bundle\.js|(?:main|thread)\.worker\.js|(?:onnx|crs)\/[\w.-]+)$/.test(
            pathname
          )
        )
          return next();
        const file = path.join(dist, pathname.slice(1));
        if (!existsSync(file) || !statSync(file).isFile()) {
          response.writeHead(404);
          response.end("Runtime asset missing; run npm run prepare:df:site.");
          return;
        }
        const mime: Record<string, string> = {
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".wasm": "application/wasm",
          ".json": "application/json",
        };
        response.writeHead(200, {
          "Content-Type":
            mime[path.extname(file)] || "application/octet-stream",
          "Content-Length": statSync(file).size,
          "Cache-Control": "no-cache",
        });
        if (request.method === "HEAD") response.end();
        else
          createReadStream(file)
            .on("error", () => response.destroy())
            .pipe(response);
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir: false,
  plugins: [react(), localRuntimeAssets()],
  define: {
    __DF_TOXICITY_WORKER_HASH__: JSON.stringify(
      existsSync(worker)
        ? createHash("sha256")
            .update(readFileSync(worker))
            .digest("hex")
            .slice(0, 16)
        : "missing"
    ),
  },
  server: {
    host: "127.0.0.1",
    port: 5001,
    strictPort: true,
    headers,
    fs: { allow: [repository] },
  },
  preview: { host: "127.0.0.1", port: 5001, strictPort: true, headers },
  // Preserve generated contract/SDK assets and local deployment manifests.
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
  },
});
