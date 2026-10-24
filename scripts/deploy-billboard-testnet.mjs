import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, adapters, verifyDeployment } from './testnet/network.mjs';
import { atomicJson, openJournal, publicManifest, runStage } from './testnet/state.mjs';
import { buildRelease } from './testnet/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: path.join(root, 'scripts/testnet/config.json') },
  state: { type: 'string', default: path.join(root, '.local/testnet/deployment.json') },
  'key-file': { type: 'string' }, out: { type: 'string' },
  broadcast: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
const action = positionals[0] ?? 'plan';
if (values.help) {
  console.log(`Billboard public testnet deployment
  plan                         Read-only network/artifact/sponsor checks (default)
  deploy --broadcast           Start/resume using the private journal
  status                       Inspect confirmed/pending stages; never broadcast
  export --out FILE            Verify on chain, export public manifest only
  release --out DIRECTORY      Verify, build isolated Vercel prebuilt package
Options: --config FILE --state FILE --key-file FILE
The key file is read ONLY when preparing the first L1 deploy with --broadcast.
Resume uses recorded transactions. No private keys belong in Vercel.`);
} else {
  assert(positionals.length <= 1 && ['plan', 'deploy', 'status', 'export', 'release'].includes(action), 'Unknown command; use --help');
  assert(action !== 'deploy' || values.broadcast, 'Deployment requires explicit --broadcast; use plan for read-only checks');
  assert(!values.broadcast || action === 'deploy', '--broadcast is only allowed with deploy');
  assert(!values['key-file'] || action === 'deploy', '--key-file is only allowed with deploy');
  assert(!['export', 'release'].includes(action) || values.out, 'Export/release requires --out');
  const config = JSON.parse(fs.readFileSync(values.config, 'utf8'));
  const context = await connect(config);
  let journal;
  try {
    if (action === 'plan') {
      console.log(JSON.stringify({ ...context.binding, sponsorBalance: context.sponsorBalance.toString(),
        warning: 'Balance does not guarantee sponsorship. No keys loaded or transactions sent.',
        order: ['Sepolia BillboardInbox', 'Aztec DFBillboard (real proofs, Sponsored FPC)'],
      }, null, 2));
    } else {
      assert(action === 'deploy' || fs.existsSync(values.state), 'No deployment journal exists');
      journal = openJournal(path.resolve(values.state), context.binding);
      const stages = adapters(context, journal, values['key-file']);
      if (action === 'deploy') {
        if (!journal.state.l2?.confirmed) {
          assert(context.sponsorBalance > 0n, 'Sponsored FPC is empty; stop before spending L1 gas');
        }
        for (const name of ['l1', 'l2']) {
          console.log(`Deploy/resume ${name}; checkpoint: ${path.resolve(values.state)}`);
          const stage = await runStage(journal, name, stages[name]);
          console.log(`${name}: ${stage.address} · ${stage.hash} · confirmed`);
        }
        console.log('Contracts confirmed. Use export or release; the local website is unchanged.');
      } else if (action === 'status') {
        for (const name of ['l1', 'l2']) {
          const stage = journal.state[name];
          if (!stage) { console.log(`${name}: not prepared`); continue; }
          await stages[name].validate(stage);
          const receipt = await stages[name].receipt(stage);
          if (receipt) await stages[name].verify(stage, receipt);
          console.log(`${name}: ${stage.address} · ${stage.hash} · ${receipt ? 'confirmed on chain' : 'pending/unknown; use deploy --broadcast to resume'}`);
        }
      } else {
        await verifyDeployment(journal, stages);
        const manifest = publicManifest(journal.state);
        if (action === 'export') {
          assert(!fs.existsSync(values.out), 'Refusing to overwrite an existing export');
          atomicJson(path.resolve(values.out), manifest);
          console.log(`Public manifest: ${path.resolve(values.out)}`);
        } else {
          await buildRelease(manifest, path.resolve(values.out));
        }
      }
    }
  } finally {
    journal?.close();
    context.close();
  }
}
