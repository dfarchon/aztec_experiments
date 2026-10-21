import { BrowserProvider, Contract, JsonRpcProvider } from "ethers";

import { findMetaMask, switchLocalEthereumChain } from "./l1.ts";
import {
  createRequestSession,
  type PostRequest,
  readRequestReceipt,
  recoverRequest,
  requestABI,
  type RequestConfig,
  type RequestSDK,
  validateRequestConfig,
  verifyRequestEntry,
} from "./l1-request-core.ts";

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
export type RequestJobView = Pick<
  PostRequest,
  "commitment" | "text" | "l1Tx" | "l2Tx" | "l2Attempted" | "postId"
>;
export interface RequestView {
  available: boolean;
  payer: string;
  jobs: RequestJobView[];
}
export const emptyRequestView: RequestView = {
  available: false,
  payer: "",
  jobs: [],
};

// This account is independent of the payer's EVM keys. Both wallet choices use
// the board from the main deployment, never the old isolated lab manifest.
export function createMetaMaskPosting(
  config: RequestConfig,
  a: RequestSDK,
  emit: (view: RequestView) => void,
  progress: (label: string) => void
) {
  let saved: Saved | undefined;
  let session: Session | undefined;
  let injected: Awaited<ReturnType<typeof findMetaMask>> | undefined;
  let payer = "";
  let disposed = false;
  const local: Local = {};
  const key = `l1-post-lab/6.0.0-rc.3/${config.rollupAddress}/${config.board}`;
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
    localStorage.setItem(key, JSON.stringify(saved));
    notify();
  };
  const changed = () => {
    payer = "";
    notify();
  };
  const pending = () => saved?.jobs.find((job) => job.postId === undefined);
  const rpc = () =>
    new JsonRpcProvider(config.l1.rpcUrl, undefined, { cacheTimeout: -1 });
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
    await validateRequestConfig(a, config);
    const provider = rpc();
    try {
      await verifyRequestEntry(config, provider);
      progress("Waiting for L1 request confirmation…");
      if (!(await readRequestReceipt(config, job, provider))) {
        await provider.waitForTransaction(job.l1Tx!, 1, 45_000);
        if (!(await readRequestReceipt(config, job, provider)))
          throw new Error(
            "L1 is not confirmed yet. Resume later without paying again."
          );
      }
      persist();
      // Only permitted after validateRequestConfig confirms a local synthetic chain.
      const debug = a.createAztecNodeDebugClient(config.nodeUrl);
      for (let i = 0; i < 20 && !(await session.ready(job)); i++) {
        progress(`Waiting for the request to reach Aztec · ${i + 1}/20`);
        await debug.warpL2TimeAtLeastBy(12);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      progress("Publishing on Aztec · L2 fees sponsored…");
      await session.publish(job, persist);
      return job.text;
    } finally {
      provider.destroy();
    }
  }
  return {
    async connect() {
      if (!injected) {
        injected = await findMetaMask();
        injected.on?.("accountsChanged", changed);
        injected.on?.("chainChanged", changed);
      }
      payer = "";
      notify();
      const accounts = (await injected.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0]) throw new Error("Wallet access was not authorized");
      await switchLocalEthereumChain(injected, chainId, config.l1.rpcUrl);
      const node = await validateRequestConfig(a, config);
      const provider = rpc();
      try {
        await verifyRequestEntry(config, provider);
      } finally {
        provider.destroy();
      }
      if (!session) {
        const existing = localStorage.getItem(key);
        saved = existing
          ? (JSON.parse(existing) as Saved)
          : {
              secretKey: a.Fr.random().toString(),
              salt: a.Fr.random().toString(),
              signingKey: a.Fq.random().toString(),
              jobs: [],
            };
        if (
          !saved ||
          !Array.isArray(saved.jobs) ||
          ![saved.secretKey, saved.salt, saved.signingKey].every(
            (value) => typeof value === "string" && value
          )
        )
          throw new Error(
            "Invalid saved MetaMask posting account. Preserve browser data for recovery."
          );
        persist();
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
            secretKey: saved.secretKey,
            salt: saved.salt,
            signingKey: a.Fq.fromString(saved.signingKey),
            proverEnabled: false,
            blockMonitor: false,
            dataDirPrefix: `pxe_l1_post_${config.board}_${saved.salt}_`,
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
        session = await createRequestSession(
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
      notify();
    },
    async post(text: string) {
      if (!session || !saved || !injected)
        throw new Error("Connect MetaMask first");
      if (pending())
        throw new Error(
          "Resume the existing request before paying for another post"
        );
      await assertPayer();
      await validateRequestConfig(a, config);
      const provider = rpc();
      try {
        await verifyRequestEntry(config, provider);
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
        const browser = new BrowserProvider(injected, "any", {
          cacheTimeout: -1,
        });
        const signer = await browser.getSigner();
        if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
          throw new Error("Wallet account changed. Reconnect MetaMask.");
        const job = await session.create(text);
        const entry = new Contract(config.l1.entry, requestABI, signer);
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
      await validateRequestConfig(a, config);
      if (hash) {
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
          await verifyRequestEntry(config, provider);
          Object.assign(job, await recoverRequest(config, job, provider, hash));
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
      injected?.removeListener?.("accountsChanged", changed);
      injected?.removeListener?.("chainChanged", changed);
      void local.pxe?.stop().catch(() => {});
    },
  };
}
