// Local-only node/PXE integration. --real-proofs independently verifies posts'
// client proofs; the local rollup itself still runs in synthetic-proof mode.
// Run npm run build:df and npm run start:local before this script.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec/stdlib/interfaces/client';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Contract } from '@aztec/aztec.js/contracts';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { Fr } from '@aztec/aztec.js/fields';
import { Tx } from '@aztec/aztec.js/tx';
import { encodeDFMessage, decodeDFMessage } from '../shared/df-billboard.mjs';

const node = createAztecNodeClient('http://127.0.0.1:5180');
const debug = createAztecNodeDebugClient('http://127.0.0.1:5180');
async function waitForLocalNode() {
  const deadline = Date.now() + 120_000;
  while (true) {
    try { return await node.getNodeInfo(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
const info = await waitForLocalNode();
assert.equal(info.l1ChainId, 31337, 'Refusing non-local chain');
assert.equal(info.nodeVersion, '5.0.1');
assert.equal(info.realProofs, false, 'Expected synthetic-proof local network');
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
const realProofs = process.argv.includes('--real-proofs');
const useDFCore = process.argv.includes('--df-core');
let verifier;
let verifiedProofs = 0;
let verifyNext = false;
const originalSend = node.sendTx.bind(node);
node.sendTx = async tx => {
  if (verifyNext) {
    assert.equal((await verifier.verifyProof(tx)).valid, true, 'Client proof must verify');
    const tampered = Tx.fromBuffer(tx.toBuffer());
    tampered.chonkProof.fields[0] = tampered.chonkProof.fields[0].add(Fr.ONE);
    assert.equal((await verifier.verifyProof(tampered)).valid, false, 'Tampered proof must fail');
    verifiedProofs++;
    console.log('PASS real client proof verified; tampered proof rejected');
  }
  return originalSend(tx);
};
let advancing = false;
const clock = setInterval(async () => {
  if (advancing) return;
  advancing = true;
  // DF validates a 300-second timestamp window; do not race its heavier proof
  // generation by advancing local time seven times faster than wall time.
  try { await debug.warpL2TimeAtLeastBy(useDFCore ? 12 : 72); }
  catch (error) { console.error('Local clock:', error.message); }
  finally { advancing = false; }
}, 10000);
const artifact = name => loadContractArtifact(JSON.parse(fs.readFileSync(new URL(`../df-billboard/target/${name}.json`, import.meta.url))));
try {
  if (realProofs) {
    const { BBCircuitVerifier } = await import('@aztec/bb-prover/verifier');
    verifier = await BBCircuitVerifier.new({
      bbWorkingDirectory: fileURLToPath(new URL('../.local/df-verifier', import.meta.url)),
      numConcurrentIVCVerifiers: 1,
    });
  }
  const accounts = await getInitialTestAccountsData();
  for (const a of accounts) await wallet.createSchnorrInitializerlessAccount(a.secret, a.salt, a.signingKey);
  const admin = accounts[0].address;
  const owner = accounts[1].address;
  const outsider = accounts[2].address;
  const send = async (call, from = owner) => {
    const result = await call.send({ from });
    assert.equal(result.receipt.executionResult, 'success');
    return result;
  };
  const sendPrivate = async call => {
    wallet.pxe.proverEnabled = realProofs;
    verifyNext = realProofs;
    try { return await send(call); }
    finally { wallet.pxe.proverEnabled = false; verifyNext = false; }
  };
  const view = async call => {
    const value = await call.simulate({ from: outsider });
    return value.result ?? value;
  };
  let source;
  let dfCore;
  let state = {
    init_timestamp: 1n, home_planet_id: 42n, last_reveal_timestamp: 0n,
    score: 0n, space_junk: 0n, space_junk_limit: 0n, claimed_ships: false, last_updated: 1n,
  };
  if (useDFCore) {
    const { initializeDFPlayer } = await import('./df-core-fixture.mjs');
    const fixture = await initializeDFPlayer({ wallet, node, owner, admin, outsider, send, sendPrivate, view });
    source = fixture.source;
    state = fixture.state;
    dfCore = fixture.metadata;
  } else {
    ({ contract: source } = await Contract.deploy(wallet, artifact('player-PlayerStorage'), [admin]).send({ from: admin }));
    await send(source.methods.set(owner, state), admin);
    console.log('PASS real PlayerStorage deployment and state write');
  }
  const { contract: board } = await Contract.deploy(wallet, artifact('df_billboard-DFBillboard'), [source.address]).send({ from: admin });
  const message = '黑暗森林：匿名入局资格 → 公开消息 🌲';
  const { text, length } = encodeDFMessage(message);
  await assert.rejects(() => board.methods.post(state, text, length).simulate({ from: outsider }), /Player not registered/);
  await assert.rejects(() => board.methods.post({ ...state, score: 100n }, text, length).simulate({ from: owner }), /Invalid DF player state/);
  const posted = await sendPrivate(board.methods.post(state, text, length));
  const [fields, byteLength] = await view(board.methods.get_post(0));
  assert.equal(decodeDFMessage(fields, byteLength), message);
  const second = await sendPrivate(board.methods.post(state, text, length));
  assert.equal(BigInt(await view(board.methods.get_post_count())), 2n);
  await assert.rejects(() => board.methods._publish(Array(17).fill(0n), 1).simulate({ from: outsider }), /only be called by the same contract/);
  console.log('PASS first post validates DF entry; second post reuses private rolling history');
  console.log('PASS outsider reads without eligibility; forged state, outsider and public bypass rejected');
  const result = {
    completedAt: new Date().toISOString(), nodeVersion: info.nodeVersion,
    rollupRealProofs: false, clientRealProofs: realProofs, verifiedProofs,
    playerStorage: source.address.toString(), board: board.address.toString(),
    postTx: posted.receipt.txHash.toString(), secondPostTx: second.receipt.txHash.toString(), message,
    qualificationFixture: useDFCore ? 'Core.initialize_player with ZK checks enabled; PlayerUpdate from chain' : 'Real PlayerStorage.set by admin; not Core.initialize_player',
    dfCore,
  };
  assert.equal(verifiedProofs, realProofs ? (useDFCore ? 3 : 2) : 0);
  fs.writeFileSync(new URL(`../.local/df-e2e${useDFCore ? '-core' : ''}${realProofs ? '-real' : ''}-result.json`, import.meta.url), JSON.stringify(result, null, 2));
  console.log('DF LOCAL E2E PASSED');
} finally {
  clearInterval(clock);
  await wallet.stop();
  await verifier?.stop();
}
