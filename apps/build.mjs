#!/usr/bin/env node
// ============================================================
// build.mjs -- combines modular source files into single-file HTML apps
// ============================================================
//
// Usage: node build.mjs [app-path]
//   If app-path is given (e.g. "fee-juice" or "billboard/deploy"), builds only that app.
//   Otherwise builds all apps found by scanning src/ recursively for template.html.
//
// Each app directory has:
//   template.html  -- HTML template with placeholders
//   app.js         -- app-specific JavaScript
//   (optional) portal_bytecode.txt, *_artifact.json, etc. -- app-specific resources
//
// Output goes to dist/{app-name}.html
//
// Global shared files in ../../shared/:
//   styles.css, helpers.js, aztec-lib.js, ethers.min.js, poseidon2.js
//
// The bundle (aztec_bundle.js, 58MB) is NOT inlined -- it's too big.
// Templates load it via <script src="aztec_bundle.js">. The build copies it to dist/.
//
// Shared contract resources are read from the parent directory first so a stale
// app-local generated artifact cannot override the current compiled contract.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.join(__dirname, '..', 'shared');
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

// Load global shared files
function loadShared(name) {
  const p = path.join(SHARED, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Load RPC config (node URL + API key) and inject as a global
const rpcConfig = (() => {
  const p = path.join(SHARED, 'rpc-config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
})();

const sharedFiles = {
  STYLES: loadShared('styles.css'),
  HELPERS: loadShared('helpers.js'),
  AZTEC_LIB: loadShared('aztec-lib.js'),
  POSEIDON2: loadShared('poseidon2.js'),
  ETHERS: loadShared('ethers.min.js'),
  WALLET_BUTTONS: loadShared('wallet-buttons.js'),
  APP_ENV: loadShared('app-env.js'),
  MODERATION_POLICY: loadShared('moderation-policy.js'),
};

// RPC config injection script (must run before aztec-lib.js)
const rpcConfigScript = rpcConfig
  ? `<script>window.RPC_CONFIG = ${JSON.stringify(rpcConfig)};</script>`
  : '';

// Look for the shared resource first, then an app-specific fallback.
function loadResource(appDir, filename) {
  const parentPath = path.join(path.dirname(appDir), filename);
  if (fs.existsSync(parentPath)) return fs.readFileSync(parentPath, 'utf8').trim();
  const appPath = path.join(appDir, filename);
  if (fs.existsSync(appPath)) return fs.readFileSync(appPath, 'utf8').trim();
  return null;
}

// App name = path relative to src/ (e.g. "fee-juice", "billboard/deploy")
// Output filename = last path component (e.g. "deploy.html")
function buildApp(appRelPath) {
  const appDir = path.join(SRC, appRelPath);
  if (!fs.existsSync(appDir)) {
    console.error(`App "${appRelPath}" not found in ${SRC}`);
    process.exit(1);
  }

  const templatePath = path.join(appDir, 'template.html');
  const appJsPath = path.join(appDir, 'app.js');

  if (!fs.existsSync(templatePath)) {
    console.error(`template.html not found for app "${appRelPath}"`);
    process.exit(1);
  }
  if (!fs.existsSync(appJsPath)) {
    console.error(`app.js not found for app "${appRelPath}"`);
    process.exit(1);
  }

  let html = fs.readFileSync(templatePath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Prefer the current shared contract resources.
  const portalBytecode = loadResource(appDir, 'portal_bytecode.txt');
  const billboardArtifact = loadResource(appDir, 'billboard_artifact.json');

  // Load engine.js from the app directory (if it exists)
  const enginePath = path.join(appDir, 'engine.js');
  const engineJs = fs.existsSync(enginePath) ? fs.readFileSync(enginePath, 'utf8') : null;

  // Replace placeholders
  const replacements = {
    '<!--STYLES-->': sharedFiles.STYLES ? `<style>\n${sharedFiles.STYLES}\n</style>` : '',
    '<!--HELPERS-->': sharedFiles.HELPERS ? `<script>\n${sharedFiles.HELPERS}\n</script>` : '',
    '<!--RPC_CONFIG-->': rpcConfigScript,
    '<!--APP-->': `<script>\n${appJs}\n</script>`,
  };

  if (engineJs) {
    replacements['<!--ENGINE-->'] = `<script>\n${engineJs}\n</script>`;
  }

  if (sharedFiles.ETHERS) {
    replacements['<!--ETHERS-->'] = `<script>\n${sharedFiles.ETHERS}\n</script>`;
  }
  if (sharedFiles.AZTEC_LIB) {
    replacements['<!--AZTEC_LIB-->'] = `<script>\n${sharedFiles.AZTEC_LIB}\n</script>`;
  }
  if (sharedFiles.POSEIDON2) {
    replacements['<!--POSEIDON2-->'] = `<script>\n${sharedFiles.POSEIDON2}\n</script>`;
  }
  if (sharedFiles.WALLET_BUTTONS) {
    replacements['<!--WALLET_BUTTONS-->'] = `<script>\n${sharedFiles.WALLET_BUTTONS}\n</script>`;
  }
  if (sharedFiles.APP_ENV) {
    replacements['<!--APP_ENV-->'] = `<script>\n${sharedFiles.APP_ENV}\n</script>`;
  }
  if (sharedFiles.MODERATION_POLICY) {
    replacements['<!--MODERATION_POLICY-->'] = `<script>\n${sharedFiles.MODERATION_POLICY}\n</script>`;
  }
  if (portalBytecode) {
    const bc = portalBytecode.startsWith('0x') ? portalBytecode : '0x' + portalBytecode;
    replacements['<!--PORTAL_BYTECODE-->'] = `<script>const PORTAL_BYTECODE = "${bc}";\n</script>`;
  }
  if (billboardArtifact) {
    replacements['<!--ARTIFACT-->'] = `<script>const BILLBOARD_ARTIFACT = ${billboardArtifact};\n</script>`;
  }

  for (const [placeholder, replacement] of Object.entries(replacements)) {
    html = html.replaceAll(placeholder, replacement);
  }

  // Warn about unreplaced placeholders
  const remaining = html.match(/<!--(STYLES|HELPERS|RPC_CONFIG|AZTEC_LIB|ETHERS|POSEIDON2|WALLET_BUTTONS|APP_ENV|MODERATION_POLICY|PORTAL_BYTECODE|ARTIFACT|ENGINE|APP)-->/g);
  if (remaining) {
    console.warn(`Warning: unreplaced placeholders in ${appRelPath}: ${remaining.join(', ')}`);
  }

  // Output filename = last component of the path
  const outName = path.basename(appRelPath) + '.html';
  const outPath = path.join(DIST, outName);
  fs.writeFileSync(outPath, html);
  console.log(`Built ${appRelPath} -> ${outName}: ${(html.length / 1024).toFixed(0)}KB`);
}

// Ensure dist exists
fs.mkdirSync(DIST, { recursive: true });

// Copy the SDK bundle and its worker entrypoints built by build:sdk.
const bundleSrc = path.join(SHARED, 'aztec_bundle.js');
const bundleDst = path.join(DIST, 'aztec_bundle.js');
if (!fs.existsSync(bundleSrc)) throw new Error('Missing SDK bundle; run npm run build:sdk first.');
fs.copyFileSync(bundleSrc, bundleDst);
console.log('Copied aztec_bundle.js to dist/ (' + Math.round(fs.statSync(bundleDst).size/1024/1024) + 'MB)...');
for (const worker of ['main.worker.js', 'thread.worker.js']) {
  if (!fs.existsSync(path.join(SHARED, worker))) throw new Error(`Missing ${worker}; run npm run build:sdk first.`);
  fs.copyFileSync(path.join(SHARED, worker), path.join(DIST, worker));
}

// Ensure CRS files are in dist/crs/
const crsSrc = path.join(DIST, 'crs');
if (fs.existsSync(crsSrc)) {
  // Already there
} else {
  // Try copying from billboard dist
  const bbCrs = path.join(__dirname, '..', 'billboard', 'app', 'dist', 'crs');
  if (fs.existsSync(bbCrs)) {
    console.log('Copying CRS files to dist/crs/...');
    fs.mkdirSync(crsSrc, { recursive: true });
    for (const f of fs.readdirSync(bbCrs)) {
      fs.copyFileSync(path.join(bbCrs, f), path.join(crsSrc, f));
    }
  }
}

// Get app paths from command line args, or scan src/ recursively for template.html
const args = process.argv.slice(2);
if (args.length > 0) {
  for (const app of args) buildApp(app);
} else {
  // Recursively find all directories containing template.html
  function findApps(dir, base) {
    const apps = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(fullPath, 'template.html'))) {
        apps.push(relPath);
      }
      // Recurse into subdirectories
      apps.push(...findApps(fullPath, relPath));
    }
    return apps;
  }
  const apps = findApps(SRC, '');
  if (apps.length === 0) {
    console.log('No apps found in src/');
  } else {
    for (const app of apps) buildApp(app);
  }
}
