// Nargo/Aztec 5.0.1 git dependencies accept branch/tag names, not commit SHAs.
// Materialize an exact, read-only upstream revision without touching the user's DF checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const revision = 'b84e73986a6b4a1d8a7bf0f518e8f297e271b866';
const destination = fileURLToPath(new URL('../.local/df-upstream', import.meta.url));
const git = (...args) => execFileSync('git', ['-C', destination, ...args], { encoding: 'utf8' }).trim();
if (!existsSync(destination)) {
  mkdirSync(destination, { recursive: true });
  git('init');
  git('fetch', '--depth=1', 'https://github.com/dfarchon/dark-forest-aztec.git', revision);
  git('checkout', '--detach', 'FETCH_HEAD');
}
if (git('rev-parse', 'HEAD') !== revision || git('status', '--porcelain', '--untracked-files=normal')) {
  throw new Error(`Upstream dependency must be clean at ${revision}: ${destination}. No files were reset.`);
}
console.log(`DF source verified: ${revision}`);
