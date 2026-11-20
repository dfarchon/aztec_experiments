import { encodeDFMessage } from "../../../protocol/message.mjs";
import type { AztecRuntime } from "../../../runtime/wallet-runtime.mjs";
import {
  createFeedReader,
  type FeedCursor,
  type FeedSDK,
  type Layout,
} from "../features/feed/feed-reader.ts";
import {
  fetchPublicJson,
  loadReadLayout,
  publicReadSDK,
} from "../features/feed/public-reader.ts";
import {
  type InjectedProvider,
  listEthereumWallets,
} from "../features/wallet/l1.ts";
import {
  clearWalletSession,
  readWalletSession,
  writeWalletSession,
} from "../features/wallet/wallet-session.ts";
import type { WalletSessionPreference } from "../features/wallet/wallet-types.ts";
import { environment, validateChain, validateRpc } from "./network.ts";
import type { BillboardController, BillboardView, PostData } from "./types";

type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ReadRuntime = Pick<
  FeedSDK,
  "Fr" | "AztecAddress" | "deriveStorageSlotInMap"
> & {
  createAztecNodeClient(
    url: string
  ): ReturnType<typeof publicReadSDK.createAztecNodeClient>;
};
type ControllerField = "connecting" | "posting" | "restoring";

export interface ControllerDependencies {
  storage?: StorageAccess;
  readSdk?: () => ReadRuntime;
  readPostPage?: ReturnType<typeof createFeedReader>;
  fetchPublicJson?: (
    url: string,
    options?: RequestInit
  ) => Promise<NotchDeployment>;
  loadReadLayout?: typeof loadReadLayout;
  loadWalletRuntime?: () => Promise<AztecRuntime>;
  createWalletFlow?: typeof import("../features/wallet/wallet-flow.ts").createWalletFlow;
  listEthereumWallets?: typeof listEthereumWallets;
}

type NotchDeployment = Awaited<ReturnType<typeof fetchPublicJson>> & {
  board: string;
  boardClassId: string;
  boardArtifactHash: string;
  sponsoredFpc: string;
  environment?: "local" | "testnet";
  l1Stake: { rpcUrl: string; portal: string };
};
type PublicNode = ReturnType<ReadRuntime["createAztecNodeClient"]>;

export function createBillboardController(
  deps: ControllerDependencies = {}
): BillboardController {
  const readRuntime = deps.readSdk || (() => publicReadSDK);
  const listeners = new Set<() => void>();
  const readPostPage = deps.readPostPage || createFeedReader();
  let disposed = false;
  let initializing: Promise<void> | undefined;
  let deploymentReady: Promise<NotchDeployment> | undefined;
  let walletRuntime: Promise<AztecRuntime> | undefined;
  let sessionRestore: Promise<void> | undefined;
  let sessionGeneration = 0;
  const storage = () => {
    try {
      return deps.storage || globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  const discoverWallets = () =>
    (deps.listEthereumWallets || listEthereumWallets)();
  let deployment: NotchDeployment;
  let publicNode: PublicNode;
  let readLayout: Layout;
  let feedCursor: FeedCursor | undefined;
  let feedReading: Promise<void> | undefined;
  let walletFlow:
    | ReturnType<
        typeof import("../features/wallet/wallet-flow.ts").createWalletFlow
      >
    | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let logId = 0;
  let posts: PostData[] = [];
  let view: BillboardView = {
    busy: false,
    connecting: false,
    restoring: false,
    posting: false,
    connected: false,
    canRead: false,
    canPost: false,
    walletOpen: false,
    message: "",
    deployment: null,
    stake: {
      available: false,
      payer: "",
      owner: "",
      aztecReady: false,
      setupComplete: false,
      l1Amount: null,
      amount: "0",
      stakeChoice: "500000000000000",
      remaining: null,
      pendingDeposit: false,
      pendingAmount: "0",
      depositL1Confirmed: false,
      depositPrepared: false,
      depositNeedsHash: false,
      claimNeedsHash: false,
      pendingExit: false,
      exitNeedsHash: false,
      lastPost: "0",
    },
    progress: null,
    actionError: null,
    logs: [],
    posts: [],
    feedLoaded: false,
    feedLoading: false,
    totalPosts: 0,
    hasOlderPosts: false,
    feedRevision: 0,
  };
  function patch(changes: Partial<BillboardView>) {
    if (disposed) return;
    view = { ...view, ...changes };
    listeners.forEach((listener) => listener());
  }
  function log(message: unknown, type = "info") {
    patch({
      logs: [
        ...view.logs.slice(-99),
        {
          id: ++logId,
          message: String(message),
          type,
          time: new Date().toLocaleTimeString("en-GB"),
        },
      ],
    });
  }
  function publishStake(stake: BillboardView["stake"]) {
    const connected = Boolean(stake.payer);
    if (!connected && view.stake.payer) {
      sessionGeneration++;
      const activeStorage = storage();
      if (activeStorage) clearWalletSession(activeStorage, deployment);
      walletFlow?.dispose();
      walletFlow = undefined;
    }
    patch({
      stake,
      connected,
      canPost:
        stake.aztecReady &&
        Boolean(stake.owner) &&
        BigInt(stake.amount) > 0n &&
        !stake.pendingDeposit &&
        !stake.pendingExit,
    });
  }
  function progress(label: string) {
    clearTimeout(progressTimer);
    patch({ progress: { label, completed: false, failed: false } });
  }
  function finish(
    label: string,
    success: boolean,
    completedLabel?: string | false
  ) {
    clearTimeout(progressTimer);
    if (success && completedLabel === false) {
      patch({ progress: null });
      return;
    }
    patch({
      progress: {
        label: success
          ? completedLabel || `${label} completed`
          : `${label} failed`,
        completed: true,
        failed: !success,
      },
    });
    progressTimer = setTimeout(
      () => patch({ progress: null }),
      success ? 2500 : 6000
    );
  }
  function fail(error: unknown, label: string) {
    const message = (error as { message?: string })?.message || String(error);
    patch({
      actionError: {
        label,
        message,
        guidance:
          "If a transaction was submitted, check its receipt before retrying.",
      },
    });
    log(message, "error");
    console.error(error);
  }
  async function action<T>(
    fn: () => Promise<T | void>,
    label: string,
    field?: ControllerField
  ) {
    if (view.busy) return;
    patch({
      busy: true,
      connecting: field === "connecting",
      posting: field === "posting",
      restoring: field === "restoring",
      ...(view.actionError?.label === label ? { actionError: null } : {}),
    });
    progress(`${label}…`);
    let success = false;
    let completedLabel: string | false | undefined;
    try {
      const result = await fn();
      completedLabel =
        result === false
          ? false
          : typeof result === "string"
            ? result
            : undefined;
      success = true;
    } catch (error) {
      fail(error, label);
    } finally {
      patch({
        busy: false,
        connecting: false,
        posting: false,
        restoring: false,
      });
      finish(label, success, completedLabel);
    }
  }
  async function checkChain() {
    const info = await publicNode.getNodeInfo();
    validateChain(
      environment(deployment.environment),
      deployment,
      info,
      info.l1ContractAddresses.rollupAddress.toString()
    );
  }
  async function loadDeployment() {
    return (deploymentReady ||= (async () => {
      deployment = await (deps.fetchPublicJson || fetchPublicJson)(
        "/df-local.json",
        { cache: "no-store" }
      );
      const env = environment(deployment.environment);
      validateRpc(deployment.nodeUrl, env);
      if (env === "local") validateRpc(location.origin, env);
      else if (
        location.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(location.hostname)
      )
        throw new Error("Public deployments require HTTPS");
      if (
        deployment.kind !== "notch-stake" ||
        deployment.schemaVersion !== 2 ||
        !deployment.l1Stake
      )
        throw new Error("This website needs a stake-enabled Notch deployment");
      if (!deployment.sponsoredFpc) throw new Error("Sponsored FPC is missing");
      publicNode = readRuntime().createAztecNodeClient(deployment.nodeUrl);
      patch({
        deployment,
        stake: { ...view.stake, available: true },
      });
      return deployment;
    })().catch((error) => {
      deploymentReady = undefined;
      throw error;
    }));
  }
  async function initialize() {
    await loadDeployment();
    void (sessionRestore ||= restoreSession());
    const address = readRuntime().AztecAddress.fromStringUnsafe(
      deployment.board
    );
    const [chainCheck, layoutCheck, instanceCheck] = await Promise.allSettled([
      checkChain(),
      (deps.loadReadLayout || loadReadLayout)(deployment.boardArtifactHash),
      publicNode.getContract(address),
    ]);
    for (const result of [chainCheck, layoutCheck, instanceCheck])
      if (result.status === "rejected") throw result.reason;
    if (
      layoutCheck.status !== "fulfilled" ||
      instanceCheck.status !== "fulfilled"
    )
      throw new Error("Notch initialization did not complete");
    const layout = layoutCheck.value;
    const instance = instanceCheck.value;
    if (
      !instance ||
      instance.currentContractClassId.toString() !== deployment.boardClassId
    )
      throw new Error("Board class does not match the deployment");
    readLayout = layout;
    patch({
      canRead: true,
    });
    try {
      await refresh(false);
    } catch (error) {
      fail(error, "Load posts");
    }
  }
  function initializeOnce() {
    return (initializing ||= initialize()
      .then(() => {
        if (view.actionError?.label === "Load Notch")
          patch({ actionError: null });
      })
      .catch((error) => {
        initializing = undefined;
        fail(error, "Load Notch");
        throw error;
      }));
  }
  async function prepareWallet() {
    await loadDeployment();
    return (walletRuntime ||= (async () => {
      if (deps.loadWalletRuntime) return deps.loadWalletRuntime();
      const { loadWalletRuntime } = await import("../features/wallet/aztec.ts");
      return loadWalletRuntime({
        nodeUrl: deployment.nodeUrl,
        onLog: log,
      });
    })().catch((error) => {
      walletRuntime = undefined;
      throw error;
    }));
  }
  async function restoreSession() {
    const activeStorage = storage();
    if (!activeStorage) return;
    const session = readWalletSession(activeStorage, deployment);
    if (!session?.payer || !session?.walletName || view.busy || disposed)
      return;
    await action(
      async () => {
        const generation = sessionGeneration;
        try {
          const wallets = await discoverWallets();
          if (disposed || generation !== sessionGeneration) return false;
          const selected =
            wallets.find((wallet) => wallet.id === session.walletId) ||
            wallets.find((wallet) => wallet.name === session.walletName);
          if (!selected) return false;
          const result = await connect(selected.provider, session);
          if (result === false || disposed || generation !== sessionGeneration)
            return false;
          if (
            view.stake.setupComplete &&
            !view.stake.pendingDeposit &&
            !view.stake.pendingExit
          ) {
            progress("Restoring account…");
            await initializeAztec();
          }
          return false;
        } catch (error) {
          if (!disposed && generation === sessionGeneration) throw error;
          return false;
        }
      },
      "Restore account",
      "restoring"
    );
  }
  async function connect(
    provider: InjectedProvider,
    session?: Pick<WalletSessionPreference, "payer">
  ) {
    await loadDeployment();
    if (!walletFlow)
      walletFlow = (
        deps.createWalletFlow ||
        (await import("../features/wallet/wallet-flow.ts")).createWalletFlow
      )(deployment, undefined, publishStake, progress);
    const result = await walletFlow.connect(provider, session);
    if (result === false) return false;
    if (!session) {
      const activeStorage = storage();
      if (activeStorage) {
        const selected = (await discoverWallets()).find(
          (wallet) => wallet.provider === provider
        );
        if (selected)
          writeWalletSession(activeStorage, deployment, {
            walletId: selected.id,
            walletName: selected.name,
            payer: view.stake.payer,
          });
      }
      patch({ walletOpen: true });
      if (
        view.stake.setupComplete &&
        !view.stake.pendingDeposit &&
        !view.stake.pendingExit
      ) {
        patch({ restoring: true });
        progress("Restoring account…");
        await initializeAztec();
      }
    }
  }
  async function initializeAztec() {
    if (!walletFlow) throw new Error("Connect and stake first");
    const runtime = await prepareWallet();
    await checkChain();
    if ((await walletFlow.initializeAztec(runtime)) === false) return false;
    return "Aztec account ready";
  }
  async function stake(amount: string) {
    if (!walletFlow) throw new Error("Connect your L1 wallet first");
    // Start downloading and initializing proof resources once the L1 hash is
    // saved. Account setup and claiming still wait for verified confirmation.
    let preparation;
    let preparationError;
    const startPreparation = () => {
      preparation ||= (async () => {
        const runtime = await prepareWallet();
        if (environment(deployment.environment) !== "local")
          await runtime.prepareProofEnvironment();
      })().catch((error) => {
        preparationError = error;
      });
    };
    let result;
    try {
      result = await walletFlow.stake(amount, startPreparation);
    } finally {
      // Keep the operation guarded until all parallel work has settled.
      await preparation;
    }
    if (preparationError) throw preparationError;
    if (result === false) return false;
    if (
      view.stake.pendingDeposit &&
      view.stake.depositL1Confirmed &&
      !view.stake.aztecReady
    )
      return initializeAztec();
    return view.stake.aztecReady ? "Stake updated" : "Stake confirmed";
  }
  async function resumeStake(hash?: string, layer?: "l1" | "l2") {
    const result = hash
      ? layer === "l2"
        ? await walletFlow?.recoverClaim(hash)
        : await walletFlow?.recoverDeposit(hash)
      : await walletFlow?.resume();
    if (result === false) return false;
    if (
      view.stake.pendingDeposit &&
      view.stake.depositL1Confirmed &&
      !view.stake.aztecReady
    )
      return initializeAztec();
    return result;
  }
  async function readFeed(
    older: boolean,
    reportProgress = true
  ): Promise<void> {
    return (feedReading ||= loadFeed(older, reportProgress).finally(() => {
      feedReading = undefined;
    }));
  }
  async function loadFeed(older: boolean, reportProgress: boolean) {
    if (!publicNode || !readLayout) throw new Error("Notch is not initialized");
    if (older && (!feedCursor || feedCursor.before === 0)) return;
    if (reportProgress)
      progress(older ? "Loading older posts…" : "Loading recent posts…");
    patch({ feedLoading: true });
    try {
      const result = await readPostPage(
        readRuntime(),
        publicNode,
        deployment.board,
        readLayout,
        older ? feedCursor : undefined
      );
      if (disposed) return;
      feedCursor = result.cursor;
      posts = older ? [...result.posts, ...posts] : result.posts;
      patch({
        posts: posts.map((post) => ({ ...post })),
        feedLoaded: true,
        totalPosts: feedCursor.total,
        hasOlderPosts: feedCursor.before > 0,
        feedRevision: view.feedRevision + (older ? 0 : 1),
        ...(view.actionError?.label === "Load older posts"
          ? { actionError: null }
          : {}),
      });
    } finally {
      patch({ feedLoading: false });
    }
  }
  async function refresh(reportProgress = true) {
    await readFeed(false, reportProgress);
  }
  async function post() {
    const message = view.message;
    encodeDFMessage(message);
    if (!walletFlow || !view.canPost)
      throw new Error("Connect and stake before posting");
    progress("Publishing on Aztec…");
    await walletFlow.post(message);
    if (view.message === message) patch({ message: "" });
    try {
      await refresh(false);
    } catch (error) {
      fail(error, "Refresh posts");
    }
    return "Post published";
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    initialize: initializeOnce,
    log,
    setField: (name, value) => {
      if (name === "message" && !view.busy) patch({ message: value });
    },
    setWalletPanel: (open: boolean) => patch({ walletOpen: open }),
    exportAccount: () => walletFlow?.exportAccount() || null,
    connect: (provider: InjectedProvider) =>
      action(() => connect(provider), "Connect wallet", "connecting"),
    disconnect: () =>
      action(async () => {
        sessionGeneration++;
        const activeStorage = storage();
        if (activeStorage) clearWalletSession(activeStorage, deployment);
        await walletFlow?.disconnect();
        patch({ walletOpen: false });
      }, "Disconnect wallet"),
    selectStakeAmount: (amount: string) => {
      try {
        walletFlow?.selectStakeAmount(amount);
      } catch (error) {
        fail(error, "Select stake amount");
      }
    },
    stake: (amount: string) => action(() => stake(amount), "Stake & set up"),
    continueSetup: () =>
      action(async () => {
        if (!walletFlow) throw new Error("Connect your L1 wallet first");
        if ((await walletFlow.continueSetup()) === false) return false;
        return initializeAztec();
      }, "Continue setup"),
    resumeRequest: (hash?: string, layer?: "l1" | "l2") =>
      action(() => resumeStake(hash, layer), "Stake & set up"),
    initializeAztec: () =>
      action(
        initializeAztec,
        "Initialize Aztec",
        view.stake.setupComplete &&
          !view.stake.pendingDeposit &&
          !view.stake.pendingExit
          ? "restoring"
          : undefined
      ),
    withdrawStake: () =>
      action(async () => {
        await walletFlow?.withdraw();
      }, "Withdraw stake"),
    resumeWithdrawal: (hash?: string) =>
      action(async () => {
        if (!walletFlow) throw new Error("Connect your L1 wallet first");
        const flow = walletFlow;
        if (!view.stake.aztecReady && (await initializeAztec()) === false)
          return false;
        if (walletFlow !== flow || disposed)
          throw new Error("Wallet session ended");
        if (hash) await flow.recoverExit(hash);
        else await flow.resumeExit();
      }, "Complete withdrawal"),
    post: () => action(post, "Anonymous posting", "posting"),
    refresh: () => action(() => refresh(), "Refresh posts"),
    loadOlder: () => action(() => readFeed(true), "Load older posts"),
    dispose: () => {
      disposed = true;
      sessionGeneration++;
      walletFlow?.dispose();
      clearTimeout(progressTimer);
      listeners.clear();
    },
  };
}
