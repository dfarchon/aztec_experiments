import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { type Connect, defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repository = path.resolve(root, "../../..");
const dist = process.env.BILLBOARD_OUTPUT_DIR
  ? path.resolve(process.env.BILLBOARD_OUTPUT_DIR)
  : path.join(repository, "apps/dist");
const worker = path.join(dist, "df-toxicity.worker.js");
const fontLicense = path.join(
  repository,
  "node_modules/@fontsource/fira-sans/LICENSE"
);
const readme = path.join(repository, "df-billboard/README.md");
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};
const isolationHeaders: Connect.NextHandleFunction = (
  _request,
  response,
  next
) => {
  // Custom runtime responses bypass Vite's later header middleware.
  for (const [name, value] of Object.entries(headers))
    response.setHeader(name, value);
  next();
};
const aliases: Record<string, string> = {
  "/df-billboard-test.html": "/",
  "/df-billboard-report.html": "/",
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
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "billboard-readme.md",
        source: readFileSync(readme, "utf8"),
      });
      this.emitFile({
        type: "asset",
        fileName: "font-license.txt",
        source: readFileSync(fontLicense, "utf8"),
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(isolationHeaders);
      server.middlewares.use(redirect);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost")
          .pathname;
        // Missing CRS must fall back to the CDN, not the SPA HTML response.
        if (
          /^\/crs\/[\w.-]+$/.test(pathname) &&
          !existsSync(path.join(dist, pathname.slice(1)))
        ) {
          response.writeHead(404);
          response.end();
          return;
        }
        next();
      });
    },
    configureServer(server) {
      server.middlewares.use(isolationHeaders);
      server.middlewares.use(redirect);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost")
          .pathname;
        if (pathname === "/billboard-readme.md") {
          response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(readFileSync(readme, "utf8"));
          return;
        }
        if (pathname === "/font-license.txt") {
          response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(readFileSync(fontLicense, "utf8"));
          return;
        }
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
    sourcemap: !process.env.BILLBOARD_OUTPUT_DIR,
  },
});
