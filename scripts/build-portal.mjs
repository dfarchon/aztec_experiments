import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: `${root}/billboard/portal`, stdio: 'inherit' });
execFileSync('aztec-forge', ['build', '--use', '0.8.33', '--out', `${root}/.local/portal-out`, '--cache-path', `${root}/.local/portal-cache`], { cwd: `${root}/billboard/portal`, stdio: 'inherit' });
const artifact = JSON.parse(fs.readFileSync(`${root}/.local/portal-out/BillboardPortal.sol/BillboardPortal.json`));
for (const relative of ['apps/src/billboard/portal_bytecode.txt', 'apps/src/billboard/deploy/portal_bytecode.txt']) {
  fs.writeFileSync(`${root}/${relative}`, artifact.bytecode.object);
}
