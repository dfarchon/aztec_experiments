import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillboardController } from './controller.ts';
import { AI_MODEL_VERSION, AI_CATEGORY_THRESHOLDS, AI_CACHE_NAME } from './ai-config.ts';

const address = `0x${'1'.repeat(64)}`;
const player = { init_timestamp: 100n, home_planet_id: 1n, last_reveal_timestamp: 0n,
  score: 0n, space_junk: 0n, space_junk_limit: 100n, claimed_ships: false, last_updated: 100n };

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
function pack(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(527);
  padded.set(bytes);
  return [Array.from({ length: 17 }, (_, i) => [...padded.slice(i * 31, (i + 1) * 31)]
    .reduce((value, byte) => (value << 8n) + BigInt(byte), 0n)), bytes.length];
}

function fixture(t, { brokenChain = false, joinFailures = 0, occupiedCandidates = 0 } = {}) {
  const deployment = { nodeUrl: 'http://127.0.0.1:5180', rollupAddress: 'rollup',
    core: 'core', config: 'config', playerStorage: 'player', board: 'board', sponsoredFpc: 'sponsor', worldRadius: 100, contracts:{PlanetStorage:'planet'} };
  const account = { address, secretKey: '0x123', salt: '0', signingKey: '456', label: 'Test player' };
  const calls = [];
  let joined = false;
  const posts = [pack('hello forest'), [[], 1], pack('<img src=x>')];
  const globals = { window: {}, location: new URL('http://127.0.0.1:5001/df-billboard-test.html'),
    localStorage: storage(), sessionStorage: storage() };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(['fetch', url]);
    if (url === '/df-local.json') return { ok: true, json: async () => deployment };
    if (url === '/df-local-accounts.json') return { ok: true, json: async () => [account, { ...account, label: 'Player 2' }] };
    const name = /^\/df-(\w+)-artifact.json$/.exec(url)?.[1];
    return { ok: Boolean(name), json: async () => ({ name,
      functions: [{ name: 'initialize_player', parameters: [{ name: 'timestamp', type: { kind: 'field' } }] }],
      outputs: { structs: { events: [{ path: 'player::PlayerUpdate', fields: [] }] } } }) };
  });
  t.mock.method(console, 'error', () => {});
  class Fr {
    static MODULUS = 1n << 254n;
    constructor(value) { this.value = value; }
    toBuffer() { return new Uint8Array(32); }
    toString() { return String(this.value); }
    static fromString(value) { return new Fr(value); }
  }
  const simulate = value => ({ simulate: async () => ({ result: value }) });
  const config = { get_snark_config: () => simulate({ disable_zk_checks: false, planethash_key: 1,
    spacetype_key: 1, perlin_length_scale: 1 }),
  get_game_config_core: () => simulate({ max_location_id: 100n, init_perlin_min: 0, init_perlin_max: 32 }),
  get_planet_level_thresholds: () => simulate({ thresholds: [0, 0] }) };
  for (const method of ['get_planet_default_stats', 'get_world_config', 'get_space_junk_config', 'get_planet_type_weights_tier']) {
    config[method] = () => simulate({});
  }
  const node = { getNodeInfo: async () => ({ l1ChainId: 31337, rollupVersion: 1, nodeVersion: brokenChain ? 'wrong' : '5.0.1' }),
    getL1ContractAddresses: async () => ({ rollupAddress: 'rollup' }),
    getContract: async address => ({ address }), getBlock: async () => ({ header: { globalVariables: { timestamp: 100n } } }) };
  const sdk = { Fr, Fq: { fromString: value => value }, AztecAddress: { ZERO: '0', fromStringUnsafe: value => value },
    loadContractArtifact: value => value,
    getContractInstanceFromInstantiationParams: async () => ({ address: 'sponsor' }),
    SponsoredFeePaymentMethod: class { constructor(address) { this.address = address; } },
    EventSelector: { fromString: value => value },
    getPublicEvents: async () => ({ events: [{ event: { id: address, state: player } }] }),
    Contract: { at: async (address, artifact) => ({ methods: artifact.name === 'core' ? {
      initialize_player: timestamp => ({ simulate: async () => { calls.push(['simulateJoin', timestamp]);
        if (joinFailures-- > 0) throw new Error('Timestamp too old'); },
        send: async options => { calls.push(['join', options]); joined = true; return { receipt: { executionResult: 'success', txHash: 'join-tx' } }; } }),
    } : artifact.name === 'config' ? config : artifact.name === 'planet' ? {is_initialized:()=>{
      calls.push(['checkPlanet']); return simulate(occupiedCandidates-- > 0);
    }} : artifact.name === 'player' ? {
      is_initialized: () => simulate(joined), verify: () => simulate(true),
    } : artifact.name === 'board' ? {
      get_post_count: () => simulate(posts.length), get_post: id => simulate(posts[id]),
      post: (state, bytes, length) => ({ send: async options => {
        calls.push(['post', state, bytes, length, options]);
        posts.push(pack(new TextDecoder().decode(new Uint8Array(bytes.slice(0, length)))));
        return { receipt: { executionResult: 'success', txHash: 'post-tx' } };
      } }),
    } : {} }) },
  };
  window.__dfHash = { initPoseidon2: async () => {}, perlin: () => 13,
    BarretenbergSync: { getSingleton: () => ({ poseidon2Hash: () => ({ hash: new Uint8Array(32) }) }) } };
  const controller = createBillboardController({ sdk: () => sdk,
    deriveAccountAddress: async () => ({ address }), ensureAztecSetup: async (state, _, options) => {
      options.onProgress(1, 8, '测试钱包');
      Object.assign(state, { address, wallet: {}, pxe: { registerContractClass: async () => {}, registerContract: async () => {} }, aztecNode: node });
      return true;
    } });
  t.after(() => controller.dispose());
  return { controller, calls, address, sdk, node };
}

test('initialization is idempotent, subscribable and does not publish test keys', async t => {
  const { controller, calls } = fixture(t);
  const initial = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), initial);
  let updates = 0;
  const unsubscribe = controller.subscribe(() => updates++);
  await Promise.all([controller.initialize(), controller.initialize()]);
  assert.equal(calls.filter(call => call[1] === '/df-local.json').length, 1);
  assert.ok(updates > 0);
  assert.equal(controller.getSnapshot().account, '1');
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('secretKey'), false);
  assert.equal(initial.deployment, null);
  unsubscribe();
  const previous = updates;
  controller.setField('message', 'hello');
  assert.equal(updates, previous);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
  controller.confirmAiHints();
  assert.equal(controller.getSnapshot().aiStatus, '没有可分析的消息。');
  controller.setAiHints(false);
});

test('legacy reading preferences migrate without granting new model consent', async t => {
  const { controller } = fixture(t);
  const key = 'df-signal:reading-preferences:v2';
  localStorage.setItem(key, JSON.stringify({ mergeDuplicates: false, adMode: 'fold', aiHints: true }));
  await controller.initialize();
  assert.equal(controller.getSnapshot().mergeDuplicates, false);
  assert.equal(controller.getSnapshot().adEnabled, true);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentGiven, false);
  controller.setField('adMode', 'fold');
  controller.setField('mergeDuplicates', 'false');
  assert.equal(controller.getSnapshot().adEnabled, true);
  assert.equal(controller.getSnapshot().mergeDuplicates, false);
  controller.setField('adEnabled', false);
  controller.setField('mergeDuplicates', true);
  const saved = JSON.parse(localStorage.getItem('df-signal:reading-preferences:v4'));
  assert.equal(saved.mergeDuplicates, true);
  assert.equal(saved.adEnabled, false);
  assert.equal(saved.aiConsentVersion, null);
});

test('old hint-only preferences do not silently enable promotion or AI folding', async t => {
  const { controller } = fixture(t);
  localStorage.setItem('df-signal:reading-preferences:v3', JSON.stringify({
    adEnabled: true, adMode: 'hint', aiHints: true, aiConsentVersion: AI_MODEL_VERSION,
    keywordEnabled: true, keywords: ['代练'],
  }));
  await controller.initialize();
  const view = controller.getSnapshot();
  assert.equal(view.adEnabled, false);
  assert.equal(view.aiHints, false);
  assert.equal(view.aiConsentGiven, false);
  assert.equal(view.keywordEnabled, true);
  assert.deepEqual(view.keywords, ['代练']);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
});

test('malformed preferences and unavailable preference storage do not block reading controls', async t => {
  const { controller } = fixture(t);
  localStorage.setItem('df-signal:reading-preferences:v2', 'broken');
  await controller.initialize();
  assert.equal(controller.getSnapshot().adEnabled, false);
  t.mock.method(localStorage, 'setItem', () => { throw new Error('quota'); });
  assert.doesNotThrow(() => controller.setField('adEnabled', true));
  assert.equal(controller.getSnapshot().adEnabled, true);
});

test('wallet -> Core.initialize_player wiring -> sponsored post preserves state and message decoding', async t => {
  const { controller, calls } = fixture(t);
  await controller.initialize();
  controller.setField('walletMode', 'test');
  await controller.connect();
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().address, address);
  assert.equal(controller.getSnapshot().canPost, false);
  assert.equal(controller.getSnapshot().posts[1].decodeError, true);
  assert.equal(controller.getSnapshot().posts[2].text, '<img src=x>');
  controller.setField('walletMode', 'extension');
  assert.equal(controller.getSnapshot().walletMode, 'test');
  await controller.join();
  assert.equal(controller.getSnapshot().joined, true);
  assert.equal(controller.getSnapshot().canPost, true);
  assert.equal(calls.find(call => call[0] === 'simulateJoin')[1], 100n);
  controller.setField('message', '你好，森林');
  await controller.post();
  const sent = calls.find(call => call[0] === 'post');
  assert.equal(sent[3], new TextEncoder().encode('你好，森林').length);
  assert.equal(sent[4].fee.paymentMethod.address, 'sponsor');
  assert.equal(controller.getSnapshot().posts.at(-1).text, '你好，森林');
  assert.equal(controller.getSnapshot().busy, false);
});

test('failed connection exits busy state and records a useful error', async t => {
  const { controller } = fixture(t, { brokenChain: true });
  await controller.initialize();
  controller.setField('walletMode', 'test');
  await controller.connect();
  assert.equal(controller.getSnapshot().busy, false);
  assert.ok(controller.getSnapshot().logs.some(entry => entry.message.includes('部署信息与本地链不匹配')));
  assert.equal(controller.getSnapshot().progress.failed, true);
  assert.equal(controller.getSnapshot().connected, false);
  assert.equal(controller.getSnapshot().address, '');
});

test('failed join retains reason across refresh, does not send, and can retry',async t=>{
  const {controller,calls}=fixture(t,{joinFailures:1});
  await controller.initialize();controller.setField('walletMode','test');await controller.connect();
  await controller.join();
  assert.equal(controller.getSnapshot().busy,false);
  assert.equal(controller.getSnapshot().actionError.label,'DF 入局');
  assert.match(controller.getSnapshot().actionError.guidance,/sync-df-clock/);
  assert.equal(calls.filter(call=>call[0]==='join').length,0);
  await controller.refresh();
  assert.equal(controller.getSnapshot().actionError.message,'Timestamp too old');
  await controller.join();
  assert.equal(controller.getSnapshot().actionError,null);
  assert.equal(controller.getSnapshot().joined,true);
});

test('join skips a spawn already initialized by another local player',async t=>{
  const {controller,calls}=fixture(t,{occupiedCandidates:1});
  await controller.initialize();controller.setField('walletMode','test');await controller.connect();await controller.join();
  assert.equal(calls.filter(call=>call[0]==='checkPlanet').length,2);
  assert.equal(controller.getSnapshot().joined,true);
});

test('extension discovery, emoji confirmation and capability grants preserve the connection flow', async t => {
  const { controller, sdk, node } = fixture(t);
  let confirmed = 0;
  const provider = { id: 'azguard', name: 'Azguard',
    establishSecureChannel: async () => ({ verificationHash: 'test', cancel() {}, confirm: async () => {
      confirmed++;
      return { registerContract: async () => {}, requestCapabilities: async () => ({ granted: [
        { type: 'accounts', accounts: [{ alias: 'Test', item: address }] },
        { type: 'contracts', canRegister: true, contracts: '*' },
        { type: 'simulation', utilities: { scope: '*' }, transactions: { scope: '*' } },
        { type: 'transaction', scope: '*' },
      ] }) };
    } }), disconnect: async () => {} };
  sdk.createAztecNodeClient = () => node;
  sdk.hashToEmoji = () => ['🌲', '🌎'];
  sdk.WalletManager = { configure: () => ({ getAvailableWallets: () => ({
    wallets: (async function* () { yield provider; })(), done: Promise.resolve(), cancel() {},
  }) }) };
  await controller.initialize();
  controller.setField('walletMode', 'extension');
  await controller.connect();
  assert.equal(controller.getSnapshot().pendingConnection, true);
  assert.equal(controller.getSnapshot().verification, true);
  assert.equal(controller.getSnapshot().emoji, '🌲 🌎');
  assert.equal(confirmed, 0);
  await controller.confirmWallet();
  assert.equal(confirmed, 1);
  assert.equal(controller.getSnapshot().connected, true);
  assert.equal(controller.getSnapshot().verification, false);
  assert.equal(controller.getSnapshot().walletOpen, false);
});

test('AI publishes labels to subscribers, reuses cache and stops when disabled', async t => {
  const { controller } = fixture(t);
  let requests = 0;
  let terminated = 0;
  for (const [key, value] of Object.entries({ __DF_TOXICITY_WORKER_HASH__: 'test', Worker: class {
    postMessage({ id, texts }) {
      requests++;
      queueMicrotask(() => this.onmessage({ data: { id,
        results: texts.map(() => ({ scores: { ...Object.fromEntries(Object.keys(AI_CATEGORY_THRESHOLDS).map(key => [key, 0])), unsafe: 0.9, harassment: 0.8 } })) } }));
    }
    terminate() { terminated++; }
  } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const analyzed = async () => {
    for (let i = 0; i < 100; i++) {
      if (controller.getSnapshot().aiStatus.startsWith('AI 已分析')) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(controller.getSnapshot().aiStatus);
  };
  await controller.initialize();
  controller.setField('walletMode', 'test');
  await controller.connect();
  controller.confirmAiHints();
  await analyzed();
  assert.deepEqual(controller.getSnapshot().posts[0].aiLabels, ['harassment']);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, true);
  assert.equal(requests, 1);
  controller.setAiHints(false);
  assert.equal(terminated, 1);
  controller.setAiHints(true);
  await analyzed();
  assert.equal(requests, 1);
  assert.match(controller.getSnapshot().aiStatus, /0 条新分析/);
});

test('keyword settings validate input, persist and remain independent of rules and AI', async t => {
  const { controller } = fixture(t);
  await controller.initialize();
  assert.equal(controller.saveKeywords('代练\nVPN\nvpn\n'), true);
  controller.setField('keywordEnabled', true);
  controller.setField('adEnabled', false);
  controller.setField('keywordMode', 'word');
  assert.deepEqual(controller.getSnapshot().keywords, ['代练', 'VPN']);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.saveKeywords('长'.repeat(81)), false);
  assert.deepEqual(controller.getSnapshot().keywords, ['代练', 'VPN']);
  const saved = JSON.parse(localStorage.getItem('df-signal:reading-preferences:v4'));
  assert.equal(saved.keywordEnabled, true);
  assert.equal(saved.keywordMode, 'word');
  assert.equal(saved.adEnabled, false);
  assert.equal(saved.aiHints, false);
});

test('new folding settings restore AI only with explicit consent for this model revision', async t => {
  const { controller } = fixture(t);
  localStorage.setItem('df-signal:reading-preferences:v4', JSON.stringify({
    keywords: ['代练'], keywordEnabled: true, adEnabled: false, aiHints: true, aiConsentVersion: AI_MODEL_VERSION,
  }));
  await controller.initialize();
  assert.equal(controller.getSnapshot().aiHints, true);
  assert.deepEqual(controller.getSnapshot().keywords, ['代练']);
  assert.equal(controller.getSnapshot().adEnabled, false);
  controller.setAiHints(false);
  assert.equal(JSON.parse(localStorage.getItem('df-signal:reading-preferences:v4')).aiHints, false);
});

test('new model revision invalidates old consent', async t => {
  const { controller } = fixture(t);
  localStorage.setItem('df-signal:reading-preferences:v4', JSON.stringify({ aiHints: true, aiConsentVersion: 'old-model' }));
  await controller.initialize();
  assert.equal(controller.getSnapshot().aiHints, false);
  controller.setAiHints(true);
  assert.equal(controller.getSnapshot().aiConsentOpen, true);
  controller.setAiHints(false);
  assert.equal(controller.getSnapshot().aiConsentOpen, false);
});

test('clear model cache is scoped and preserves wallet keys and personal keywords', async t => {
  const { controller } = fixture(t);
  const deleted = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { delete: async name => {deleted.push(name);return true;} } });
  t.after(() => descriptor ? Object.defineProperty(globalThis,'caches',descriptor) : delete globalThis.caches);
  await controller.initialize();
  localStorage.setItem('df-signal:accounts:rollup', 'keep-wallet-data');
  controller.saveKeywords('代练');
  controller.setField('keywordEnabled', true);
  controller.confirmAiHints();
  await controller.clearAiCache();
  assert.deepEqual(deleted, [AI_CACHE_NAME]);
  assert.equal(localStorage.getItem('df-signal:accounts:rollup'), 'keep-wallet-data');
  assert.deepEqual(controller.getSnapshot().keywords, ['代练']);
  assert.equal(controller.getSnapshot().keywordEnabled, true);
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().aiConsentGiven, false);
  assert.equal(controller.getSnapshot().aiClearing, false);
});

test('model failures preserve posts, rules and keywords; late cancelled results are ignored', async t => {
  const { controller } = fixture(t);
  let instance;
  for (const [key, value] of Object.entries({ __DF_TOXICITY_WORKER_HASH__: 'test', Worker: class {
    constructor() { instance = this; }
    postMessage(message) { this.message = message; }
    terminate() {}
  } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  await controller.initialize();
  controller.setField('walletMode', 'test');
  await controller.connect();
  controller.saveKeywords('forest');
  controller.setField('keywordEnabled', true);
  controller.confirmAiHints();
  for (let i = 0; i < 100 && !instance?.message; i++) await new Promise(r => setTimeout(r, 5));
  const stale = instance;
  assert.ok(stale.message);
  stale.onmessage({ data: { id: stale.message.id, progress: { file: 'model.onnx', loaded: 50, total: 100 } } });
  assert.equal(controller.getSnapshot().aiProgress.percent, 50);
  controller.setAiHints(false);
  stale.onmessage({ data: { id: stale.message.id, results: [] } });
  assert.equal(controller.getSnapshot().aiHints, false);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, undefined);
  instance = null;
  controller.setAiHints(true);
  for (let i = 0; i < 100 && !instance?.message; i++) await new Promise(r => setTimeout(r, 5));
  instance.onmessage({ data: { id: instance.message.id, error: 'download failed' } });
  await new Promise(r => setTimeout(r, 10));
  assert.match(controller.getSnapshot().aiStatus, /不可用/);
  assert.equal(controller.getSnapshot().posts.length, 3);
  assert.equal(controller.getSnapshot().keywordEnabled, true);
  assert.equal(controller.getSnapshot().adEnabled, false);
  assert.equal(controller.getSnapshot().posts[0].aiAnalyzed, undefined);
});
