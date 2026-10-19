// @ts-nocheck -- SDK wallet objects retain the legacy adapter's dynamic types.
// Its public surface remains typed; internal SDK state can be tightened separately.
import {
  decodeDFMessage,
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../shared/df-billboard.mjs";
import { AI_CACHE_NAME, AI_MODEL_VERSION, safetyResult } from "./ai-config.ts";
import { parseKeywords } from "./keywords.ts";
import {
  createL1Ports,
  createL1Queue,
  emptyL1View,
  l1MessageLeaf,
} from "./l1.ts";
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
    localStatus: "Browser wallet not initialized",
    extensionStatus: "Waiting to connect Azguard",
    copied: false,
    message: "",
    publishToL1: false,
    l1: emptyL1View,
    logs: [],
    posts: [],
    feedLoaded: false,
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
  let accounts;
  let contracts;
  let boardArtifact;
  let publicNode;
  let l1Queue;
  let l1Timer;
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
  function finishProgress(label, succeeded) {
    showProgress(
      `${label}${succeeded ? " completed" : " failed"}`,
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
      throw new Error("Only local Aztec nodes are supported");
    if (!["127.0.0.1", "localhost"].includes(location.hostname))
      throw new Error("Open this test page from localhost");
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
    const response = await fetch("/df-local.json", { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        "No local deployment found. Run npm run deploy:df:harness first."
      );
    deployment = await response.json();
    ensureLocal(deployment.nodeUrl);
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
        "Billboard deployment or contract version mismatch. Run npm run deploy:df:harness again."
      );
    patch({ canRead: true });
    if (deployment.l1) {
      const bridge = {
        discover: async (hash) => {
          const a = A();
          const abiType = boardArtifact.outputs.structs.events.find((event) =>
            event.path.endsWith("::L1PostQueued")
          );
          if (!abiType)
            throw new Error(
              "Billboard artifact is missing the L1 event. Redeploy the contract."
            );
          const found = await a.getPublicEvents(
            publicNode,
            {
              abiType,
              eventSelector: await a.EventSelector.fromSignature(
                "L1PostQueued(u32,Field)"
              ),
              fieldNames: abiType.fields.map((field) => field.name),
            },
            {
              contractAddress: a.AztecAddress.fromStringUnsafe(
                deployment.board
              ),
              txHash: a.TxHash.fromString(hash),
            }
          );
          if (found.events.length !== 1)
            throw new Error(
              "No matching L1 post event found for this transaction."
            );
          const event = found.events[0].event;
          const content = new a.Fr(BigInt(event.content)).toString();
          const leaf = l1MessageLeaf(
            deployment.board,
            deployment.rollupVersion,
            deployment.l1.publisher,
            content
          );
          const effect = await publicNode.getTxEffect(
            a.TxHash.fromString(hash)
          );
          const index = effect.data.l2ToL1Msgs.findIndex(
            (message) => message.toString() === leaf
          );
          if (index < 0)
            throw new Error(
              "Cross-chain message does not match the receiver contract."
            );
          return { id: event.id.toString(), leaf, index };
        },
        witness: async (hash, leaf, index) => {
          const witness = await publicNode.getL2ToL1MembershipWitness(
            A().TxHash.fromString(hash),
            A().Fr.fromString(leaf),
            index
          );
          return witness
            ? [
                Number(witness.epochNumber),
                Number(witness.numCheckpointsInEpoch),
                BigInt(witness.leafIndex),
                witness.siblingPath
                  .toBufferArray()
                  .map(
                    (buffer) =>
                      `0x${Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
                  ),
              ]
            : null;
        },
        prove: async () => {
          await checkChain();
          await A().createAztecNodeDebugClient(deployment.nodeUrl).prove();
        },
      };
      try {
        l1Queue = createL1Queue(
          createL1Ports(deployment, bridge, () => l1Queue?.disconnect()),
          localStorage,
          `billboard:l1:${deployment.rollupAddress}:${deployment.board}:${deployment.l1.publisher}`,
          (l1) => patch({ l1 })
        );
        await l1Queue.initialize();
        l1Timer = setInterval(() => void l1Queue.refresh(), 4000);
      } catch (error) {
        l1Queue?.dispose();
        l1Queue = null;
        patch({ l1: { ...emptyL1View, error: error.message } });
      }
    }
    await refresh(false);
    publishSession();
  }

  async function checkChain() {
    const node = state.aztecNode || publicNode;
    const info = await node.getNodeInfo();
    const l1 = await node.getL1ContractAddresses();
    if (
      Number(info.l1ChainId) !== 31337 ||
      info.nodeVersion !== "6.0.0-rc.3" ||
      info.realProofs !== false ||
      l1.rollupAddress.toString() !== deployment.rollupAddress
    ) {
      throw new Error(
        "Deployment does not match the local chain. Redeploy the test contracts."
      );
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
        "Sponsored FPC has insufficient balance. Fund the sponsor contract and retry; your balance will not be charged."
      );
  }

  async function finishConnect(label) {
    showProgress("Checking the local chain and loading Billboard…", 0, 2);
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
            : accounts[Number(view.account)];
    if (!account) throw new Error("Invalid test account");
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
      throw new Error(
        "Account address does not match the address derived from the keys"
      );
    }
    // Persist new/imported credentials before the slower PXE setup. A failed
    // initialization can then be retried through "Saved accounts" after reloading.
    if (mode === "create" || mode === "import") rememberLocalAccount(account);
    patch({ localStatus: "Initializing the browser Aztec wallet…" });
    try {
      const connected = await ensureAztecSetup(state, "log", {
        secretKey: account.secretKey,
        salt: account.salt,
        dataDirPrefix: `pxe_df_harness_${deployment.rollupAddress}_${account.address}_`,
        signingKey: signingField,
        proverEnabled: view.realProofs,
        blockMonitor: false,
        onProgress: (step, total, message) => {
          patch({
            localStatus: `Wallet initialization ${step}/${total} · ${message}`,
          });
          showProgress(`Wallet initialization · ${message}`, step, total);
        },
      });
      if (!connected) throw new Error("Wallet initialization failed");
      if (
        state.address.toString().toLowerCase() !== account.address.toLowerCase()
      ) {
        throw new Error("Browser account address does not match the backup");
      }
      if (mode !== "test") {
        rememberLocalAccount(account);
        state.localAccount = account;
      }
      await finishConnect(
        account.label ||
          (mode === "test"
            ? "Preconfigured test account"
            : "Aztec browser account")
      );
      patch({
        localStatus:
          mode === "create"
            ? "Account created and connected. Use Download account backup to keep your keys safe."
            : "Browser wallet connected.",
      });
    } finally {
      patch({ accountFile: null, fileVersion: view.fileVersion + 1 });
    }
  }

  async function scanWallets() {
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
        : "No Azguard response. After switching nodes, approve this site again in your wallet. Check extension site permissions and compatibility with local Aztec 6.0.0-rc.3.",
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
        "Azguard was not found. Check extension site permissions and Aztec 6.0.0-rc.3 compatibility."
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
    if (view.walletMode === "extension") {
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
        patch({
          localStatus: `Connection failed: ${error.message || String(error)}. Reload the page to retry.`,
        });
        throw error;
      }
    }
  }

  async function post() {
    const from = state.address;
    const message = view.message;
    showProgress("Checking and encoding the message…", 0, 2);
    const { text, length } = encodeDFMessage(message);
    if (!state.wallet || !contracts?.board || !state.feePaymentMethod)
      throw new Error("Connect an Aztec wallet first");
    await checkChain();
    await checkSponsorBalance();
    showProgress("Message encoded. Preparing the transaction.", 1, 2);
    showProgress(
      "Generating a proof and submitting the anonymous post. Waiting for confirmation…"
    );
    if (view.publishToL1 && !view.l1.available)
      throw new Error("L1 deployment is not ready");
    const mirror = view.publishToL1;
    const interaction = mirror
      ? contracts.board.methods.post_to_l1(
          text,
          length,
          A().EthAddress.fromString(deployment.l1.publisher)
        )
      : contracts.board.methods.post(text, length);
    const tx = await interaction.send({
      from,
      fee: await getBillboardFeeOptions(
        state.aztecNode,
        state.feePaymentMethod,
        A().GasFees
      ),
    });
    if (tx.receipt.executionResult !== "success")
      throw new Error(`Posting failed: ${tx.receipt.executionResult}`);
    // Confirmation consumes this draft, even if the later feed refresh fails.
    if (view.message === message) patch({ message: "" });
    if (mirror) l1Queue.add(tx.receipt.txHash.toString(), message);
    log(
      `Anonymous post confirmed onchain: ${tx.receipt.txHash}`,
      "success",
      "log"
    );
    showProgress("Post confirmed. Refreshing the public feed…");
    await refresh(false);
    showProgress("Post published and feed updated", 2, 2);
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
    disposeAiWorker("AI analysis paused");
    patch({
      aiProgress: null,
      aiStatus:
        "AI analysis paused until the current onchain operation finishes.",
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
          aiProgress: { file: String(progress.file || "Model"), percent },
          aiStatus:
            progress.status === "ready"
              ? "Model ready. Analyzing locally…"
              : `Loading the English/Chinese model: ${progress.file || "Initializing runtime"}${percent === undefined ? "" : ` · ${percent.toFixed(0)}%`}. Disable AI to cancel.`,
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
        disposeAiWorker(event.message || "AI worker failed");
    };
    worker.onmessageerror = () => {
      if (aiWorker === worker)
        disposeAiWorker("AI worker returned unreadable data");
    };
    aiWorker = worker;
    return worker;
  }

  function classifyWithAi(texts) {
    return new Promise((resolve, reject) => {
      const id = ++aiRequestId;
      const timer = setTimeout(() => {
        if (aiPending.has(id))
          disposeAiWorker(
            "Model loading or analysis timed out. Disable and re-enable AI filtering to retry."
          );
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
      patch({ aiStatus: "No posts to analyze." });
      return;
    }
    patch({ aiStatus: "Checking the local AI classification cache…" });
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
          aiStatus: `Experimental AI analysis: ${Math.min(offset + batch.length, missing.length)}/${missing.length} posts. First use requires a model download.`,
        });
        const results = await classifyWithAi(
          batch.map((entry) => entry.post.text)
        );
        if (generation !== aiGeneration) return;
        if (!Array.isArray(results) || results.length !== batch.length)
          throw new Error("Unexpected number of AI classification results");
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
        aiStatus: `AI analyzed ${posts.length} posts (${missing.length} newly analyzed). Flagged posts move to Filtered; unflagged does not mean safe.`,
      });
    } catch (error) {
      if (generation !== aiGeneration) return;
      disposeAiWorker("AI analysis failed");
      patch({
        aiProgress: null,
        aiStatus: `AI filtering unavailable: ${error?.message || String(error)}. Unreviewed posts remain visible. Keywords and basic rules still work.`,
      });
      console.error("AI classification failed", error);
    }
  }

  async function refresh(reportProgress = true) {
    // Cancel analysis of the previous feed before replacing its post objects.
    pauseAiHints();
    if (!publicNode || !boardArtifact)
      throw new Error("Billboard is not initialized");
    const sdk = A();
    const addr = sdk.AztecAddress.fromStringUnsafe(deployment.board);
    const layout = boardArtifact.storageLayout;
    // Read one consistent public-state snapshot; no wallet or simulation needed.
    const block = await publicNode.getBlockNumber();
    const read = (slot) => publicNode.getPublicStorageAt(block, addr, slot);
    if (reportProgress) showProgress("Loading the public post count…");
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
          `Could not decode post #${id}: ${error?.message || String(error)}`,
          "error",
          "log"
        );
      }
      if (reportProgress) showProgress("Loading public posts…", id + 1, count);
    }
    state.posts = classifyRulePosts(posts);
    publishFeed();
    if (view.aiHints) {
      if (busy) aiNeedsRun = true;
      else void runAiHints();
    }
    if (reportProgress && count === 0)
      showProgress("No public posts yet", 1, 1);
    log(`Loaded ${count} public posts`, "info", "log");
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
      "publishToL1",
      "rulesEnabled",
      "keywordEnabled",
      "keywordMode",
    ];
    const readingFields = ["rulesEnabled", "keywordEnabled", "keywordMode"];
    if (!editable.includes(name) || (busy && !readingFields.includes(name)))
      return;
    if (
      ["rulesEnabled", "keywordEnabled", "publishToL1"].includes(name) &&
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
      ...(enabled
        ? { aiStatus: "AI enabled. Waiting to load public posts." }
        : {}),
    });
    savePreferences();
    if (enabled) void runAiHints();
    else {
      aiGeneration++;
      aiNeedsRun = false;
      disposeAiWorker("AI filtering disabled");
      patch({ aiProgress: null, aiStatus: "AI filtering is off" });
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
          "Model and board classification caches cleared. Enabling AI again will reload the model.",
      });
    } catch (error) {
      patch({ aiStatus: `Cache clearing incomplete: ${error.message}` });
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
        fail(error, "Load Billboard");
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
    connect: () => action(connect, "Connect wallet"),
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
    connectL1: () => l1Queue?.connect(),
    publishL1: (hash) => l1Queue?.publish(hash),
    refreshL1: () => l1Queue?.refresh(),
    proveL1: () => l1Queue?.prove(),
    fundL1: () => l1Queue?.faucet(),
    refresh: () => action(refresh, "Refresh posts"),
    dispose: () => {
      disposed = true;
      clearInterval(l1Timer);
      l1Queue?.dispose();
      aiGeneration++;
      aiNeedsRun = false;
      pendingConnection?.cancel();
      disposeAiWorker("Page closed");
      clearTimeout(progressHideTimer);
      clearTimeout(copyTimer);
      listeners.clear();
    },
  };
}
