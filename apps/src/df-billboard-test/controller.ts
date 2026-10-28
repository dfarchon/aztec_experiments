// @ts-nocheck -- SDK wallet objects retain the legacy adapter's dynamic types.
// Its public surface remains typed; internal SDK state can be tightened separately.
import {
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../shared/df-billboard.mjs";
import {
  accountSetupOptions,
  createAccountKeys,
  hasAccountKeys,
  readStored,
  writeStored,
} from "./accounts.ts";
import { AI_MODEL_VERSION } from "./ai-config.ts";
import { createFeedReader } from "./feed-reader.ts";
import { parseKeywords } from "./keywords.ts";
import { classifyRulePosts } from "./moderation.ts";
import {
  environment,
  SDK_VERSION,
  validateChain,
  validateRpc,
} from "./network.ts";
import {
  fetchPublicJson,
  loadReadLayout,
  publicReadSDK,
} from "./public-reader.ts";
import { createReadingController } from "./reading.ts";
import { emptyRequestView } from "./request-view.ts";
import { loadAztecRuntime } from "./runtime-assets.ts";
import type { BillboardController } from "./types";
import { withWalletLock } from "./wallet-lock.ts";

// The controller owns wallet/chain operations, never page DOM. React subscribes
// to immutable public snapshots; secret keys and SDK objects stay private here.
export function createBillboardController(deps = {}): BillboardController {
  const A = deps.sdk || (() => window.__aztec);
  const R = deps.readSdk || deps.sdk || (() => publicReadSDK);
  let walletRuntime;
  let walletModeSelected = false;
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
    accountLabel: "",
    accountFile: null,
    fileVersion: 0,
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
    extensionStatus: "Waiting to connect Azguard",
    copied: false,
    message: "",
    request: emptyRequestView,
    logs: [],
    posts: [],
    feedLoaded: false,
    feedLoading: false,
    totalPosts: 0,
    hasOlderPosts: false,
    feedRevision: 0,
    aiHints: false,
    aiStatus: "AI filtering is off",
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
          time: new Date().toLocaleTimeString("en-GB"),
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
  let contracts;
  let boardArtifact;
  let readLayout;
  let publicNode;
  let feedCursor;
  let feedReading;
  const readPostPage = createFeedReader();
  let requestPosting;
  let providers = [];
  let pendingConnection = null;
  let busy = false;
  let progressHideTimer;
  const reading = createReadingController({
    getView: () => view,
    getPosts: () => state.posts,
    getDeployment: () => deployment,
    isBusy: () => busy || view.feedLoading,
    patch,
    savePreferences,
    publishPosts,
  });
  const {
    pauseAiHints,
    runAiHints,
    setAiHints,
    confirmAiHints,
    clearAiCache,
    saveKeywords,
  } = reading;
  const preferencesKey = "df-signal:reading-preferences:v5";
  function savePreferences() {
    try {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
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
        count: determinate ? `${step}/${total}` : "In progress",
      },
    });
  }
  function finishProgress(label, succeeded, completionLabel) {
    showProgress(
      succeeded && completionLabel
        ? completionLabel
        : `${label}${succeeded ? " completed" : " failed"}`,
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
      const value = readStored(localStorage, localAccountsKey());
      return Array.isArray(value)
        ? value.filter(
            (account) =>
              account &&
              hasAccountKeys(account) &&
              typeof account.address === "string" &&
              account.address
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
    writeStored(localStorage, localAccountsKey(), saved);
    localStorage.setItem(activeLocalAccountKey(), account.address);
    publishLocalAccounts(account.address);
  }

  async function createLocalAccount() {
    const a = A();
    const { secretKey, salt, signingKey } = createAccountKeys(a);
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
      label: view.accountLabel.trim() || "Browser account",
      createdAt: Date.now(),
    };
  }

  function setWalletPanel(open) {
    patch({ walletOpen: open });
  }

  function fail(error, label = "Operation") {
    const message = error?.message || String(error);
    const guidance = message.includes("Timestamp too old")
      ? "The local chain timestamp may be stale after inactivity. Run node scripts/sync-df-clock.mjs --watch in the project terminal, wait for synchronization, then retry. Do not clear your wallet or reset the chain."
      : /fetch|connect|network/i.test(message)
        ? "Check the local Aztec node and the network selected in your wallet, then retry."
        : "Check the error details and activity log below. If a transaction was submitted, check the post list and receipt before retrying.";
    patch({ actionError: { label, message, guidance } });
    log(message, "error", "log");
    console.error(error);
  }
  async function action(fn, label = "Operation") {
    if (busy) return;
    busy = true;
    // Refreshing the feed must not erase an unrelated transaction error.
    if (view.actionError?.label === label) patch({ actionError: null });
    if (label === "Anonymous posting") pauseAiHints();
    let succeeded = false;
    let completionLabel;
    showProgress(`${label}…`);
    publishSession();
    try {
      const result = await fn();
      if (typeof result === "string") completionLabel = result;
      succeeded = true;
    } catch (error) {
      fail(error, label);
    } finally {
      busy = false;
      publishSession();
      finishProgress(label, succeeded, completionLabel);
      reading.resume();
    }
  }
  function publishSession() {
    const metamask = view.walletMode === "metamask";
    patch({
      busy,
      connected: metamask ? Boolean(view.request.payer) : Boolean(state.wallet),
      address: metamask ? view.request.payer : state.address?.toString() || "",
      hasLocalAccount: !metamask && Boolean(state.localAccount),
      canPost: metamask
        ? Boolean(view.request.payer) &&
          !view.request.jobs.some((job) => job.postId === undefined)
        : Boolean(state.wallet && state.feePaymentMethod && contracts?.board),
      pendingConnection: Boolean(pendingConnection),
    });
  }

  async function readArtifact(name) {
    const response = await fetch(`/df-${name}-artifact.json`);
    if (!response.ok)
      throw new Error(
        `Missing ${name} contract artifact. Rebuild the test site.`
      );
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
      throw new Error(
        `${name} is not deployed on this local chain or its address does not match`
      );
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
    try {
      const preferences = JSON.parse(
        localStorage.getItem(preferencesKey) || "{}"
      );
      patch({
        rulesEnabled: preferences.rulesEnabled === true,
        keywordEnabled: preferences.keywordEnabled === true,
        keywordMode: preferences.keywordMode === "word" ? "word" : "contains",
        aiConsentGiven: preferences.aiConsentVersion === AI_MODEL_VERSION,
        aiHints: Boolean(
          preferences.aiHints === true &&
          preferences.aiConsentVersion === AI_MODEL_VERSION
        ),
      });
      if (view.aiHints)
        patch({ aiStatus: "AI enabled. Waiting to load public posts." });
      try {
        patch({
          keywords: parseKeywords(
            Array.isArray(preferences.keywords)
              ? preferences.keywords.join("\n")
              : ""
          ),
        });
      } catch {
        patch({
          keywords: [],
          keywordError: "The saved keyword list is invalid. Enter it again.",
        });
      }
    } catch {
      /* Unavailable or malformed storage must not block wallet setup. */
    }
    deployment = await fetchPublicJson("/df-local.json", { cache: "no-store" });
    const env = environment(deployment.environment);
    validateRpc(deployment.nodeUrl, env);
    if (env === "local") validateRpc(location.origin, env);
    else if (
      location.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(location.hostname)
    )
      throw new Error("Public deployments require a secure browser origin");
    if (
      deployment.kind !== "standalone-billboard" ||
      deployment.schemaVersion !== 1
    )
      throw new Error(
        "Legacy DF deployment configuration. Run npm run deploy:df:harness."
      );
    if (!deployment.sponsoredFpc)
      throw new Error(
        "Local deployment is missing Sponsored FPC. Run npm run deploy:df:harness again."
      );
    patch({ deployment });
    const savedAccounts = publishLocalAccounts();
    if (!walletModeSelected)
      patch({ walletMode: savedAccounts.length ? "local" : "create" });
    window.RPC_CONFIG = { nodeUrl: deployment.nodeUrl };
    publicNode = R().createAztecNodeClient(deployment.nodeUrl);
    const boardAddress = R().AztecAddress.fromStringUnsafe(deployment.board);
    const checks = await Promise.allSettled([
      checkChain(),
      (deps.loadReadLayout || loadReadLayout)(deployment.boardArtifactHash),
      publicNode.getContract(boardAddress),
    ]);
    // Drain all checks before allowing a retry; none may enable reads alone.
    for (const result of checks)
      if (result.status === "rejected") throw result.reason;
    const [, layout, instance] = checks.map((result) => result.value);
    if (
      !instance ||
      instance.currentContractClassId.toString() !== deployment.boardClassId
    )
      throw new Error(
        "Billboard deployment or contract version mismatch. Run npm run deploy:df:harness again."
      );
    readLayout = layout;
    patch({ canRead: true });
    patch({
      request: {
        ...emptyRequestView,
        available: Boolean(deployment.l1Request),
      },
    });
    await refresh(false);
    publishSession();
  }

  async function prepareWallet() {
    await initializeOnce();
    return (walletRuntime ||= (async () => {
      showProgress("Loading wallet tools…");
      await (deps.loadWalletRuntime || loadAztecRuntime)();
    })().catch((error) => {
      walletRuntime = undefined;
      throw error;
    }));
  }

  async function checkChain() {
    const node = state.aztecNode || publicNode;
    const info = await node.getNodeInfo();
    const env = environment(deployment.environment);
    validateRpc(deployment.nodeUrl, env);
    validateChain(
      env,
      deployment,
      info,
      info.l1ContractAddresses.rollupAddress.toString()
    );
    return info;
  }

  async function checkSponsorBalance() {
    const balance = await A().getFeeJuiceBalance(
      A().AztecAddress.fromStringUnsafe(deployment.sponsoredFpc),
      state.aztecNode || publicNode
    );
    if (balance <= 0n)
      throw new Error(
        "Sponsored FPC has insufficient balance. Fund the sponsor contract and retry; your balance will not be charged."
      );
  }

  async function finishConnect(label) {
    showProgress("Checking the network and loading Billboard…", 0, 2);
    await checkChain();
    contracts = {};
    contracts.board = await attachContract("board", deployment.board);
    showProgress("Loading Sponsored FPC…", 1, 2);
    contracts.sponsor = await attachContract(
      "sponsor",
      deployment.sponsoredFpc
    );
    await checkSponsorBalance();
    state.feePaymentMethod = new (A().SponsoredFeePaymentMethod)(
      A().AztecAddress.fromStringUnsafe(deployment.sponsoredFpc)
    );
    showProgress("Billboard and sponsor contract ready", 2, 2);
    publishSession();
    log(
      `Connected ${label}. Anonymous posting is ready, with L2 gas paid by Sponsored FPC.`,
      "success"
    );
    setWalletPanel(false);
    await refresh(false);
  }

  async function readImportedAccount() {
    const file = view.accountFile;
    if (!file) throw new Error("Select an Aztec account JSON backup");
    if (file.size > 64 * 1024)
      throw new Error("Account backup file is too large");
    const account = JSON.parse(await file.text());
    if (
      !account ||
      typeof account !== "object" ||
      !["secretKey", "salt", "signingKey", "address"].every(
        (key) => typeof account[key] === "string" && account[key]
      )
    ) {
      throw new Error(
        "Account backup requires secretKey, salt, signingKey and address fields"
      );
    }
    if (
      !/^0x[\da-f]{1,64}$/i.test(account.secretKey) ||
      !/^(0x[\da-f]+|\d+)$/i.test(account.salt) ||
      !/^(0x)?[\da-f]{1,64}$/i.test(account.signingKey) ||
      !/^0x[\da-f]{64}$/i.test(account.address)
    ) {
      throw new Error("Invalid account key or salt format");
    }
    return account;
  }

  async function connectLocal() {
    const a = A();
    const chain = await checkChain();
    const mode = view.walletMode;
    showProgress("Preparing the browser Aztec account…");
    const account =
      mode === "create"
        ? await createLocalAccount()
        : mode === "import"
          ? await readImportedAccount()
          : mode === "local"
            ? savedLocalAccounts().find(
                (item) => item.address === view.savedAccount
              )
            : undefined;
    if (!account)
      throw new Error("Choose a saved account, or create/import one");
    const setupOptions = accountSetupOptions(
      a,
      account,
      `pxe_df_harness_${deployment.rollupAddress}_${account.address}_`,
      chain.realProofs
    );
    const derived = await deriveAccountAddress(
      account.secretKey,
      BigInt(account.salt),
      setupOptions.signingKey
    );
    if (
      derived.address.toString().toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error(
        "Account address does not match the address derived from the keys"
      );
    }
    // Persist new/imported credentials before the slower PXE setup. A failed
    // initialization can then be retried through "Saved accounts" after reloading.
    if (mode === "create" || mode === "import") rememberLocalAccount(account);
    try {
      const connected = await ensureAztecSetup(state, "log", {
        ...setupOptions,
        onProgress: (step, total, message) => {
          showProgress(`Wallet initialization · ${message}`, step, total);
        },
      });
      if (!connected) throw new Error("Wallet initialization failed");
      if (
        state.address.toString().toLowerCase() !== account.address.toLowerCase()
      ) {
        throw new Error("Browser account address does not match the backup");
      }
      if (mode === "local") {
        localStorage.setItem(activeLocalAccountKey(), account.address);
        publishLocalAccounts(account.address);
      }
      state.localAccount = account;
      await finishConnect(account.label || "Aztec browser account");
    } finally {
      patch({ accountFile: null, fileVersion: view.fileVersion + 1 });
    }
  }

  async function scanWallets() {
    await prepareWallet();
    showProgress("Scanning for Aztec extension wallets…");
    patch({
      extensionStatus:
        "Looking for Azguard. If a connection request appears in your wallet, approve it within 60 seconds…",
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
        ? `Found ${providers.map((provider) => provider.name).join(", ")}. Azguard is preferred.`
        : `No Azguard response. After switching nodes, approve this site again in your wallet. Check extension site permissions and compatibility with Aztec ${SDK_VERSION}.`,
    });
    publishSession();
    log(
      providers.length
        ? `Found ${providers.length} Aztec extension wallets. Select one to connect.`
        : "No Aztec extension wallets found. Check Azguard site permissions and version, or use the browser wallet.",
      providers.length ? "success" : "info",
      "log"
    );
  }

  async function startExtensionConnection() {
    const provider = providers[Number(view.provider)];
    if (!provider)
      throw new Error(
        `Azguard was not found. Check extension site permissions and Aztec ${SDK_VERSION} compatibility.`
      );
    patch({
      extensionStatus: `Requesting a secure connection to ${provider.name}…`,
    });
    showProgress(`Waiting for a secure connection to ${provider.name}…`);
    pendingConnection = await provider.establishSecureChannel("df-billboard");
    patch({
      emoji: Array.from(
        A().hashToEmoji(pendingConnection.verificationHash, 9)
      ).join(" "),
    });
    patch({ verification: true });
    patch({
      extensionStatus: `Check the emojis in ${provider.name} before confirming`,
    });
    log(
      "Compare the emojis on this page and in your wallet before confirming.",
      "info",
      "log"
    );
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
    if (!provider || !pending)
      throw new Error("No pending wallet connection to confirm");
    pendingConnection = null;
    patch({ verification: false });
    try {
      showProgress("Waiting for wallet approval…");
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
          "The wallet did not grant all required account, contract registration, simulation or transaction capabilities."
        );
      }
      patch({
        grantedAccounts: accountsGranted.map((entry, index) => ({
          value: String(index),
          label: `${entry.alias || "Account"} · ${entry.item}`,
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
    patch({
      extensionStatus: "Connection cancelled. You can reconnect to Azguard.",
    });
    publishSession();
  }

  async function connect() {
    await prepareWallet();
    if (view.walletMode !== "metamask")
      boardArtifact ||= await readArtifact("board");
    if (view.walletMode === "metamask") {
      if (!requestPosting && deployment.l1Request) {
        const config = {
          kind:
            environment(deployment.environment) === "local"
              ? "local-sponsored-l1-post"
              : "testnet-sponsored-l1-post",
          nodeUrl: deployment.nodeUrl,
          rollupAddress: deployment.rollupAddress,
          rollupVersion: String(deployment.rollupVersion),
          board: deployment.board,
          sponsoredFpc: deployment.sponsoredFpc,
          sponsorSalt: deployment.sponsorSalt,
          l1: deployment.l1Request,
        };
        requestPosting = (
          deps.createMetaMaskPosting ||
          (await import("./metamask-posting.ts")).createMetaMaskPosting
        )(
          config,
          A(),
          (request) => {
            patch({ request });
            publishSession();
          },
          showProgress
        );
      }
      if (!requestPosting)
        throw new Error(
          "This board has no L1 entry. Deploy a board with MetaMask support first."
        );
      await checkChain();
      await checkSponsorBalance();
      await requestPosting.connect();
      setWalletPanel(false);
      await refresh(false);
    } else if (view.walletMode === "extension") {
      try {
        if (!providers.length) await scanWallets();
        await startExtensionConnection();
      } catch (error) {
        if (providers.length)
          patch({
            extensionStatus:
              "Connection failed. Check the activity log and retry.",
          });
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
        throw error;
      }
    }
  }

  async function disconnect() {
    pendingConnection?.cancel();
    pendingConnection = null;
    requestPosting?.disconnect();
    await state.provider?.disconnect?.();
    await state.pxe?.stop?.();
    Object.assign(state, {
      wallet: null,
      pxe: null,
      address: null,
      aztecNode: null,
      localAccount: null,
      feePaymentMethod: null,
      provider: null,
    });
    contracts = null;
    providers = [];
    patch({
      providers: [],
      grantedAccounts: [],
      verification: false,
      copied: false,
      walletOpen: true,
    });
    publishSession();
  }

  async function finishRequest(message) {
    // Clear only the confirmed draft, including after resuming a saved request.
    if (view.message === message) patch({ message: "" });
    showProgress("Post confirmed. Refreshing the public feed…");
    try {
      await refresh(false);
      if (view.actionError?.label === "Refresh posts")
        patch({ actionError: null });
      return "Post published";
    } catch (error) {
      patch({
        actionError: {
          label: "Refresh posts",
          message: error?.message || String(error),
          guidance:
            "Your post is confirmed onchain. Refresh the feed to see it; do not submit it again.",
        },
      });
      log("Post confirmed, but the feed could not be refreshed.", "warn");
      return "Post published · Feed refresh unavailable";
    }
  }

  async function post() {
    const from = state.address;
    const message = view.message;
    showProgress("Checking and encoding the message…", 0, 2);
    const { text, length } = encodeDFMessage(message);
    if (view.walletMode === "metamask") {
      if (!requestPosting)
        throw new Error("MetaMask posting is not configured");
      return finishRequest(await requestPosting.post(message));
    }
    if (!state.wallet || !contracts?.board || !state.feePaymentMethod)
      throw new Error("Connect an Aztec wallet first");
    await checkChain();
    await checkSponsorBalance();
    showProgress("Message encoded. Preparing the transaction.", 1, 2);
    showProgress(
      "Generating a proof and submitting the anonymous post. Waiting for confirmation…"
    );
    const tx = await withWalletLock(
      `${deployment.rollupAddress}:${from.toString().toLowerCase()}`,
      async () =>
        contracts.board.methods.post(text, length).send({
          from,
          fee: await getBillboardFeeOptions(
            state.aztecNode,
            state.feePaymentMethod,
            A().GasFees
          ),
        })
    );
    if (tx.receipt.executionResult !== "success")
      throw new Error(`Posting failed: ${tx.receipt.executionResult}`);
    log(
      `Anonymous post confirmed onchain: ${tx.receipt.txHash}`,
      "success",
      "log"
    );
    return finishRequest(message);
  }

  function publishPosts(changes = {}) {
    patch({
      ...changes,
      posts: state.posts.map((post) => ({ ...post })),
    });
  }

  function readFeed(older, reportProgress = true) {
    return (feedReading ||= loadFeed(older, reportProgress).finally(() => {
      feedReading = undefined;
    }));
  }

  async function loadFeed(older, reportProgress) {
    pauseAiHints();
    if (!publicNode || !readLayout)
      throw new Error("Billboard is not initialized");
    if (older && (!feedCursor || feedCursor.before === 0)) return;
    if (reportProgress)
      showProgress(older ? "Loading older posts…" : "Loading recent posts…");
    patch({ feedLoading: true });
    try {
      const result = await readPostPage(
        R(),
        publicNode,
        deployment.board,
        readLayout,
        older ? feedCursor : undefined,
        // Keep a previously loaded snapshot intact during refresh/pagination.
        !view.feedLoaded
          ? (posts, total) => {
              if (disposed) return;
              state.posts = classifyRulePosts(posts);
              publishPosts({ totalPosts: total });
            }
          : undefined
      );
      if (disposed) return;
      feedCursor = result.cursor;
      state.posts = classifyRulePosts(
        older ? [...result.posts, ...state.posts] : result.posts
      );
      publishPosts({
        feedLoaded: true,
        totalPosts: feedCursor.total,
        hasOlderPosts: feedCursor.before > 0,
        feedRevision: view.feedRevision + (older ? 0 : 1),
      });
    } finally {
      patch({ feedLoading: false });
    }
    if (view.aiHints) void runAiHints();
    log(
      `Loaded ${state.posts.length} of ${feedCursor.total} public posts`,
      "info",
      "log"
    );
  }
  async function refresh(reportProgress = true) {
    await readFeed(false, reportProgress);
  }

  function setField(name, value) {
    const editable = [
      "walletMode",
      "savedAccount",
      "accountLabel",
      "accountFile",
      "provider",
      "message",
      "rulesEnabled",
      "keywordEnabled",
      "keywordMode",
    ];
    const readingFields = ["rulesEnabled", "keywordEnabled", "keywordMode"];
    if (!editable.includes(name) || (busy && !readingFields.includes(name)))
      return;
    if (
      ["rulesEnabled", "keywordEnabled"].includes(name) &&
      typeof value !== "boolean"
    )
      return;
    if (name === "keywordMode" && !["contains", "word"].includes(value)) return;
    if (
      ["walletMode", "savedAccount", "provider"].includes(name) &&
      (state.wallet || view.request.payer || pendingConnection)
    )
      return;
    if (
      name === "walletMode" &&
      !["local", "create", "import", "extension", "metamask"].includes(value)
    )
      return;
    if (name === "walletMode") walletModeSelected = true;
    patch({ [name]: value });
    if (readingFields.includes(name)) savePreferences();
    if (name === "walletMode" || name === "provider") publishSession();
  }
  async function copyAddress() {
    if (!view.address) return;
    try {
      await navigator.clipboard.writeText(view.address);
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
  function initializeOnce() {
    return (initializing ||= initialize()
      .then(() => {
        if (view.actionError?.label === "Load Billboard")
          patch({ actionError: null });
      })
      .catch((error) => {
        initializing = undefined;
        fail(error, "Load Billboard");
        throw error;
      }));
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    initialize: initializeOnce,
    log,
    setField,
    setWalletPanel,
    setAiHints,
    confirmAiHints,
    clearAiCache,
    saveKeywords,
    copyAddress,
    accountBackup,
    connect: () => action(connect, "Connect wallet"),
    disconnect: () => action(disconnect, "Switch wallet"),
    resumeRequest: (hash) =>
      action(async () => {
        if (!view.request.payer || !requestPosting)
          throw new Error("Reconnect MetaMask first");
        return finishRequest(await requestPosting.resume(hash));
      }, "Anonymous posting"),
    scan: () => action(scanWallets, "Scan extension wallets"),
    confirmWallet: () =>
      action(confirmExtensionConnection, "Authorize and connect wallet"),
    cancelWallet: cancelExtensionConnection,
    selectGrantedAccount: (value) =>
      action(async () => {
        patch({ grantedAccount: value });
        state.address = state.grantedAccounts[Number(value)].item;
        await finishConnect(state.provider.name);
      }, "Switch wallet account"),
    post: () => action(post, "Anonymous posting"),
    refresh: () => action(refresh, "Refresh posts"),
    loadOlder: () => action(() => readFeed(true), "Load older posts"),
    dispose: () => {
      disposed = true;
      requestPosting?.dispose();
      reading.dispose();
      pendingConnection?.cancel();
      clearTimeout(progressHideTimer);
      clearTimeout(copyTimer);
      listeners.clear();
    },
  };
}
