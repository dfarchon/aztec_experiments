// @ts-nocheck -- SDK wallet objects retain the legacy adapter's dynamic types.
// Its public surface remains typed; internal SDK state can be tightened separately.
import {
  decodeDFMessage,
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../shared/df-billboard.mjs";
import { AI_CACHE_NAME, AI_MODEL_VERSION, safetyResult } from "./ai-config.ts";
import { parseKeywords } from "./keywords.ts";
import { classifyRulePosts } from "./moderation.ts";
import type { BillboardController } from "./types";

// The controller owns wallet/chain operations, never page DOM. React subscribes
// to immutable public snapshots; secret keys and SDK objects stay private here.
export function createBillboardController(deps = {}): BillboardController {
  const A = deps.sdk || (() => window.__aztec);
  const deriveAccountAddress =
    deps.deriveAccountAddress ||
    ((...args) => window.deriveAccountAddress(...args));
  const ensureAztecSetup =
    deps.ensureAztecSetup || ((...args) => window.ensureAztecSetup(...args));
  const listeners = new Set();
  let disposed = false;
  let initializing;
  let copyTimer;
  let logId = 0;
  let view = {
    busy: false,
    connected: false,
    address: "",
    canRead: false,
    canPost: false,
    hasLocalAccount: false,
    walletOpen: false,
    walletMode: "create",
    savedAccounts: [],
    savedAccount: "",
    accounts: [],
    account: "0",
    accountLabel: "",
    accountFile: null,
    fileVersion: 0,
    realProofs: false,
    providers: [],
    provider: "0",
    pendingConnection: false,
    verification: false,
    emoji: "",
    grantedAccounts: [],
    grantedAccount: "0",
    deployment: null,
    progress: null,
    actionError: null,
    localStatus: "等待初始化本地钱包",
    extensionStatus: "等待连接 Azguard",
    copied: false,
    message: "",
    logs: [],
    posts: [],
    feedLoaded: false,
    mergeDuplicates: true,
    aiHints: false,
    aiStatus: "AI 折叠未启用",
    rulesEnabled: false,
    keywordEnabled: false,
    keywords: [],
    keywordMode: "contains",
    keywordError: "",
    aiConsentGiven: false,
    aiConsentOpen: false,
    aiProgress: null,
    aiClearing: false,
  };
  function patch(changes) {
    if (disposed) return;
    view = { ...view, ...changes };
    listeners.forEach((listener) => listener());
  }
  function log(message, type = "info") {
    patch({
      logs: [
        ...view.logs.slice(-299),
        {
          id: ++logId,
          message: String(message),
          type,
          time: new Date().toLocaleTimeString(),
        },
      ],
    });
  }
  const state = {
    wallet: null,
    pxe: null,
    crsInit: false,
    localAccount: null,
    feePaymentMethod: null,
    posts: [],
  };
  let deployment;
  let accounts;
  let contracts;
  let boardArtifact;
  let publicNode;
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
  const preferencesKey = "df-signal:reading-preferences:v5";
  function savePreferences() {
    try {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          mergeDuplicates: view.mergeDuplicates,
          rulesEnabled: view.rulesEnabled,
          keywordEnabled: view.keywordEnabled,
          keywords: view.keywords,
          keywordMode: view.keywordMode,
          aiHints: view.aiHints,
          aiConsentVersion: view.aiConsentGiven ? AI_MODEL_VERSION : null,
        })
      );
    } catch {
      /* Restricted/full storage: controls still work in this session. */
    }
  }
  function showProgress(label, step, total) {
    clearTimeout(progressHideTimer);
    const determinate =
      Number.isFinite(step) && Number.isFinite(total) && total > 0;
    patch({
      progress: {
        label,
        failed: false,
        total: determinate ? total : 1,
        value: determinate ? Math.min(Math.max(step, 0), total) : undefined,
        count: determinate ? `${step}/${total}` : "进行中",
      },
    });
  }
  function finishProgress(label, succeeded) {
    showProgress(
      `${label}${succeeded ? "已完成" : "失败"}`,
      succeeded ? 1 : 0,
      1
    );
    patch({ progress: { ...view.progress, failed: !succeeded } });
    progressHideTimer = setTimeout(
      () => patch({ progress: null }),
      succeeded ? 2500 : 6000
    );
  }

  // Like DF's embedded wallet, local accounts are saved in this browser. The
  // test page has a different origin from the game, so a game account must be
  // explicitly imported from its backup rather than read from game localStorage.
  function localAccountsKey() {
    return `df-signal:accounts:${deployment.rollupAddress}`;
  }
  function activeLocalAccountKey() {
    return `df-signal:active:${deployment.rollupAddress}`;
  }
  function savedLocalAccounts() {
    try {
      const value = JSON.parse(
        localStorage.getItem(localAccountsKey()) || "[]"
      );
      return Array.isArray(value)
        ? value.filter(
            (account) =>
              account &&
              ["secretKey", "salt", "signingKey", "address"].every(
                (key) => typeof account[key] === "string" && account[key]
              )
          )
        : [];
    } catch {
      return [];
    }
  }
  function publishLocalAccounts(selectedAddress) {
    const saved = savedLocalAccounts();
    const preferred =
      selectedAddress || localStorage.getItem(activeLocalAccountKey());
    patch({
      savedAccounts: saved.map(({ address, label }) => ({ address, label })),
      savedAccount: saved.some((account) => account.address === preferred)
        ? preferred
        : saved[0]?.address || "",
    });
    return saved;
  }

  function rememberLocalAccount(account) {
    const saved = savedLocalAccounts();
    const index = saved.findIndex(
      (item) => item.address.toLowerCase() === account.address.toLowerCase()
    );
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
    const derived = await deriveAccountAddress(
      secretKey,
      BigInt(salt),
      a.Fq.fromString(signingKey)
    );
    return {
      secretKey,
      salt,
      signingKey,
      address: derived.address.toString(),
      label: view.accountLabel.trim() || "本地账号",
      createdAt: Date.now(),
    };
  }

  function setWalletPanel(open) {
    patch({ walletOpen: open });
  }

  function fail(error, label = "操作") {
    const message = error?.message || String(error);
    const guidance = message.includes("Timestamp too old")
      ? "本地链空闲后区块时间可能过旧。请在项目终端运行 node scripts/sync-df-clock.mjs --watch，等待同步完成后重试。不要清除钱包或重置链。"
      : /fetch|connect|network/i.test(message)
        ? "检查本地 Aztec 节点和钱包所选网络；恢复连接后再试。"
        : "请查看下方原始错误及运行记录。若已提交交易，先核对消息列表和交易回执再重试。";
    patch({ actionError: { label, message, guidance } });
    log(message, "error", "log");
    console.error(error);
  }
  async function action(fn, label = "操作") {
    if (busy) return;
    busy = true;
    // Refreshing the feed must not erase an unrelated transaction error.
    if (view.actionError?.label === label) patch({ actionError: null });
    if (label === "匿名发帖") pauseAiHints();
    let succeeded = false;
    showProgress(`${label}…`);
    publishSession();
    try {
      await fn();
      succeeded = true;
    } catch (error) {
      fail(error, label);
    } finally {
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
    patch({
      busy,
      connected: Boolean(state.wallet),
      address: state.address?.toString() || "",
      hasLocalAccount: Boolean(state.localAccount),
      canPost: Boolean(
        state.wallet && state.feePaymentMethod && contracts?.board
      ),
      pendingConnection: Boolean(pendingConnection),
    });
  }

  function ensureLocal(url) {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
      throw new Error("仅允许连接本地 Aztec 节点");
    if (!["127.0.0.1", "localhost"].includes(location.hostname))
      throw new Error("测试页必须从 localhost 打开");
  }
  async function readArtifact(name) {
    const response = await fetch(`/df-${name}-artifact.json`);
    if (!response.ok)
      throw new Error(`缺少 ${name} 合约产物，请重新构建测试页`);
    return A().loadContractArtifact(await response.json());
  }
  async function attachContract(name, address) {
    const a = A();
    const artifact =
      name === "board" ? boardArtifact : await readArtifact(name);
    const addr = a.AztecAddress.fromStringUnsafe(address);
    const instance =
      name === "sponsor"
        ? await a.getContractInstanceFromInstantiationParams(artifact, {
            salt: a.Fr.fromString(deployment.sponsorSalt),
          })
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
      const previous = localStorage.getItem("df-signal:reading-preferences:v4");
      const preferences = JSON.parse(
        current ||
          previous ||
          localStorage.getItem("df-signal:reading-preferences:v3") ||
          localStorage.getItem("df-signal:reading-preferences:v2") ||
          "{}"
      );
      patch({
        mergeDuplicates:
          typeof preferences.mergeDuplicates === "boolean"
            ? preferences.mergeDuplicates
            : true,
        // The old promotion switch never silently opts users into broader rules.
        rulesEnabled: Boolean(current && preferences.rulesEnabled === true),
        keywordEnabled: preferences.keywordEnabled === true,
        keywordMode: preferences.keywordMode === "word" ? "word" : "contains",
        aiConsentGiven: Boolean(
          (current || previous) &&
          preferences.aiConsentVersion === AI_MODEL_VERSION
        ),
        // Earlier consent only authorized hints, not automatic folding.
        aiHints: Boolean(
          (current || previous) &&
          preferences.aiHints === true &&
          preferences.aiConsentVersion === AI_MODEL_VERSION
        ),
      });
      if (view.aiHints) patch({ aiStatus: "AI 已启用，等待读取公开消息。" });
      try {
        patch({
          keywords: parseKeywords(
            Array.isArray(preferences.keywords)
              ? preferences.keywords.join("\n")
              : ""
          ),
        });
      } catch {
        patch({ keywords: [], keywordError: "保存的词表无效，请重新填写" });
      }
    } catch {
      /* Unavailable or malformed storage must not block wallet setup. */
    }
    const response = await fetch("/df-local.json", { cache: "no-store" });
    if (!response.ok)
      throw new Error("未找到本地部署。请先运行 npm run deploy:df:harness");
    deployment = await response.json();
    ensureLocal(deployment.nodeUrl);
    if (
      deployment.kind !== "standalone-billboard" ||
      deployment.schemaVersion !== 1
    )
      throw new Error(
        "部署配置仍是旧版 DF 留言板；请运行 npm run deploy:df:harness"
      );
    if (!deployment.sponsoredFpc)
      throw new Error(
        "本地部署缺少 Sponsor FPC；请重新运行 npm run deploy:df:harness"
      );
    const accountResponse = await fetch("/df-local-accounts.json", {
      cache: "no-store",
    });
    accounts = accountResponse.ok ? await accountResponse.json() : [];
    patch({
      deployment,
      accounts: accounts.map(({ label }, index) => ({
        label,
        value: String(index),
      })),
    });
    patch({
      walletMode: publishLocalAccounts().length ? "local" : "create",
      account:
        sessionStorage.getItem("df-harness-account") ||
        (accounts.length > 1 ? "1" : "0"),
    });
    window.RPC_CONFIG = { nodeUrl: deployment.nodeUrl };
    publicNode = A().createAztecNodeClient(deployment.nodeUrl);
    await checkChain();
    boardArtifact = await readArtifact("board");
    const instance = await publicNode.getContract(
      A().AztecAddress.fromStringUnsafe(deployment.board)
    );
    if (
      !instance ||
      instance.currentContractClassId.toString() !== deployment.boardClassId
    )
      throw new Error(
        "留言板部署或合约版本不匹配，请重新运行 npm run deploy:df:harness"
      );
    patch({ canRead: true });
    await refresh(false);
    publishSession();
  }

  async function checkChain() {
    const node = state.aztecNode || publicNode;
    const info = await node.getNodeInfo();
    const l1 = await node.getL1ContractAddresses();
    if (
      Number(info.l1ChainId) !== 31337 ||
      info.nodeVersion !== "5.0.1" ||
      info.realProofs !== false ||
      l1.rollupAddress.toString() !== deployment.rollupAddress
    ) {
      throw new Error("部署信息与本地链不匹配，请重新部署测试合约");
    }
    return info;
  }

  async function checkSponsorBalance() {
    const balance = await A().getFeeJuiceBalance(
      A().AztecAddress.fromStringUnsafe(deployment.sponsoredFpc),
      state.aztecNode || publicNode
    );
    if (balance <= 0n)
      throw new Error(
        "Sponsored FPC 余额不足，请充值代付合约后重试；不会扣除用户余额"
      );
  }

  async function finishConnect(label) {
    showProgress("校验本地链并加载留言板…", 0, 2);
    await checkChain();
    contracts = {};
    contracts.board = await attachContract("board", deployment.board);
    showProgress("加载 Sponsored FPC…", 1, 2);
    contracts.sponsor = await attachContract(
      "sponsor",
      deployment.sponsoredFpc
    );
    await checkSponsorBalance();
    state.feePaymentMethod = new (A().SponsoredFeePaymentMethod)(
      A().AztecAddress.fromStringUnsafe(deployment.sponsoredFpc)
    );
    showProgress("留言板及代付合约已就绪", 2, 2);
    publishSession();
    log(
      `已连接 ${label}，可以直接匿名发帖。L2 gas 由 Sponsored FPC 代付。`,
      "success"
    );
    setWalletPanel(false);
    await refresh(false);
  }

  async function readImportedAccount() {
    const file = view.accountFile;
    if (!file) throw new Error("请选择 Aztec 账号 JSON 备份");
    if (file.size > 64 * 1024) throw new Error("账号文件过大");
    const account = JSON.parse(await file.text());
    if (
      !account ||
      typeof account !== "object" ||
      !["secretKey", "salt", "signingKey", "address"].every(
        (key) => typeof account[key] === "string" && account[key]
      )
    ) {
      throw new Error(
        "账号备份需要 secretKey、salt、signingKey、address 四个字段"
      );
    }
    if (
      !/^0x[\da-f]{1,64}$/i.test(account.secretKey) ||
      !/^(0x[\da-f]+|\d+)$/i.test(account.salt) ||
      !/^(0x)?[\da-f]{1,64}$/i.test(account.signingKey) ||
      !/^0x[\da-f]{64}$/i.test(account.address)
    ) {
      throw new Error("账号密钥或 salt 格式无效");
    }
    return account;
  }

  async function connectLocal() {
    const a = A();
    const mode = view.walletMode;
    showProgress("准备本地 Aztec 账号…");
    const account =
      mode === "create"
        ? await createLocalAccount()
        : mode === "import"
          ? await readImportedAccount()
          : mode === "local"
            ? savedLocalAccounts().find(
                (item) => item.address === view.savedAccount
              )
            : accounts[Number(view.account)];
    if (!account) throw new Error("无效测试账号");
    const signingKey = /^0x/i.test(account.signingKey)
      ? `0x${account.signingKey.slice(2)}`
      : `0x${account.signingKey}`;
    const signingField = a.Fq.fromString(signingKey);
    const derived = await deriveAccountAddress(
      account.secretKey,
      BigInt(account.salt),
      signingField
    );
    if (
      derived.address.toString().toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("账号地址与密钥推导地址不一致");
    }
    // Persist new/imported credentials before the slower PXE setup. A failed
    // initialization can then be retried through "已保存账号" after reloading.
    if (mode === "create" || mode === "import") rememberLocalAccount(account);
    patch({ localStatus: "正在初始化本地 Aztec 钱包…" });
    try {
      const connected = await ensureAztecSetup(state, "log", {
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
      if (!connected) throw new Error("钱包初始化失败");
      if (
        state.address.toString().toLowerCase() !== account.address.toLowerCase()
      ) {
        throw new Error("本地账号地址与备份不一致");
      }
      if (mode !== "test") {
        rememberLocalAccount(account);
        state.localAccount = account;
      }
      await finishConnect(
        account.label || (mode === "test" ? "预置测试账号" : "Aztec 本地账号")
      );
      patch({
        localStatus:
          mode === "create"
            ? "账号已创建并连接。请点击“下载账号备份”妥善保存密钥。"
            : "本地钱包已连接。",
      });
    } finally {
      patch({ accountFile: null, fileVersion: view.fileVersion + 1 });
    }
  }

  async function scanWallets() {
    showProgress("扫描 Aztec 扩展钱包…");
    patch({
      extensionStatus:
        "正在查找 Azguard；若钱包弹出网站连接请求，请在 60 秒内批准…",
    });
    const a = A();
    const node = a.createAztecNodeClient(deployment.nodeUrl);
    const info = await node.getNodeInfo();
    const discovery = a.WalletManager.configure({
      extensions: { enabled: true },
    }).getAvailableWallets({
      chainInfo: {
        chainId: a.Fr.fromString(info.l1ChainId.toString()),
        version: a.Fr.fromString(info.rollupVersion.toString()),
      },
      appId: "df-billboard",
      timeout: 60000,
    });
    providers = [];
    try {
      for await (const provider of discovery.wallets) {
        if (!providers.some((item) => item.id === provider.id))
          providers.push(provider);
        // The discovered MessagePort remains usable after stopping discovery.
        // Avoid making an already-discovered Azguard wait for the full timeout.
        if (/azguard/i.test(provider.name) || /azguard/i.test(provider.id)) {
          discovery.cancel();
          break;
        }
      }
      await discovery.done;
    } finally {
      discovery.cancel();
    }
    providers.sort(
      (left, right) =>
        Number(/azguard/i.test(right.name) || /azguard/i.test(right.id)) -
        Number(/azguard/i.test(left.name) || /azguard/i.test(left.id))
    );
    patch({
      providers: providers.map(({ name, id }) => ({ name, id })),
      provider: "0",
    });

    patch({
      extensionStatus: providers.length
        ? `检测到 ${providers.map((provider) => provider.name).join("、")}；优先连接 Azguard。`
        : "Wallet SDK 未收到 Azguard 响应。切换节点后请在钱包中重新批准本网站；再检查扩展的网站访问权限及本地 Aztec 5.0.1 兼容性。",
    });
    publishSession();
    log(
      providers.length
        ? `发现 ${providers.length} 个 Aztec 扩展钱包，请选择后连接`
        : "Wallet SDK 未发现 Aztec 扩展钱包。可检查 Azguard 的网站访问权限和版本，或使用备用的本地钱包。",
      providers.length ? "success" : "info",
      "log"
    );
  }

  async function startExtensionConnection() {
    const provider = providers[Number(view.provider)];
    if (!provider)
      throw new Error(
        "Wallet SDK 未发现 Azguard；请检查扩展对本页的访问权限和 Aztec 5.0.1 兼容性"
      );
    patch({ extensionStatus: `正在请求 ${provider.name} 建立安全连接…` });
    showProgress(`等待 ${provider.name} 建立安全连接…`);
    pendingConnection = await provider.establishSecureChannel("df-billboard");
    patch({
      emoji: Array.from(
        A().hashToEmoji(pendingConnection.verificationHash, 9)
      ).join(" "),
    });
    patch({ verification: true });
    patch({ extensionStatus: `请核对 ${provider.name} 中的表情后确认` });
    log("请比对页面和钱包扩展显示的表情，再点击确认。", "info", "log");
  }

  function requestedCapabilities() {
    const a = A();
    const addresses = [deployment.board, deployment.sponsoredFpc].map((value) =>
      a.AztecAddress.fromStringUnsafe(value)
    );
    const scope = addresses.map((contract) => ({ contract, function: "*" }));
    return {
      version: "1.0",
      metadata: {
        name: "DF Billboard Local Test",
        version: "0.0.0",
        description: "Standalone anonymous billboard with sponsored posting",
        url: location.origin,
      },
      capabilities: [
        { type: "accounts", canGet: true, canCreateAuthWit: false },
        {
          type: "contracts",
          contracts: addresses,
          canRegister: true,
          canGetMetadata: true,
        },
        { type: "simulation", utilities: { scope }, transactions: { scope } },
        { type: "transaction", scope },
      ],
    };
  }

  function coversScope(granted, requested) {
    if (granted === "*") return true;
    if (!Array.isArray(granted)) return false;
    return requested.every((wanted) =>
      granted.some(
        (pattern) =>
          (pattern.contract === "*" ||
            pattern.contract.toString() === wanted.contract.toString()) &&
          pattern.function === "*"
      )
    );
  }

  async function confirmExtensionConnection() {
    const provider = providers[Number(view.provider)];
    const pending = pendingConnection;
    if (!provider || !pending) throw new Error("没有待确认的钱包连接");
    pendingConnection = null;
    patch({ verification: false });
    try {
      showProgress("等待钱包确认并授权…");
      const wallet = await pending.confirm();
      const request = requestedCapabilities();
      const grants = await wallet.requestCapabilities(request);
      const granted = grants.granted || [];
      const accountsGranted =
        granted.find((item) => item.type === "accounts")?.accounts || [];
      const scope = request.capabilities.find(
        (item) => item.type === "transaction"
      ).scope;
      const contracts = granted.find((item) => item.type === "contracts");
      const contractCoverage =
        contracts?.canRegister &&
        (contracts.contracts === "*" ||
          (Array.isArray(contracts.contracts) &&
            scope.every((item) =>
              contracts.contracts.some(
                (address) => address.toString() === item.contract.toString()
              )
            )));
      const simulationCoverage = ["utilities", "transactions"].every((kind) =>
        granted.some(
          (item) =>
            item.type === "simulation" && coversScope(item[kind]?.scope, scope)
        )
      );
      const transactionCoverage = granted.some(
        (item) => item.type === "transaction" && coversScope(item.scope, scope)
      );
      if (
        !accountsGranted.length ||
        !contractCoverage ||
        !simulationCoverage ||
        !transactionCoverage
      ) {
        throw new Error(
          "钱包未完整授权账号、合约注册、模拟或交易能力，无法完成留言板测试"
        );
      }
      patch({
        grantedAccounts: accountsGranted.map((entry, index) => ({
          value: String(index),
          label: `${entry.alias || "账号"} · ${entry.item}`,
        })),
        grantedAccount: "0",
      });

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
      patch({ providers: [], provider: "0", grantedAccounts: [] });
      throw error;
    }
  }

  function cancelExtensionConnection() {
    pendingConnection?.cancel();
    pendingConnection = null;
    patch({ verification: false });
    patch({ extensionStatus: "连接已取消，可以重新连接 Azguard" });
    publishSession();
  }

  async function connect() {
    if (view.walletMode === "extension") {
      try {
        if (!providers.length) await scanWallets();
        await startExtensionConnection();
      } catch (error) {
        if (providers.length)
          patch({ extensionStatus: "连接失败，请查看运行记录并重试" });
        throw error;
      }
    } else {
      try {
        await connectLocal();
      } catch (error) {
        // A partially initialized wallet must not enable actions against unloaded contracts.
        state.wallet = null;
        state.address = null;
        state.localAccount = null;
        state.feePaymentMethod = null;
        contracts = null;
        patch({
          localStatus: `连接失败：${error.message || String(error)}。可刷新页面后重试。`,
        });
        throw error;
      }
    }
  }

  async function post() {
    const from = state.address;
    showProgress("检查消息并编码…", 0, 2);
    const { text, length } = encodeDFMessage(view.message);
    if (!state.wallet || !contracts?.board || !state.feePaymentMethod)
      throw new Error("请先连接 Aztec 钱包");
    await checkChain();
    await checkSponsorBalance();
    showProgress("消息已编码，准备发帖交易", 1, 2);
    showProgress("生成证明并提交匿名消息，等待链上确认…");
    const tx = await contracts.board.methods.post(text, length).send({
      from,
      fee: await getBillboardFeeOptions(
        state.aztecNode,
        state.feePaymentMethod,
        A().GasFees
      ),
    });
    if (tx.receipt.executionResult !== "success")
      throw new Error(`发帖失败: ${tx.receipt.executionResult}`);
    log(`匿名消息已上链：${tx.receipt.txHash}`, "success", "log");
    showProgress("消息已上链，更新公开列表…");
    await refresh(false);
    showProgress("匿名发帖及列表更新完成", 2, 2);
  }

  function publishPosts() {
    patch({ posts: state.posts.map((post) => ({ ...post })) });
  }
  function publishFeed() {
    patch({
      posts: state.posts.map((post) => ({ ...post })),
      feedLoaded: true,
    });
  }

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
    disposeAiWorker("AI 分析已暂停");
    patch({
      aiProgress: null,
      aiStatus: "AI 分析已暂停，等待当前链上操作完成。",
    });
  }

  function getAiWorker() {
    if (aiWorker) return aiWorker;
    // Replaced by the harness build, so an old cached runtime cannot survive an upgrade.
    const worker = new Worker(
      "/df-toxicity.worker.js?v=" + __DF_TOXICITY_WORKER_HASH__,
      { type: "module" }
    );
    worker.onmessage = (event) => {
      if (aiWorker !== worker) return;
      const { id, results, progress, error } = event.data || {};
      const pending = aiPending.get(id);
      if (!pending) return;
      if (progress) {
        const total = Number(progress.total),
          loaded = Number(progress.loaded);
        const percent =
          total > 0 && Number.isFinite(loaded)
            ? Math.min(100, Math.max(0, (loaded / total) * 100))
            : undefined;
        patch({
          aiProgress: { file: String(progress.file || "模型"), percent },
          aiStatus:
            progress.status === "ready"
              ? "模型已就绪，正在本地分析…"
              : `加载中英文模型：${progress.file || "初始化运行环境"}${percent === undefined ? "" : ` · ${percent.toFixed(0)}%`}。可随时关闭取消。`,
        });
        return;
      }
      aiPending.delete(id);
      clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error));
      else pending.resolve(results);
    };
    worker.onerror = (event) => {
      if (aiWorker === worker)
        disposeAiWorker(event.message || "AI Worker 运行失败");
    };
    worker.onmessageerror = () => {
      if (aiWorker === worker)
        disposeAiWorker("AI Worker 返回了无法读取的数据");
    };
    aiWorker = worker;
    return worker;
  }

  function classifyWithAi(texts) {
    return new Promise((resolve, reject) => {
      const id = ++aiRequestId;
      const timer = setTimeout(() => {
        if (aiPending.has(id))
          disposeAiWorker("模型加载或分析超时，请关闭后重新开启 AI 折叠");
      }, AI_REQUEST_TIMEOUT_MS);
      aiPending.set(id, { resolve, reject, timer });
      try {
        getAiWorker().postMessage({ id, texts });
      } catch (error) {
        clearTimeout(timer);
        aiPending.delete(id);
        reject(error);
      }
    });
  }

  function aiCacheKey() {
    return `df-signal:ai:${deployment.rollupAddress}:${deployment.board}:${AI_MODEL_VERSION}`;
  }

  function readAiCache() {
    try {
      const value = JSON.parse(localStorage.getItem(aiCacheKey()) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }

  function saveAiCache(cache) {
    try {
      const ids = Object.keys(cache);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500)))
        delete cache[id];
      localStorage.setItem(aiCacheKey(), JSON.stringify(cache));
    } catch {
      /* Storage can be unavailable; in-memory results still work. */
    }
  }

  async function contentHash(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function runAiHints() {
    if (disposed || !view.aiHints || !deployment || busy) return;
    aiNeedsRun = false;
    const generation = ++aiGeneration;
    const posts = state.posts.filter(
      (post) => typeof post.text === "string" && post.text.trim()
    );
    if (!posts.length) {
      patch({ aiStatus: "没有可分析的消息。" });
      return;
    }
    patch({ aiStatus: "检查本地 AI 分类缓存…" });
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
            const checked = safetyResult(
              Object.entries(cached.scores).map(([label, score]) => ({
                label,
                score,
              }))
            );
            post.aiLabels = checked.labels;
            post.aiAnalyzed = true;
            validCache = true;
          } catch {
            /* Corrupt result cache is reclassified, never treated as safe. */
          }
        }
        if (!validCache) missing.push({ post, hash });
      }
      publishPosts();
      for (let offset = 0; offset < missing.length; offset += 4) {
        if (generation !== aiGeneration) return;
        const batch = missing.slice(offset, offset + 4);
        patch({
          aiStatus: `实验性 AI 分析中：${Math.min(offset + batch.length, missing.length)}/${missing.length} 条；首次需下载模型。`,
        });
        const results = await classifyWithAi(
          batch.map((entry) => entry.post.text)
        );
        if (generation !== aiGeneration) return;
        if (!Array.isArray(results) || results.length !== batch.length)
          throw new Error("AI 分类结果数量不正确");
        const checked = results.map((entry) =>
          safetyResult(
            Object.entries(entry.scores || {}).map(([label, score]) => ({
              label,
              score,
            }))
          )
        );
        batch.forEach((entry, index) => {
          entry.post.aiLabels = checked[index].labels;
          entry.post.aiAnalyzed = true;
          cache[entry.post.id] = {
            hash: entry.hash,
            scores: checked[index].scores,
          };
        });
        saveAiCache(cache);
        publishPosts();
      }
      patch({
        aiProgress: null,
        aiStatus: `AI 已分析 ${posts.length} 条（其中 ${missing.length} 条新分析）；命中风险的消息已折叠，未命中不代表安全。`,
      });
    } catch (error) {
      if (generation !== aiGeneration) return;
      disposeAiWorker("AI 分析失败");
      patch({
        aiProgress: null,
        aiStatus: `AI 折叠不可用：${error?.message || String(error)}。未完成分析的消息保持可见；关键词和基础规则仍可使用。`,
      });
      console.error("AI classification failed", error);
    }
  }

  async function refresh(reportProgress = true) {
    // Cancel analysis of the previous feed before replacing its post objects.
    pauseAiHints();
    if (!publicNode || !boardArtifact) throw new Error("留言板尚未初始化");
    const sdk = A();
    const addr = sdk.AztecAddress.fromStringUnsafe(deployment.board);
    const layout = boardArtifact.storageLayout;
    // Read one consistent public-state snapshot; no wallet or simulation needed.
    const block = await publicNode.getBlockNumber();
    const read = (slot) => publicNode.getPublicStorageAt(block, addr, slot);
    if (reportProgress) showProgress("读取公开消息数量…");
    const count = Number((await read(layout.post_count.slot)).toBigInt());
    const posts = [];
    for (let id = 0; id < count; id++) {
      const lengthSlot = await sdk.deriveStorageSlotInMap(
        layout.post_lengths.slot,
        new sdk.Fr(BigInt(id))
      );
      const length = Number((await read(lengthSlot)).toBigInt());
      const fields = await Promise.all(
        Array.from({ length: 17 }, async (_, index) =>
          read(
            await sdk.deriveStorageSlotInMap(
              layout.post_data.slot,
              new sdk.Fr(BigInt(id * 17 + index))
            )
          )
        )
      );
      try {
        posts.push({ id, text: decodeDFMessage(fields, length) });
      } catch (error) {
        posts.push({ id, decodeError: true });
        log(
          `消息 #${id} 无法解码：${error?.message || String(error)}`,
          "error",
          "log"
        );
      }
      if (reportProgress) showProgress("读取公开消息…", id + 1, count);
    }
    state.posts = classifyRulePosts(posts);
    publishFeed();
    if (view.aiHints) {
      if (busy) aiNeedsRun = true;
      else void runAiHints();
    }
    if (reportProgress && count === 0) showProgress("目前没有公开消息", 1, 1);
    log(`读取到 ${count} 条公开消息`, "info", "log");
  }

  function setField(name, value) {
    const editable = [
      "walletMode",
      "savedAccount",
      "account",
      "accountLabel",
      "accountFile",
      "realProofs",
      "provider",
      "message",
      "mergeDuplicates",
      "rulesEnabled",
      "keywordEnabled",
      "keywordMode",
    ];
    const readingFields = [
      "mergeDuplicates",
      "rulesEnabled",
      "keywordEnabled",
      "keywordMode",
    ];
    if (!editable.includes(name) || (busy && !readingFields.includes(name)))
      return;
    if (
      ["mergeDuplicates", "rulesEnabled", "keywordEnabled"].includes(name) &&
      typeof value !== "boolean"
    )
      return;
    if (name === "keywordMode" && !["contains", "word"].includes(value)) return;
    if (
      ["walletMode", "savedAccount", "account", "provider"].includes(name) &&
      (state.wallet || pendingConnection)
    )
      return;
    patch({ [name]: value });
    if (readingFields.includes(name)) savePreferences();
    if (name === "account") sessionStorage.setItem("df-harness-account", value);
    if (name === "walletMode" || name === "provider") publishSession();
  }
  function setAiHints(enabled) {
    if (typeof enabled !== "boolean" || (enabled && (busy || view.aiClearing)))
      return;
    if (enabled && view.aiHints && aiPending.size) return;
    if (enabled && !view.aiConsentGiven) {
      patch({ aiConsentOpen: true });
      return;
    }
    patch({
      aiHints: enabled,
      aiConsentOpen: false,
      ...(enabled ? { aiStatus: "AI 已启用，等待读取公开消息。" } : {}),
    });
    savePreferences();
    if (enabled) void runAiHints();
    else {
      aiGeneration++;
      aiNeedsRun = false;
      disposeAiWorker("AI 折叠已关闭");
      patch({ aiProgress: null, aiStatus: "AI 折叠未启用" });
    }
  }
  function confirmAiHints() {
    if (busy || view.aiClearing) return;
    patch({ aiConsentGiven: true });
    setAiHints(true);
  }
  function saveKeywords(text) {
    try {
      patch({ keywords: parseKeywords(text), keywordError: "" });
      savePreferences();
      return true;
    } catch (error) {
      patch({ keywordError: error.message });
      return false;
    }
  }
  async function clearAiCache() {
    if (view.aiClearing) return;
    setAiHints(false);
    patch({ aiClearing: true, aiConsentGiven: false });
    savePreferences();
    for (const post of state.posts) {
      delete post.aiLabels;
      delete post.aiAnalyzed;
    }
    publishPosts();
    try {
      if (typeof caches !== "undefined") await caches.delete(AI_CACHE_NAME);
      if (deployment) localStorage.removeItem(aiCacheKey());
      patch({
        aiStatus:
          "已清除本页模型缓存和本留言板分类缓存；再次开启会重新加载模型。",
      });
    } catch (error) {
      patch({ aiStatus: `缓存清除未完成：${error.message}` });
    } finally {
      patch({ aiClearing: false });
    }
  }
  async function copyAddress() {
    if (!state.address) return;
    try {
      await navigator.clipboard.writeText(state.address.toString());
      patch({ copied: true });
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => patch({ copied: false }), 1800);
    } catch (error) {
      fail(error);
    }
  }
  function accountBackup() {
    if (!state.localAccount) return null;
    const payload = ["secretKey", "salt", "signingKey", "address"].reduce(
      (value, key) =>
        state.localAccount[key] === undefined
          ? value
          : { ...value, [key]: state.localAccount[key] },
      {}
    );
    return {
      filename: `billboard-account-${state.localAccount.address.slice(0, 10)}.json`,
      contents: JSON.stringify(payload, null, 2),
    };
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    initialize: () =>
      (initializing ||= initialize().catch((error) => {
        initializing = undefined;
        fail(error, "加载留言板");
        throw error;
      })),
    log,
    setField,
    setWalletPanel,
    setAiHints,
    confirmAiHints,
    clearAiCache,
    saveKeywords,
    copyAddress,
    accountBackup,
    connect: () => action(connect, "连接钱包"),
    scan: () => action(scanWallets, "扫描扩展钱包"),
    confirmWallet: () => action(confirmExtensionConnection, "授权并连接钱包"),
    cancelWallet: cancelExtensionConnection,
    selectGrantedAccount: (value) =>
      action(async () => {
        patch({ grantedAccount: value });
        state.address = state.grantedAccounts[Number(value)].item;
        await finishConnect(state.provider.name);
      }, "切换钱包账号"),
    post: () => action(post, "匿名发帖"),
    refresh: () => action(refresh, "刷新消息"),
    dispose: () => {
      disposed = true;
      aiGeneration++;
      aiNeedsRun = false;
      pendingConnection?.cancel();
      disposeAiWorker("页面已关闭");
      clearTimeout(progressHideTimer);
      clearTimeout(copyTimer);
      listeners.clear();
    },
  };
}
