import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { frontendEnvironment, frontendManifest, publicBoardArtifact, root } from './public-frontend.mjs';
import { buildRelease } from './testnet/release.mjs';

export async function buildPublicFrontend({ network, out, netlify = false } = {}) {
  const env = frontendEnvironment();
  const selected = network ?? env.NOTCH_NETWORK;
  const manifest = frontendManifest(selected, env);
  // Only this dedicated CI output is replaced; journal/release directories are untouched.
  const destination = netlify ? path.join(root, '.local/netlify')
    : path.resolve(out ?? path.join(root, `.local/releases/notch-${selected}`));
  if (netlify) fs.rmSync(destination, { recursive: true, force: true });
  console.log(`Building Notch ${selected} frontend (RPC values omitted from logs).`);
  await buildRelease(manifest, destination, 'netlify', { boardArtifact: publicBoardArtifact });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    network: { type: 'string' }, out: { type: 'string' }, netlify: { type: 'boolean', default: false },
  } });
  if (values.netlify && values.out) throw new Error('--out cannot be combined with --netlify');
  await buildPublicFrontend({ network: values.network, out: values.out, netlify: values.netlify });
}
