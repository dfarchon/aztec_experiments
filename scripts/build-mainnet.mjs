// Kept as an explicit mainnet entrypoint for existing release commands.
import { parseArgs } from 'node:util';
import { buildPublicFrontend } from './build-public-frontend.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
await buildPublicFrontend({ network: 'mainnet', out: values.out });
