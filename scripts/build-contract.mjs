import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('aztec', ['compile'], { cwd: `${root}/billboard`, stdio: 'inherit' });
execFileSync(process.execPath, [`${root}/apps/src/billboard/build_artifact.mjs`], { stdio: 'inherit' });
