import { BrowserProvider, Contract, JsonRpcProvider } from "ethers";

import {
  type AccountKeys,
  accountSetupOptions,
  createAccountKeys,
  hasAccountKeys,
  readStored,
  writeStored,
} from "./accounts.ts";
import { findMetaMask, switchEthereumChain } from "./l1.ts";
import {
  createRequestSession,
  type PostRequest,
  readRequestReceipt,
  recoverRequest,
  requestABI,
  type RequestConfig,
  requestEnvironment,
  type RequestSDK,
  validateRequestConfig,
  verifyRequestEntry,
} from "./l1-request-core.ts";
import { networkPolicy, waitForInbox } from "./network.ts";
import type { RequestView } from "./request-view";
import { withWalletLock } from "./wallet-lock.ts";

// Keep the orchestration testable without replacing the posting module itself.
const services = {
  findMetaMask,
  switchEthereumChain,
  validateRequestConfig,
  verifyRequestEntry,
  createRequestSession,
  readRequestReceipt,
  recoverRequest,
  rpc: (url: string) =>
    new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }),
  browser: (provider: Awaited<ReturnType<typeof findMetaMask>>) =>
    new BrowserProvider(provider, "any", { cacheTimeout: -1 }),
  entry: (
    address: string,
    signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>
  ) => new Contract(address, requestABI, signer),
};

type Session = Awaited<ReturnType<typeof createRequestSession>>;
type Local = {
  wallet?: Parameters<RequestSDK["Contract"]["at"]>[2];
  address?: Session["owner"];
  pxe?: { stop(): Promise<void> };
};
interface Saved {
  secretKey: string;
  salt: string;
  signingKey: string;
  jobs: PostRequest[];
}

// This account is independent of the payer's EVM keys. Both wallet choices use
// the board from the main deployment, never the old isolated lab manifest.
export function createMetaMaskPosting(
  config: RequestConfig,
  a: RequestSDK,
  emit: (view: RequestView) => void,
  progress: (label: string) => void,
  overrides: Partial<typeof services> = {}
) {
  const api = { ...services, ...overrides };
  let saved: Saved | undefined;
  let session: Session | undefined;
  let injected: Awaited<ReturnType<typeof findMetaMask>> | undefined;
  let payer = "";
  let disposed = false;
  let operating = false;
  const local: Local = {};
  // Keep the recovery prefix stable across SDK upgrades; deployment addresses isolate records.
  const key = `l1-post-lab/6.0.0-rc.3/${config.rollupAddress}/${config.board}`;
  function syncSaved() {
    const latest = readStored<Saved>(localStorage, key);
    if (latest && (!hasAccountKeys(latest) || !Array.isArray(latest.jobs)))
      throw new Error(
        "Invalid saved posting account. Preserve browser data for recovery."
      );
    if (
      saved &&
      (!latest ||
        ["secretKey", "salt", "signingKey"].some(
          (field) =>
            saved![field as keyof AccountKeys] !==
            latest[field as keyof AccountKeys]
        ))
    )
      throw new Error(
        "The saved account changed in another tab. Reload before continuing."
      );
    saved = latest ?? undefined;
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return withWalletLock(key, async () => {
      if (disposed)
        throw new Error("Posting session closed. Reload to continue.");
      operating = true;
      try {
        syncSaved();
        notify();
        return await operation();
      } finally {
        operating = false;
        notify();
      }
    });
  }
  const onStorage = (event: StorageEvent) => {
    if (disposed || operating || (event.key !== key && event.key !== null))
      return;
    try {
      syncSaved();
      notify();
    } catch {
      changed();
      progress("Saved wallet data changed. Reload before continuing.");
    }
  };
  window.addEventListener("storage", onStorage);
  const notify = () => {
    if (disposed) return;
    emit({
      available: true,
      payer,
      // Never publish request secrets or account keys to React snapshots.
      jobs: (saved?.jobs || []).map(
        ({ commitment, text, l1Tx, l2Tx, l2Attempted, postId }) => ({
          commitment,
          text,
          l1Tx,
          l2Tx,
          l2Attempted,
          postId,
        })
      ),
    });
  };
  const persist = () => {
    if (!saved) throw new Error("Recovery data is not ready");
    writeStored(localStorage, key, saved);
    notify();
  };
  const changed = () => {
    payer = "";
    notify();
  };
  const pending = () => saved?.jobs.find((job) => job.postId === undefined);
  const rpc = () => api.rpc(config.l1.rpcUrl);
  const chainId = `0x${config.l1.chainId.toString(16)}`;
  const assertPayer = async () => {
    if (!payer || !injected) throw new Error("Reconnect MetaMask to continue");
    if ((await injected.request({ method: "eth_chainId" })) !== chainId)
      throw new Error(`Switch MetaMask to chain ${config.l1.chainId}`);
    const accounts = (await injected.request({
      method: "eth_accounts",
    })) as string[];
    if (accounts[0]?.toLowerCase() !== payer.toLowerCase())
      throw new Error(
        "Wallet account changed. Reconnect MetaMask to continue."
      );
  };
  async function resume(job: PostRequest) {
    if (!session) throw new Error("Connect MetaMask first");
    await api.validateRequestConfig(a, config);
    const provider = rpc();
    try {
      await api.verifyRequestEntry(config, provider);
      progress("Waiting for L1 request confirmation…");
      if (!(await api.readRequestReceipt(config, job, provider))) {
        await provider.waitForTransaction(job.l1Tx!, 1, 45_000);
        if (!(await api.readRequestReceipt(config, job, provider)))
          throw new Error(
            "L1 is not confirmed yet. Resume later without paying again."
          );
      }
      persist();
      await waitForInbox(
        requestEnvironment(config),
        () => session!.ready(job),
        () =>
          a.createAztecNodeDebugClient(config.nodeUrl).warpL2TimeAtLeastBy(12),
        progress,
        () => disposed
      );
      progress("Publishing on Aztec · L2 fees sponsored…");
      await session.publish(job, persist);
      return job.text;
    } finally {
      provider.destroy();
    }
  }
  const operations = {
    async connect() {
      if (!injected) {
        injected = await api.findMetaMask();
        injected.on?.("accountsChanged", changed);
        injected.on?.("chainChanged", changed);
      }
      payer = "";
      notify();
      const accounts = (await injected.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0]) throw new Error("Wallet access was not authorized");
      await api.switchEthereumChain(
        injected,
        chainId,
        config.l1.rpcUrl,
        requestEnvironment(config)
      );
      const node = await api.validateRequestConfig(a, config);
      const provider = rpc();
      try {
        await api.verifyRequestEntry(config, provider);
      } finally {
        provider.destroy();
      }
      if (!session) {
        // exclusive() already loaded and validated the latest durable state.
        if (!saved) {
          saved = { ...createAccountKeys(a), jobs: [] };
          try {
            persist();
          } catch (error) {
            saved = undefined;
            throw error;
          }
        }
        const globals = window as unknown as {
          RPC_CONFIG: { nodeUrl: string };
          ensureAztecSetup(
            state: Local,
            status: string,
            options: Record<string, unknown>
          ): Promise<boolean>;
        };
        globals.RPC_CONFIG = { nodeUrl: config.nodeUrl };
        progress("Preparing your browser Aztec account…");
        if (
          !(await globals.ensureAztecSetup(local, "log", {
            ...accountSetupOptions(
              a,
              saved,
              `pxe_l1_post_${config.board}_${saved.salt}_`,
              networkPolicy(requestEnvironment(config)).realProofs
            ),
            onProgress: (_step: number, _total: number, message: string) =>
              progress(message),
          })) ||
          !local.wallet ||
          !local.address
        )
          throw new Error("Automatic account initialization failed");
        const [board, sponsor] = await Promise.all(
          ["/df-board-artifact.json", "/df-sponsor-artifact.json"].map(
            async (url) => {
              const response = await fetch(url);
              if (!response.ok) throw new Error("Missing contract artifact");
              return response.json();
            }
          )
        );
        session = await api.createRequestSession(
          a,
          node,
          local.wallet,
          local.address,
          config,
          board,
          sponsor
        );
      }
      const current = (await injected.request({
        method: "eth_accounts",
      })) as string[];
      if (
        (await injected.request({ method: "eth_chainId" })) !== chainId ||
        current[0]?.toLowerCase() !== accounts[0].toLowerCase()
      )
        throw new Error(
          "MetaMask account or network changed during connection. Reconnect."
        );
      payer = current[0];
    },
    async post(text: string) {
      if (!session || !saved || !injected)
        throw new Error("Connect MetaMask first");
      if (pending())
        throw new Error(
          "Resume the existing request before paying for another post"
        );
      await assertPayer();
      await api.validateRequestConfig(a, config);
      const provider = rpc();
      try {
        await api.verifyRequestEntry(config, provider);
        // Reject a depleted sponsor before asking for a paid L1 transaction.
        if (
          (await a.getFeeJuiceBalance(
            a.AztecAddress.fromStringUnsafe(config.sponsoredFpc),
            session.node
          )) <= 0n
        )
          throw new Error(
            "Sponsored FPC has insufficient balance. No L1 payment was requested."
          );
        const browser = api.browser(injected);
        const signer = await browser.getSigner();
        if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
          throw new Error("Wallet account changed. Reconnect MetaMask.");
        const job = await session.create(text);
        const entry = api.entry(config.l1.entry, signer);
        await entry.requestPost.estimateGas(
          config.board,
          job.commitment,
          job.secretHash,
          { value: 0n }
        );
        await assertPayer();
        progress("Confirm in MetaMask · Transfer 0 ETH, pay L1 gas only");
        saved.jobs.unshift(job);
        persist();
        try {
          const tx = await entry.requestPost(
            config.board,
            job.commitment,
            job.secretHash,
            { value: 0n }
          );
          job.l1Tx = tx.hash;
          persist();
        } catch (err) {
          if (
            err &&
            typeof err === "object" &&
            "code" in err &&
            (err.code === "ACTION_REJECTED" || err.code === 4001)
          ) {
            saved.jobs.shift();
            persist();
          }
          throw err;
        }
        return await resume(job);
      } finally {
        provider.destroy();
      }
    },
    async resume(hash?: string) {
      const job = pending();
      if (!job || !session) throw new Error("No connected pending request");
      if (hash) {
        await api.validateRequestConfig(a, config);
        if (job.l2Attempted && !job.l2Tx) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
            throw new Error("Invalid L2 transaction hash");
          const candidate = { ...job, l2Tx: hash };
          if (!(await session.discover(candidate)))
            throw new Error("This transaction is not confirmed yet");
          Object.assign(job, candidate);
          persist();
          return job.text;
        }
        const provider = rpc();
        try {
          await api.verifyRequestEntry(config, provider);
          Object.assign(
            job,
            await api.recoverRequest(config, job, provider, hash)
          );
          persist();
        } finally {
          provider.destroy();
        }
      }
      if (!job.l1Tx)
        throw new Error(
          "Enter the existing L1 transaction hash. Do not pay again."
        );
      return resume(job);
    },
    disconnect() {
      changed();
    },
    dispose() {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      injected?.removeListener?.("accountsChanged", changed);
      injected?.removeListener?.("chainChanged", changed);
      void local.pxe?.stop().catch(() => {});
    },
  };
  return {
    ...operations,
    connect: () => exclusive(() => operations.connect()),
    post: (text: string) => exclusive(() => operations.post(text)),
    resume: (hash?: string) => exclusive(() => operations.resume(hash)),
  };
}
