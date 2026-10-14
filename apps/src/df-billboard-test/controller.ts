// @ts-nocheck -- The legacy Aztec wallet adapter is migrated without changing transaction behavior.
// Its public surface remains typed; internal SDK state can be tightened separately.
import type { BillboardController } from './types';
import { encodeDFMessage, decodeDFMessage } from '../../../shared/df-billboard.mjs';
import { classifyRulePosts } from './moderation.ts';
import { parseKeywords } from './keywords.ts';
import { AI_MODEL_VERSION, AI_CACHE_NAME, safetyResult } from './ai-config.ts';

// The controller owns wallet/chain operations, never page DOM. React subscribes
// to immutable public snapshots; secret keys and SDK objects stay private here.
export function createBillboardController(deps = {}): BillboardController {
  const A = deps.sdk || (() => window.__aztec);
  const deriveAccountAddress = deps.deriveAccountAddress || ((...args) => window.deriveAccountAddress(...args));
  const ensureAztecSetup = deps.ensureAztecSetup || ((...args) => window.ensureAztecSetup(...args));
  const listeners = new Set();
  let disposed = false;
  let initializing;
  let copyTimer;
  let logId = 0;
  let view = {
    busy: false, connected: false, address: '', joined: false, canPost: false, hasLocalAccount: false,
    walletOpen: false, walletMode: 'create', savedAccounts: [], savedAccount: '',
    accounts: [], account: '0', accountLabel: '', accountFile: null, fileVersion: 0, realProofs: false,
    providers: [], provider: '0', pendingConnection: false, verification: false, emoji: '',
    grantedAccounts: [], grantedAccount: '0', deployment: null, progress: null, actionError: null,
    localStatus: '等待初始化本地钱包', extensionStatus: '等待连接 Azguard',
    joinedStatus: '连接钱包后检查入局状态', copied: false, message: '', logs: [],
    posts: [], feedLoaded: false, mergeDuplicates: true, aiHints: false, aiStatus: 'AI 折叠未启用',
    adEnabled: false, keywordEnabled: false, keywords: [], keywordMode: 'contains', keywordError: '',
    aiConsentGiven: false, aiConsentOpen: false, aiProgress: null, aiClearing: false,
  };
  function patch(changes) {
    if (disposed) return;
    view = { ...view, ...changes };
    listeners.forEach(listener => listener());
  }
  function log(message, type = 'info') {
    patch({ logs: [...view.logs.slice(-299), { id: ++logId, message: String(message), type,
      time: new Date().toLocaleTimeString() }] });
  }
  const state = { wallet: null, pxe: null, crsInit: false, localAccount: null, feePaymentMethod: null, posts: [] };
  let deployment;
  let accounts;
  let contracts;
  let providers = [];
  let pendingConnection = null;
  let busy = false;
  let progressHideTimer;
  let aiWorker;
  let aiRequestId = 0;
  let aiGeneration = 0;
  let aiNeedsRun = false;
  const aiPending = new Map();
  const AI_REQUEST_TIMEOUT_MS = 600_000;
  const preferencesKey = 'df-signal:reading-preferences:v4';
  function savePreferences() {
    try { localStorage.setItem(preferencesKey, JSON.stringify({
      mergeDuplicates: view.mergeDuplicates, adEnabled: view.adEnabled,
      keywordEnabled: view.keywordEnabled, keywords: view.keywords, keywordMode: view.keywordMode,
      aiHints: view.aiHints, aiConsentVersion: view.aiConsentGiven ? AI_MODEL_VERSION : null,
    })); } catch { /* Restricted/full storage: controls still work in this session. */ }
  }
  const playerFields = ['init_timestamp', 'home_planet_id', 'last_reveal_timestamp', 'score',
    'space_junk', 'space_junk_limit', 'claimed_ships', 'last_updated'];

  function showProgress(label, step, total) {
    clearTimeout(progressHideTimer);
    const determinate = Number.isFinite(step) && Number.isFinite(total) && total > 0;
    patch({ progress: { label, failed: false, total: determinate ? total : 1,
      value: determinate ? Math.min(Math.max(step, 0), total) : undefined,
      count: determinate ? `${step}/${total}` : '进行中' } });
  }
  function finishProgress(label, succeeded) {
    showProgress(`${label}${succeeded ? '已完成' : '失败'}`, succeeded ? 1 : 0, 1);
    patch({ progress: { ...view.progress, failed: !succeeded } });
    progressHideTimer = setTimeout(() => patch({ progress: null }), succeeded ? 2500 : 6000);
  }

  // Like DF's embedded wallet, local accounts are saved in this browser. The
  // test page has a different origin from the game, so a game account must be
  // explicitly imported from its backup rather than read from game localStorage.
  function localAccountsKey() { return `df-signal:accounts:${deployment.rollupAddress}`; }
  function activeLocalAccountKey() { return `df-signal:active:${deployment.rollupAddress}`; }
  function savedLocalAccounts() {
    try {
      const value = JSON.parse(localStorage.getItem(localAccountsKey()) || '[]');
      return Array.isArray(value) ? value.filter(account => account &&
        ['secretKey', 'salt', 'signingKey', 'address'].every(key => typeof account[key] === 'string' && account[key])) : [];
    } catch { return []; }
  }
  function publishLocalAccounts(selectedAddress) {
    const saved = savedLocalAccounts();
    const preferred = selectedAddress || localStorage.getItem(activeLocalAccountKey());
    patch({ savedAccounts: saved.map(({ address, label }) => ({ address, label })),
      savedAccount: saved.some(account => account.address === preferred) ? preferred : saved[0]?.address || '' });
    return saved;
  }

  function rememberLocalAccount(account) {
    const saved = savedLocalAccounts();
    const index = saved.findIndex(item => item.address.toLowerCase() === account.address.toLowerCase());
    if (index < 0) saved.push(account);
    else saved[index] = account;
    localStorage.setItem(localAccountsKey(), JSON.stringify(saved));
    localStorage.setItem(activeLocalAccountKey(), account.address);
    publishLocalAccounts(account.address);
  }

  async function createLocalAccount() {
    const a = A();
    const secretKey = a.Fr.random().toString();
    const salt = a.Fr.random().toString();
    const signingKey = a.Fq.random().toString();
    const derived = await deriveAccountAddress(secretKey, BigInt(salt), a.Fq.fromString(signingKey));
    return {
      secretKey, salt, signingKey, address: derived.address.toString(),
      label: view.accountLabel.trim() || '本地玩家', createdAt: Date.now(),
    };
  }

  function setWalletPanel(open) { patch({ walletOpen: open }); }

  function storageKey() {
    return `df-harness:${deployment.rollupAddress}:${deployment.playerStorage}:${state.address}`;
  }
  function savePlayer(player) {
    const value = Object.fromEntries(playerFields.map(key => [key,
      key === 'claimed_ships' ? Boolean(player[key]) : player[key].toString()]));
    localStorage.setItem(storageKey(), JSON.stringify(value));
  }
  function loadPlayer() {
    const saved = localStorage.getItem(storageKey());
    if (!saved) return null;
    const value = JSON.parse(saved);
    return Object.fromEntries(playerFields.map(key => [key,
      key === 'claimed_ships' ? Boolean(value[key]) : BigInt(value[key])]));
  }
  function result(value) { return value && 'result' in value ? value.result : value; }
  function fail(error, label = '操作') {
    const message = error?.message || String(error);
    const guidance = message.includes('Timestamp too old')
      ? '本地链空闲后区块时间可能过旧。请在项目终端运行 node scripts/sync-df-clock.mjs --watch，等待同步完成后重试。不要清除钱包或重置链。'
      : /fetch|connect|network/i.test(message)
        ? '检查本地 Aztec 节点和钱包所选网络；恢复连接后再试。'
        : '请查看下方原始错误及运行记录。若已提交交易，先核对入局状态再重试，避免重复提交。';
    patch({ actionError: { label, message, guidance } });
    log(message, 'error', 'log');
    console.error(error);
  }
  async function action(fn, label = '操作') {
    if (busy) return;
    busy = true;
    // A different action (such as refreshing the feed) must not erase a join error.
    if (view.actionError?.label === label) patch({ actionError: null });
    if (label === 'DF 入局' || label === '匿名发帖') pauseAiHints();
    let succeeded = false;
    showProgress(`${label}…`);
    publishSession();
    try { await fn(); succeeded = true; }
    catch (error) { fail(error, label); }
    finally {
      busy = false;
      publishSession();
      finishProgress(label, succeeded);
      if (aiNeedsRun && view.aiHints) {
        aiNeedsRun = false;
        void runAiHints();
      }
    }
  }
  function publishSession() {
    patch({ busy, connected: Boolean(state.wallet), address: state.address?.toString() || '',
      hasLocalAccount: Boolean(state.localAccount), joined: Boolean(state.joined),
      canPost: Boolean(state.wallet && state.joined && loadPlayer()),
      pendingConnection: Boolean(pendingConnection) });
  }

  function ensureLocal(url) {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('仅允许连接本地 Aztec 节点');
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('测试页必须从 localhost 打开');
  }
  async function readArtifact(name) {
    const response = await fetch(`/df-${name}-artifact.json`);
    if (!response.ok) throw new Error(`缺少 ${name} 合约产物，请重新构建测试页`);
    return A().loadContractArtifact(await response.json());
  }
  async function attachContract(name, address) {
    const a = A();
    const artifact = await readArtifact(name);
    const addr = a.AztecAddress.fromStringUnsafe(address);
    const instance = name === 'sponsor'
      ? await a.getContractInstanceFromInstantiationParams(artifact, { salt: new a.Fr(0n) })
      : await state.aztecNode.getContract(addr);
    if (!instance || instance.address.toString() !== addr.toString()) {
      throw new Error(`${name} 尚未部署在当前本地链或地址不一致`);
    }
    if (state.pxe) {
      await state.pxe.registerContractClass(artifact);
      await state.pxe.registerContract(instance);
    } else {
      await state.wallet.registerContract(instance, artifact);
    }
    return a.Contract.at(addr, artifact, state.wallet);
  }
  async function initialize() {
    ensureLocal(location.href);
    try {
      const current = localStorage.getItem(preferencesKey);
      const preferences = JSON.parse(current || localStorage.getItem('df-signal:reading-preferences:v3') ||
        localStorage.getItem('df-signal:reading-preferences:v2') || '{}');
      patch({ mergeDuplicates: typeof preferences.mergeDuplicates === 'boolean' ? preferences.mergeDuplicates : true,
        // Old "hint" preferences must not silently become content folding.
        adEnabled: current ? preferences.adEnabled === true : preferences.adMode === 'fold' && preferences.adEnabled !== false,
        keywordEnabled: preferences.keywordEnabled === true,
        keywordMode: preferences.keywordMode === 'word' ? 'word' : 'contains',
        aiConsentGiven: Boolean(current && preferences.aiConsentVersion === AI_MODEL_VERSION),
        // Earlier consent only authorized hints, not automatic folding.
        aiHints: Boolean(current && preferences.aiHints === true && preferences.aiConsentVersion === AI_MODEL_VERSION),
      });
      if (view.aiHints) patch({ aiStatus: 'AI 已启用，等待读取公开消息。' });
      try { patch({ keywords: parseKeywords(Array.isArray(preferences.keywords) ? preferences.keywords.join('\n') : '') }); }
      catch { patch({ keywords: [], keywordError: '保存的词表无效，请重新填写' }); }
    } catch { /* Unavailable or malformed storage must not block wallet setup. */ }
    const response = await fetch('/df-local.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('未找到本地部署。请先运行 npm run deploy:df:harness');
    deployment = await response.json();
    ensureLocal(deployment.nodeUrl);
    if (!deployment.sponsoredFpc) throw new Error('本地部署缺少 Sponsor FPC；请重新运行 npm run deploy:df:harness');
    const accountResponse = await fetch('/df-local-accounts.json', { cache: 'no-store' });
    accounts = accountResponse.ok ? await accountResponse.json() : [];
    patch({ deployment, accounts: accounts.map(({ label }, index) => ({ label, value: String(index) })) });
    patch({ walletMode: publishLocalAccounts().length ? 'local' : 'create',
      account: sessionStorage.getItem('df-harness-account') || (accounts.length > 1 ? '1' : '0') });
    window.RPC_CONFIG = { nodeUrl: deployment.nodeUrl };
    publishSession();
  }

  async function checkChain() {
    const info = await state.aztecNode.getNodeInfo();
    const l1 = await state.aztecNode.getL1ContractAddresses();
    if (Number(info.l1ChainId) !== 31337 || info.nodeVersion !== '5.0.1' ||
        l1.rollupAddress.toString() !== deployment.rollupAddress) {
      throw new Error('部署信息与本地链不匹配，请重新部署测试合约');
    }
    return info;
  }

  async function finishConnect(label) {
    showProgress('校验本地链并加载 DF 合约…');
    await checkChain();
    contracts = {};
    showProgress('加载 DF 合约 · Core', 0, 5);
    contracts.core = await attachContract('core', deployment.core);
    showProgress('加载 DF 合约 · Config', 1, 5);
    contracts.config = await attachContract('config', deployment.config);
    showProgress('加载 DF 合约 · PlayerStorage', 2, 5);
    contracts.player = await attachContract('player', deployment.playerStorage);
    contracts.planet = await attachContract('planet', deployment.contracts.PlanetStorage);
    showProgress('加载 DF 合约 · Billboard', 3, 5);
    contracts.board = await attachContract('board', deployment.board);
    showProgress('加载本地 Sponsor FPC', 4, 5);
    contracts.sponsor = await attachContract('sponsor', deployment.sponsoredFpc);
    state.feePaymentMethod = new (A().SponsoredFeePaymentMethod)(A().AztecAddress.fromStringUnsafe(deployment.sponsoredFpc));
    showProgress('DF 合约及代付合约已加载', 5, 5);
    publishSession();
    showProgress('检查玩家入局状态…');
    state.joined = Boolean(result(await contracts.player.methods.is_initialized(state.address).simulate({ from: state.address })));
    patch({ joinedStatus: state.joined
      ? loadPlayer()
        ? '已入局，可以直接发帖；滚动 24 小时内最多 10 条。'
        : '已入局，但此浏览器没有该账号的 PlayerUpdate 记录，无法完成首帖校验。请切换未入局的测试玩家。'
      : '尚未入局，可以点击下方按钮开始。' });
    log(`已连接 ${label}。${state.joined ? '已入局' : '等待入局'}`, 'success', 'log');
    setWalletPanel(false);
    showProgress('读取公开消息…');
    await refresh(false);
  }

  async function readImportedAccount() {
    const file = view.accountFile;
    if (!file) throw new Error('请选择 DF 导出的账号 JSON 文件');
    if (file.size > 64 * 1024) throw new Error('账号文件过大');
    const account = JSON.parse(await file.text());
    if (!account || typeof account !== 'object' ||
        !['secretKey', 'salt', 'signingKey', 'address'].every(key => typeof account[key] === 'string' && account[key])) {
      throw new Error('账号备份需要 secretKey、salt、signingKey、address 四个字段');
    }
    if (!/^0x[\da-f]{1,64}$/i.test(account.secretKey) ||
        !/^(0x[\da-f]+|\d+)$/i.test(account.salt) ||
        !/^(0x)?[\da-f]{1,64}$/i.test(account.signingKey) ||
        !/^0x[\da-f]{64}$/i.test(account.address)) {
      throw new Error('账号密钥或 salt 格式无效');
    }
    return account;
  }

  async function connectLocal() {
    const a = A();
    const mode = view.walletMode;
    showProgress('准备本地 Aztec 账号…');
    const account = mode === 'create' ? await createLocalAccount() :
      mode === 'import' ? await readImportedAccount() :
      mode === 'local' ? savedLocalAccounts().find(item => item.address === view.savedAccount) :
      accounts[Number(view.account)];
    if (!account) throw new Error('无效测试账号');
    const signingKey = /^0x/i.test(account.signingKey) ? `0x${account.signingKey.slice(2)}` : `0x${account.signingKey}`;
    const signingField = a.Fq.fromString(signingKey);
    const derived = await deriveAccountAddress(account.secretKey, BigInt(account.salt), signingField);
    if (derived.address.toString().toLowerCase() !== account.address.toLowerCase()) {
      throw new Error('账号地址与密钥推导地址不一致');
    }
    // Persist new/imported credentials before the slower PXE setup. A failed
    // initialization can then be retried through "已保存账号" after reloading.
    if (mode === 'create' || mode === 'import') rememberLocalAccount(account);
    patch({ localStatus: '正在初始化本地 Aztec 钱包…' });
    try {
      const connected = await ensureAztecSetup(state, 'log', {
        secretKey: account.secretKey,
        salt: account.salt,
        dataDirPrefix: `pxe_df_harness_${deployment.rollupAddress}_${account.address}_`,
        signingKey: signingField,
        proverEnabled: view.realProofs,
        onProgress: (step, total, message) => {
          patch({ localStatus: `钱包初始化 ${step}/${total} · ${message}` });
          showProgress(`钱包初始化 · ${message}`, step, total);
        },
      });
      if (!connected) throw new Error('钱包初始化失败');
      if (state.address.toString().toLowerCase() !== account.address.toLowerCase()) {
        throw new Error('本地账号地址与备份不一致');
      }
      if (mode !== 'test') {
        rememberLocalAccount(account);
        state.localAccount = account;
      }
      await finishConnect(account.label || (mode === 'test' ? '预置测试玩家' : 'DF 本地账号'));
      patch({ localStatus: mode === 'create'
        ? '账号已创建并连接。请点击“下载账号备份”妥善保存密钥。'
        : '本地钱包已连接。' });
    } finally {
      patch({ accountFile: null, fileVersion: view.fileVersion + 1 });
    }
  }

  async function scanWallets() {
    showProgress('扫描 Aztec 扩展钱包…');
    patch({ extensionStatus: '正在查找 Azguard；若钱包弹出网站连接请求，请在 60 秒内批准…' });
    const a = A();
    const node = a.createAztecNodeClient(deployment.nodeUrl);
    const info = await node.getNodeInfo();
    const discovery = a.WalletManager.configure({ extensions: { enabled: true } }).getAvailableWallets({
      chainInfo: {
        chainId: a.Fr.fromString(info.l1ChainId.toString()),
        version: a.Fr.fromString(info.rollupVersion.toString()),
      },
      appId: 'dfpunk', timeout: 60000,
    });
    providers = [];
    try {
      for await (const provider of discovery.wallets) {
        if (!providers.some(item => item.id === provider.id)) providers.push(provider);
        // The discovered MessagePort remains usable after stopping discovery.
        // Avoid making an already-discovered Azguard wait for the full timeout.
        if (/azguard/i.test(provider.name) || /azguard/i.test(provider.id)) {
          discovery.cancel();
          break;
        }
      }
      await discovery.done;
    } finally { discovery.cancel(); }
    providers.sort((left, right) => Number(/azguard/i.test(right.name) || /azguard/i.test(right.id)) -
      Number(/azguard/i.test(left.name) || /azguard/i.test(left.id)));
    patch({ providers: providers.map(({ name, id }) => ({ name, id })), provider: '0' });

    patch({ extensionStatus: providers.length
      ? `检测到 ${providers.map(provider => provider.name).join('、')}；优先连接 Azguard。`
      : 'Wallet SDK 未收到 Azguard 响应。切换节点后请在钱包中重新批准本网站；再检查扩展的网站访问权限及本地 Aztec 5.0.1 兼容性。' });
    publishSession();
    log(providers.length
      ? `发现 ${providers.length} 个 Aztec 扩展钱包，请选择后连接`
      : 'Wallet SDK 未发现 Aztec 扩展钱包。可检查 Azguard 的网站访问权限和版本，或使用备用的本地钱包。',
    providers.length ? 'success' : 'info', 'log');
  }

  async function startExtensionConnection() {
    const provider = providers[Number(view.provider)];
    if (!provider) throw new Error('Wallet SDK 未发现 Azguard；请检查扩展对本页的访问权限和 Aztec 5.0.1 兼容性');
    patch({ extensionStatus: `正在请求 ${provider.name} 建立安全连接…` });
    showProgress(`等待 ${provider.name} 建立安全连接…`);
    pendingConnection = await provider.establishSecureChannel('dfpunk');
    patch({ emoji: Array.from(A().hashToEmoji(pendingConnection.verificationHash, 9)).join(' ') });
    patch({ verification: true });
    patch({ extensionStatus: `请核对 ${provider.name} 中的表情后确认` });
    log('请比对页面和钱包扩展显示的表情，再点击确认。', 'info', 'log');
  }

  function requestedCapabilities() {
    const a = A();
    const addresses = [deployment.core, deployment.config, deployment.playerStorage, deployment.board, deployment.sponsoredFpc]
      .map(value => a.AztecAddress.fromStringUnsafe(value));
    const scope = addresses.map(contract => ({ contract, function: '*' }));
    return {
      version: '1.0',
      metadata: { name: 'DF Billboard Local Test', version: '0.0.0',
        description: 'Dark Forest local join and billboard test', url: location.origin },
      capabilities: [
        { type: 'accounts', canGet: true, canCreateAuthWit: false },
        { type: 'contracts', contracts: addresses, canRegister: true, canGetMetadata: true },
        { type: 'simulation', utilities: { scope }, transactions: { scope } },
        { type: 'transaction', scope },
      ],
    };
  }

  function coversScope(granted, requested) {
    if (granted === '*') return true;
    if (!Array.isArray(granted)) return false;
    return requested.every(wanted => granted.some(pattern =>
      (pattern.contract === '*' || pattern.contract.toString() === wanted.contract.toString()) &&
      pattern.function === '*'));
  }

  async function confirmExtensionConnection() {
    const provider = providers[Number(view.provider)];
    const pending = pendingConnection;
    if (!provider || !pending) throw new Error('没有待确认的钱包连接');
    pendingConnection = null;
    patch({ verification: false });
    try {
      showProgress('等待钱包确认并授权…');
      const wallet = await pending.confirm();
      const request = requestedCapabilities();
      const grants = await wallet.requestCapabilities(request);
      const granted = grants.granted || [];
      const accountsGranted = granted.find(item => item.type === 'accounts')?.accounts || [];
      const scope = request.capabilities.find(item => item.type === 'transaction').scope;
      const contracts = granted.find(item => item.type === 'contracts');
      const contractCoverage = contracts?.canRegister &&
        (contracts.contracts === '*' || (Array.isArray(contracts.contracts) && scope.every(item =>
          contracts.contracts.some(address => address.toString() === item.contract.toString()))));
      const simulationCoverage = ['utilities', 'transactions'].every(kind =>
        granted.some(item => item.type === 'simulation' && coversScope(item[kind]?.scope, scope)));
      const transactionCoverage = granted.some(item => item.type === 'transaction' && coversScope(item.scope, scope));
      if (!accountsGranted.length || !contractCoverage || !simulationCoverage || !transactionCoverage) {
        throw new Error('钱包未完整授权账号、合约注册、模拟或交易能力，无法完成 DF 测试');
      }
      patch({ grantedAccounts: accountsGranted.map((entry, index) => ({
        value: String(index), label: `${entry.alias || '账号'} · ${entry.item}`,
      })), grantedAccount: '0' });

      state.wallet = wallet;
      state.pxe = null;
      state.aztecNode = A().createAztecNodeClient(deployment.nodeUrl);
      state.address = accountsGranted[0].item;
      state.grantedAccounts = accountsGranted;
      state.provider = provider;
      await finishConnect(provider.name);
    } catch (error) {
      state.wallet = null;
      state.address = null;
      state.provider = null;
      await provider.disconnect().catch(() => {});
      // disconnect() closes the provider's MessagePort. A retry must discover a
      // fresh provider rather than attempting key exchange on that closed port.
      providers = [];
      patch({ providers: [], provider: '0', grantedAccounts: [] });
      throw error;
    }
  }

  function cancelExtensionConnection() {
    pendingConnection?.cancel();
    pendingConnection = null;
    patch({ verification: false });
    patch({ extensionStatus: '连接已取消，可以重新连接 Azguard' });
    publishSession();
  }

  async function connect() {
    if (view.walletMode === 'extension') {
      try {
        if (!providers.length) await scanWallets();
        await startExtensionConnection();
      } catch (error) {
        if (providers.length) patch({ extensionStatus: '连接失败，请查看运行记录并重试' });
        throw error;
      }
    }
    else {
      try { await connectLocal(); }
      catch (error) {
        // A partially initialized wallet must not enable actions against unloaded contracts.
        state.wallet = null;
        state.address = null;
        state.localAccount = null;
        state.joined = false;
        contracts = null;
        patch({ localStatus: `连接失败：${error.message || String(error)}。可刷新页面后重试。` });
        throw error;
      }
    }
  }

  function zero(type) {
    if (type.kind === 'boolean') return false;
    if (type.kind === 'field' || type.kind === 'integer') return 0n;
    if (type.kind === 'array') return Array.from({ length: type.length }, () => zero(type.type));
    if (type.kind === 'struct') {
      if (type.path.endsWith('::AztecAddress')) return A().AztecAddress.ZERO;
      return Object.fromEntries(type.fields.map(field => [field.name, zero(field.type)]));
    }
    throw new Error(`不支持的 ABI 类型: ${type.kind}`);
  }
  function field(number) {
    const a = A();
    return new a.Fr((BigInt(number) + a.Fr.MODULUS) % a.Fr.MODULUS).toBuffer();
  }
  function bytesToBigInt(bytes) {
    return BigInt(`0x${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  }
  async function findSpawn(snark, game, thresholds, radius) {
    await window.__dfHash.initPoseidon2();
    const a = A();
    const api = window.__dfHash.BarretenbergSync.getSingleton();
    const key = field(snark.planethash_key);
    const max = BigInt(game.max_location_id.toString());
    for (let i = 0; i < 2_000_000; i++) {
      if (i % 4096 === 0) {
        if (i > 0) log(`已检查 ${i} 个出生点候选…`, 'info', 'log');
        showProgress(`寻找出生点 · 已检查 ${i} 个候选`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const angle = i * 2.399963229728653;
      const distance = radius * (0.9901 + 0.0097 * ((i % 997) / 997));
      const x = Math.trunc(Math.cos(angle) * distance);
      const y = Math.trunc(Math.sin(angle) * distance);
      const squared = BigInt(x) ** 2n + BigInt(y) ** 2n;
      if (squared >= BigInt(radius) ** 2n || squared * 100n <= 98n * BigInt(radius) ** 2n) continue;
      const hash = api.poseidon2Hash({ inputs: [key, field(x), field(y)] }).hash;
      const location = bytesToBigInt(hash);
      if (location >= max) continue;
      const levelBytes = BigInt(hash[4] * 65536 + hash[5] * 256 + hash[6]);
      if (levelBytes < BigInt(thresholds.thresholds[1])) continue;
      const noise = window.__dfHash.perlin({ x, y }, {
        key: Number(snark.spacetype_key), scale: Number(snark.perlin_length_scale),
        mirrorX: snark.perlin_mirror_x, mirrorY: snark.perlin_mirror_y, floor: true,
      });
      if (noise >= Number(game.init_perlin_min) && noise < Number(game.init_perlin_max)) {
        // All browsers scan the same deterministic candidates. Never reuse a
        // planet already initialized by an earlier test player.
        const occupied = result(await contracts.planet.methods.is_initialized(location).simulate({ from: state.address }));
        if (occupied) continue;
        return { x: new a.Fr(field(x)), y: new a.Fr(field(y)), location, perlin: noise, candidates: i + 1 };
      }
    }
    throw new Error('未找到有效出生点；未关闭 DF 的 ZK 检查');
  }

  async function join() {
    const a = A();
    const from = state.address;
    const view = call => call.simulate({ from }).then(result);
    showProgress('读取 DF 入局条件…', 0, 4);
    if (await view(contracts.player.methods.is_initialized(from))) throw new Error('这个账号已经入局');
    const snark = await view(contracts.config.methods.get_snark_config());
    if (snark.disable_zk_checks) throw new Error('DF 的 ZK 检查被关闭，拒绝进行本测试');
    const game = await view(contracts.config.methods.get_game_config_core());
    const thresholds = await view(contracts.config.methods.get_planet_level_thresholds());
    const radius = Number(deployment.worldRadius);
    showProgress('DF 入局条件已读取', 1, 4);
    log('正在浏览器中寻找有效出生点…', 'working', 'log');
    const spawn = await findSpawn(snark, game, thresholds, radius);
    showProgress('出生点已找到，准备入局交易…', 2, 4);
    log(`出生点找到：检查了 ${spawn.candidates} 个候选，开始构造入局交易…`, 'success', 'log');
    const artifact = await readArtifact('core');
    const parameters = artifact.functions.find(fn => fn.name === 'initialize_player').parameters;
    const args = Object.fromEntries(parameters.map(parameter => [parameter.name, zero(parameter.type)]));
    // Match DF's own onboarding fixture: anchor the private input to the last
    // actual L2 block. A simulated future slot can be ahead of the block that
    // the local automine sequencer ultimately produces.
    const latestBlock = await state.aztecNode.getBlock('latest');
    if (!latestBlock) throw new Error('Aztec 节点尚未产生 L2 区块，请稍后重试');
    const timestamp = BigInt(latestBlock.header.globalVariables.timestamp.toString());
    Object.assign(args, {
      x: spawn.x, y: spawn.y, radius: BigInt(radius), location_id: spawn.location,
      perlin: spawn.perlin, level: 0, timestamp, provided_snark_config: snark,
      planet_default_stats: await view(contracts.config.methods.get_planet_default_stats(0)),
      world_config: await view(contracts.config.methods.get_world_config()),
      game_config_core: game, planet_level_thresholds: thresholds,
      space_junk_config: await view(contracts.config.methods.get_space_junk_config()),
      world: { paused: false, radius: BigInt(radius), misc_nonce: 0n, next_change_block: 0 },
    });
    for (let tier = 0; tier < 4; tier++) {
      args[`planet_type_weights_tier_${tier}`] = await view(contracts.config.methods.get_planet_type_weights_tier(tier));
    }
    showProgress('模拟 DF 入局交易…');
    await contracts.core.methods.initialize_player(...parameters.map(parameter => args[parameter.name])).simulate({ from });
    showProgress('DF 入局模拟通过', 3, 4);
    log(`DF 入局时间校验通过：${timestamp}`, 'success', 'log');
    log('正在签名并提交 Core.initialize_player，可能需要几分钟…', 'working', 'log');
    showProgress('生成证明并提交入局交易，等待链上确认…');
    const tx = await contracts.core.methods.initialize_player(...parameters.map(parameter => args[parameter.name])).send({
      from, fee: { paymentMethod: state.feePaymentMethod },
    });
    if (tx.receipt.executionResult !== 'success') throw new Error(`入局失败: ${tx.receipt.executionResult}`);
    showProgress('入局交易已确认，校验玩家记录…');
    const playerArtifact = await readArtifact('player');
    const event = playerArtifact.outputs.structs.events.find(entry => entry.path.endsWith('::PlayerUpdate'));
    const updates = await a.getPublicEvents(state.aztecNode, {
      abiType: event,
      eventSelector: a.EventSelector.fromString('0x6994fffb'),
      fieldNames: event.fields.map(entry => entry.name),
    }, { contractAddress: a.AztecAddress.fromStringUnsafe(deployment.playerStorage), txHash: tx.receipt.txHash });
    const match = updates.events.map(entry => entry.event).find(entry => entry.id.toString() === from.toString());
    if (!match) throw new Error('入局交易成功，但未找到 PlayerStorage.PlayerUpdate');
    savePlayer(match.state);
    const verified = await view(contracts.player.methods.verify(from, match.state));
    if (!verified) throw new Error('PlayerUpdate 与 PlayerStorage 当前状态不一致');
    showProgress('DF 入局与玩家记录校验完成', 4, 4);
    state.joined = true;
    patch({ joinedStatus: `已入局 · 出生星球 ${spawn.location}` });
    log(`真实 DF 入局成功：${tx.receipt.txHash}`, 'success', 'log');
  }

  async function post() {
    const from = state.address;
    const player = loadPlayer();
    if (!player) throw new Error('缺少入局时的 PlayerUpdate，无法完成首帖校验');
    showProgress('检查消息并编码…', 0, 2);
    const { text, length } = encodeDFMessage(view.message);
    showProgress('消息已编码，准备发帖交易', 1, 2);
    showProgress('生成证明并提交匿名消息，等待链上确认…');
    const tx = await contracts.board.methods.post(player, text, length).send({
      from, fee: { paymentMethod: state.feePaymentMethod },
    });
    if (tx.receipt.executionResult !== 'success') throw new Error(`发帖失败: ${tx.receipt.executionResult}`);
    state.posted = true;
    log(`匿名消息已上链：${tx.receipt.txHash}`, 'success', 'log');
    showProgress('消息已上链，更新公开列表…');
    await refresh(false);
    showProgress('匿名发帖及列表更新完成', 2, 2);
  }

  function publishPosts() { patch({ posts: state.posts.map(post => ({ ...post })) }); }
  function publishFeed() { patch({ posts: state.posts.map(post => ({ ...post })), feedLoaded: true }); }

  function disposeAiWorker(reason) {
    if (aiWorker) aiWorker.terminate();
    aiWorker = null;
    for (const pending of aiPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    aiPending.clear();
  }

  function pauseAiHints() {
    if (!view.aiHints) return;
    aiGeneration++;
    aiNeedsRun = true;
    disposeAiWorker('AI 分析已暂停');
    patch({ aiProgress: null, aiStatus: 'AI 分析已暂停，等待当前链上操作完成。' });
  }

  function getAiWorker() {
    if (aiWorker) return aiWorker;
    // Replaced by the harness build, so an old cached runtime cannot survive an upgrade.
    const worker = new Worker('/df-toxicity.worker.js?v=' + __DF_TOXICITY_WORKER_HASH__, { type: 'module' });
    worker.onmessage = event => {
      if (aiWorker !== worker) return;
      const { id, results, progress, error } = event.data || {};
      const pending = aiPending.get(id);
      if (!pending) return;
      if (progress) {
        const total = Number(progress.total), loaded = Number(progress.loaded);
        const percent = total > 0 && Number.isFinite(loaded) ? Math.min(100, Math.max(0, loaded / total * 100)) : undefined;
        patch({ aiProgress: { file: String(progress.file || '模型'), percent },
          aiStatus: progress.status === 'ready' ? '模型已就绪，正在本地分析…'
            : `加载中英文模型：${progress.file || '初始化运行环境'}${percent === undefined ? '' : ` · ${percent.toFixed(0)}%`}。可随时关闭取消。` });
        return;
      }
      aiPending.delete(id);
      clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error));
      else pending.resolve(results);
    };
    worker.onerror = event => {
      if (aiWorker === worker) disposeAiWorker(event.message || 'AI Worker 运行失败');
    };
    worker.onmessageerror = () => {
      if (aiWorker === worker) disposeAiWorker('AI Worker 返回了无法读取的数据');
    };
    aiWorker = worker;
    return worker;
  }

  function classifyWithAi(texts) {
    return new Promise((resolve, reject) => {
      const id = ++aiRequestId;
      const timer = setTimeout(() => {
        if (aiPending.has(id)) disposeAiWorker('模型加载或分析超时，请关闭后重新开启 AI 折叠');
      }, AI_REQUEST_TIMEOUT_MS);
      aiPending.set(id, { resolve, reject, timer });
      try { getAiWorker().postMessage({ id, texts }); }
      catch (error) { clearTimeout(timer); aiPending.delete(id); reject(error); }
    });
  }

  function aiCacheKey() {
    return `df-signal:ai:${deployment.rollupAddress}:${deployment.season ?? deployment.core}:${deployment.board}:${AI_MODEL_VERSION}`;
  }

  function readAiCache() {
    try {
      const value = JSON.parse(localStorage.getItem(aiCacheKey()) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function saveAiCache(cache) {
    try {
      const ids = Object.keys(cache);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete cache[id];
      localStorage.setItem(aiCacheKey(), JSON.stringify(cache));
    } catch { /* Storage can be unavailable; in-memory results still work. */ }
  }

  async function contentHash(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function runAiHints() {
    if (disposed || !view.aiHints || !deployment || busy) return;
    aiNeedsRun = false;
    const generation = ++aiGeneration;
    const posts = state.posts.filter(post => typeof post.text === 'string' && post.text.trim());
    if (!posts.length) {
      patch({ aiStatus: '没有可分析的消息。' });
      return;
    }
    patch({ aiStatus: '检查本地 AI 分类缓存…' });
    const cache = readAiCache();
    const missing = [];
    try {
      for (const post of posts) {
        const hash = await contentHash(post.text);
        if (generation !== aiGeneration) return;
        const cached = cache[post.id];
        let validCache = false;
        if (cached?.hash === hash && cached.scores) {
          try {
            const checked = safetyResult(Object.entries(cached.scores).map(([label, score]) => ({ label, score })));
            post.aiLabels = checked.labels;
            post.aiAnalyzed = true;
            validCache = true;
          } catch { /* Corrupt result cache is reclassified, never treated as safe. */ }
        }
        if (!validCache) missing.push({ post, hash });
      }
      publishPosts();
      for (let offset = 0; offset < missing.length; offset += 4) {
        if (generation !== aiGeneration) return;
        const batch = missing.slice(offset, offset + 4);
        patch({ aiStatus: `实验性 AI 分析中：${Math.min(offset + batch.length, missing.length)}/${missing.length} 条；首次需下载模型。` });
        const results = await classifyWithAi(batch.map(entry => entry.post.text));
        if (generation !== aiGeneration) return;
        if (!Array.isArray(results) || results.length !== batch.length) throw new Error('AI 分类结果数量不正确');
        const checked = results.map(entry => safetyResult(Object.entries(entry.scores || {}).map(([label, score]) => ({ label, score }))));
        batch.forEach((entry, index) => {
          entry.post.aiLabels = checked[index].labels;
          entry.post.aiAnalyzed = true;
          cache[entry.post.id] = { hash: entry.hash, scores: checked[index].scores };
        });
        saveAiCache(cache);
        publishPosts();
      }
      patch({ aiProgress: null, aiStatus: `AI 已分析 ${posts.length} 条（其中 ${missing.length} 条新分析）；命中风险的消息已折叠，未命中不代表安全。` });
    } catch (error) {
      if (generation !== aiGeneration) return;
      disposeAiWorker('AI 分析失败');
      patch({ aiProgress: null, aiStatus: `AI 折叠不可用：${error?.message || String(error)}。未完成分析的消息保持可见；关键词和推广规则仍可使用。` });
      console.error('AI classification failed', error);
    }
  }

  async function refresh(reportProgress = true) {
    // Cancel analysis of the previous feed before replacing its post objects.
    pauseAiHints();
    const from = state.address;
    if (reportProgress) showProgress('读取公开消息数量…');
    const count = Number(result(await contracts.board.methods.get_post_count().simulate({ from })));
    const posts = [];
    for (let id = 0; id < count; id++) {
      const [fields, length] = result(await contracts.board.methods.get_post(id).simulate({ from }));
      try { posts.push({ id, text: decodeDFMessage(fields, length) }); }
      catch (error) {
        posts.push({ id, decodeError: true });
        log(`消息 #${id} 无法解码：${error?.message || String(error)}`, 'error', 'log');
      }
      if (reportProgress) showProgress('读取公开消息…', id + 1, count);
    }
    state.posts = classifyRulePosts(posts);
    publishFeed();
    if (view.aiHints) {
      if (busy) aiNeedsRun = true;
      else void runAiHints();
    }
    if (reportProgress && count === 0) showProgress('目前没有公开消息', 1, 1);
    log(`读取到 ${count} 条公开消息`, 'info', 'log');
  }

  function setField(name, value) {
    const editable = ['walletMode', 'savedAccount', 'account', 'accountLabel', 'accountFile', 'realProofs',
      'provider', 'message', 'mergeDuplicates', 'adEnabled', 'keywordEnabled', 'keywordMode'];
    const readingFields = ['mergeDuplicates', 'adEnabled', 'keywordEnabled', 'keywordMode'];
    if (!editable.includes(name) || (busy && !readingFields.includes(name))) return;
    if (['mergeDuplicates', 'adEnabled', 'keywordEnabled'].includes(name) && typeof value !== 'boolean') return;
    if (name === 'keywordMode' && !['contains', 'word'].includes(value)) return;
    if (['walletMode', 'savedAccount', 'account', 'provider'].includes(name) &&
        (state.wallet || pendingConnection)) return;
    patch({ [name]: value });
    if (readingFields.includes(name)) savePreferences();
    if (name === 'account') sessionStorage.setItem('df-harness-account', value);
    if (name === 'walletMode' || name === 'provider') publishSession();
  }
  function setAiHints(enabled) {
    if (typeof enabled !== 'boolean' || (enabled && (busy || view.aiClearing))) return;
    if (enabled && view.aiHints && aiPending.size) return;
    if (enabled && !view.aiConsentGiven) { patch({ aiConsentOpen: true }); return; }
    patch({ aiHints: enabled, aiConsentOpen: false, ...(enabled ? { aiStatus: 'AI 已启用，等待读取公开消息。' } : {}) });
    savePreferences();
    if (enabled) void runAiHints();
    else {
      aiGeneration++;
      aiNeedsRun = false;
      disposeAiWorker('AI 折叠已关闭');
      patch({ aiProgress: null, aiStatus: 'AI 折叠未启用' });
    }
  }
  function confirmAiHints() {
    if (busy || view.aiClearing) return;
    patch({ aiConsentGiven: true });
    setAiHints(true);
  }
  function saveKeywords(text) {
    try { patch({ keywords: parseKeywords(text), keywordError: '' }); savePreferences(); return true; }
    catch (error) { patch({ keywordError: error.message }); return false; }
  }
  async function clearAiCache() {
    if (view.aiClearing) return;
    setAiHints(false);
    patch({ aiClearing: true, aiConsentGiven: false });
    savePreferences();
    for (const post of state.posts) { delete post.aiLabels; delete post.aiAnalyzed; }
    publishPosts();
    try {
      if (typeof caches !== 'undefined') await caches.delete(AI_CACHE_NAME);
      if (deployment) localStorage.removeItem(aiCacheKey());
      patch({ aiStatus: '已清除本页模型缓存和本留言板分类缓存；再次开启会重新加载模型。' });
    } catch (error) { patch({ aiStatus: `缓存清除未完成：${error.message}` }); }
    finally { patch({ aiClearing: false }); }
  }
  async function copyAddress() {
    if (!state.address) return;
    try {
      await navigator.clipboard.writeText(state.address.toString());
      patch({ copied: true });
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => patch({ copied: false }), 1800);
    } catch (error) { fail(error); }
  }
  function accountBackup() {
    if (!state.localAccount) return null;
    const payload = ['secretKey', 'salt', 'signingKey', 'address', 'homeCoordinates']
      .reduce((value, key) => state.localAccount[key] === undefined ? value : { ...value, [key]: state.localAccount[key] }, {});
    return { filename: `dark-forest-privacy-${state.localAccount.address.slice(0, 10)}.json`,
      contents: JSON.stringify(payload, null, 2) };
  }
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => view,
    initialize: () => initializing ||= initialize().catch(fail),
    log, setField, setWalletPanel, setAiHints, confirmAiHints, clearAiCache,
    saveKeywords, copyAddress, accountBackup,
    connect: () => action(connect, '连接钱包'),
    scan: () => action(scanWallets, '扫描扩展钱包'),
    confirmWallet: () => action(confirmExtensionConnection, '授权并连接钱包'),
    cancelWallet: cancelExtensionConnection,
    selectGrantedAccount: value => action(async () => {
      patch({ grantedAccount: value });
      state.address = state.grantedAccounts[Number(value)].item;
      await finishConnect(state.provider.name);
    }, '切换钱包账号'),
    join: () => action(join, 'DF 入局'),
    post: () => action(post, '匿名发帖'),
    refresh: () => action(refresh, '刷新消息'),
    dispose: () => {
      disposed = true;
      aiGeneration++;
      aiNeedsRun = false;
      pendingConnection?.cancel();
      disposeAiWorker('页面已关闭');
      clearTimeout(progressHideTimer);
      clearTimeout(copyTimer);
      listeners.clear();
    },
  };
}
