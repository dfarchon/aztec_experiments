// @ts-nocheck -- Aztec wallet methods are loaded dynamically after the public feed.
import { encodeDFMessage } from "../../../shared/df-billboard.mjs";
import { createFeedReader } from "./feed-reader.ts";
import { environment, validateChain, validateRpc } from "./network.ts";
import {
  fetchPublicJson,
  loadReadLayout,
  publicReadSDK,
} from "./public-reader.ts";
import { loadAztecRuntime } from "./runtime-assets.ts";
import type { BillboardController } from "./types";

export function createBillboardController(deps = {}): BillboardController {
  const A = deps.sdk || (() => window.__aztec);
  const R = deps.readSdk || deps.sdk || (() => publicReadSDK);
  const listeners = new Set();
  const readPostPage = deps.readPostPage || createFeedReader();
  let disposed = false;
  let busy = false;
  let initializing;
  let walletRuntime;
  let deployment, publicNode, readLayout, feedCursor, feedReading, stakePosting;
  let progressTimer;
  let logId = 0;
  let posts = [];
  let view = {
    busy: false,
    connecting: false,
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
      amount: "0",
      pendingDeposit: false,
      depositPrepared: false,
      depositNeedsHash: false,
      claimNeedsHash: false,
      pendingExit: false,
      exitNeedsHash: false,
      backedUp: false,
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
  function patch(changes) {
    if (disposed) return;
    view = { ...view, ...changes };
    listeners.forEach((listener) => listener());
  }
  function log(message, type = "info") {
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
  function publishStake(stake) {
    const connected = Boolean(stake.payer && stake.owner);
    patch({
      stake,
      connected,
      canPost:
        connected &&
        BigInt(stake.amount) > 0n &&
        !stake.pendingDeposit &&
        !stake.pendingExit,
    });
  }
  function progress(label) {
    clearTimeout(progressTimer);
    patch({ progress: { label, completed: false, failed: false } });
  }
  function finish(label, success, completedLabel) {
    clearTimeout(progressTimer);
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
  function fail(error, label) {
    const message = error?.message || String(error);
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
  async function action(fn, label, field) {
    if (busy) return;
    busy = true;
    patch({
      busy: true,
      connecting: field === "connecting",
      posting: field === "posting",
      ...(view.actionError?.label === label ? { actionError: null } : {}),
    });
    progress(`${label}…`);
    let success = false;
    let completedLabel;
    try {
      completedLabel = await fn();
      success = true;
    } catch (error) {
      fail(error, label);
    } finally {
      busy = false;
      patch({ busy: false, connecting: false, posting: false });
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
  async function initialize() {
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
    patch({ deployment });
    publicNode = R().createAztecNodeClient(deployment.nodeUrl);
    const address = R().AztecAddress.fromStringUnsafe(deployment.board);
    const checks = await Promise.allSettled([
      checkChain(),
      (deps.loadReadLayout || loadReadLayout)(deployment.boardArtifactHash),
      publicNode.getContract(address),
    ]);
    for (const result of checks)
      if (result.status === "rejected") throw result.reason;
    const [, layout, instance] = checks.map((result) => result.value);
    if (
      !instance ||
      instance.currentContractClassId.toString() !== deployment.boardClassId
    )
      throw new Error("Board class does not match the deployment");
    readLayout = layout;
    patch({
      canRead: true,
      stake: { ...view.stake, available: true },
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
    await initializeOnce();
    return (walletRuntime ||= (
      deps.loadWalletRuntime || loadAztecRuntime
    )().catch((error) => {
      walletRuntime = undefined;
      throw error;
    }));
  }
  async function connect(provider) {
    await prepareWallet();
    await checkChain();
    if (!stakePosting)
      stakePosting = (
        deps.createStakePosting ||
        (await import("./stake-posting.ts")).createStakePosting
      )(deployment, A(), publishStake, progress);
    await stakePosting.connect(provider);
    patch({ walletOpen: true });
  }
  async function readFeed(older, reportProgress = true) {
    return (feedReading ||= loadFeed(older, reportProgress).finally(() => {
      feedReading = null;
    }));
  }
  async function loadFeed(older, reportProgress) {
    if (!publicNode || !readLayout) throw new Error("Notch is not initialized");
    if (older && (!feedCursor || feedCursor.before === 0)) return;
    if (reportProgress)
      progress(older ? "Loading older posts…" : "Loading recent posts…");
    patch({ feedLoading: true });
    try {
      const result = await readPostPage(
        R(),
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
    if (!stakePosting || !view.canPost)
      throw new Error("Connect and stake before posting");
    progress("Publishing on Aztec…");
    await stakePosting.post(message);
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
      if (name === "message" && !busy) patch({ message: value });
    },
    setWalletPanel: (open) => patch({ walletOpen: open }),
    accountBackup: () => stakePosting?.backup() || null,
    connect: (provider) =>
      action(() => connect(provider), "Connect wallet", "connecting"),
    disconnect: () =>
      action(async () => {
        await stakePosting?.disconnect();
        patch({ walletOpen: true });
      }, "Switch wallet"),
    deposit: (amount) =>
      action(async () => {
        await stakePosting?.deposit(amount);
        return "Save recovery before staking";
      }, "Prepare stake"),
    resumeRequest: (hash, layer) =>
      action(
        () =>
          hash
            ? layer === "l2"
              ? stakePosting?.recoverClaim(hash)
              : stakePosting?.recoverDeposit(hash)
            : stakePosting?.resume(),
        "Resume deposit"
      ),
    withdrawStake: () =>
      action(() => stakePosting?.withdraw(), "Withdraw stake"),
    resumeWithdrawal: (hash) =>
      action(
        () =>
          hash ? stakePosting?.recoverExit(hash) : stakePosting?.resumeExit(),
        "Complete withdrawal"
      ),
    importStakeBackup: (file) =>
      action(() => stakePosting?.restore(file), "Restore account"),
    post: () => action(post, "Anonymous posting", "posting"),
    refresh: () => action(() => refresh(), "Refresh posts"),
    loadOlder: () => action(() => readFeed(true), "Load older posts"),
    dispose: () => {
      disposed = true;
      stakePosting?.dispose();
      clearTimeout(progressTimer);
      listeners.clear();
    },
  };
}
