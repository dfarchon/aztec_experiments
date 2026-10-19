import {
  BrowserProvider,
  Contract,
  formatEther,
  JsonRpcProvider,
} from "ethers";
import { useEffect, useRef, useState } from "react";

import { findMetaMask } from "./l1";
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
} from "./l1-request-core";
import { loadAztecRuntime } from "./runtime-assets";

type Session = Awaited<ReturnType<typeof createRequestSession>>;
type Local = {
  wallet?: Parameters<RequestSDK["Contract"]["at"]>[2];
  address?: Session["owner"];
};
type Globals = Window & {
  __aztec: RequestSDK;
  RPC_CONFIG: { nodeUrl: string };
  ensureAztecSetup(
    state: Local,
    status: string,
    options: Record<string, unknown>
  ): Promise<boolean>;
};
type Job = PostRequest & { l1Attempted?: boolean };
interface Saved {
  secretKey: string;
  salt: string;
  signingKey: string;
  jobs: Job[];
}

// Isolated integration surface. The main board/UI can evolve independently.
export default function L1PostLabPage() {
  const [config, setConfig] = useState<RequestConfig>();
  const [payer, setPayer] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Preparing the local test environment…");
  const [error, setError] = useState("");
  const [text, setText] = useState(
    "Pay only L1 gas. Sponsored FPC covers L2 fees."
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryHash, setRecoveryHash] = useState("");
  const saved = useRef<Saved>();
  const session = useRef<Session>();
  const injected = useRef<Awaited<ReturnType<typeof findMetaMask>>>();
  const local = useRef<Local>({});
  const locked = useRef(false);
  const storageKey = config
    ? `l1-post-lab/6.0.0-rc.3/${config.rollupAddress}/${config.board}`
    : "";
  const persist = () => {
    if (!saved.current || !storageKey)
      throw new Error("Recovery data is not ready");
    localStorage.setItem(storageKey, JSON.stringify(saved.current));
    setJobs(saved.current.jobs.map((job) => ({ ...job })));
  };
  const action = async (fn: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(
        (err instanceof Error ? err.message : String(err))
          .split("Context:")[0]
          .slice(0, 1000)
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      const response = await fetch("/df-l1-post-lab.json");
      if (!response.ok)
        throw new Error("Deploy the L1 posting test contracts first");
      const config = (await response.json()) as RequestConfig;
      await loadAztecRuntime();
      await validateRequestConfig(
        (window as unknown as Globals).__aztec,
        config
      );
      if (active) {
        setConfig(config);
        setStatus("Connect MetaMask to post. No deposit required.");
      }
    })().catch((err) => {
      if (active) setError(String(err));
    });
    return () => {
      active = false;
    };
  }, []);
  const connect = () =>
    action(async () => {
      if (!config) return;
      injected.current ||= await findMetaMask();
      const accounts = (await injected.current.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0]) throw new Error("Wallet access was not authorized");
      if (
        (await injected.current.request({ method: "eth_chainId" })) !== "0x7a69"
      )
        await injected.current.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x7a69" }],
        });
      setPayer(accounts[0]);
      if (session.current) return;
      const globals = window as unknown as Globals;
      const a = globals.__aztec;
      const node = await validateRequestConfig(a, config);
      const existing = localStorage.getItem(storageKey);
      saved.current = existing
        ? (JSON.parse(existing) as Saved)
        : {
            secretKey: a.Fr.random().toString(),
            salt: a.Fr.random().toString(),
            signingKey: a.Fq.random().toString(),
            jobs: [],
          };
      persist();
      globals.RPC_CONFIG = { nodeUrl: config.nodeUrl };
      globals.log = () => undefined;
      if (
        !(await globals.ensureAztecSetup(local.current, "l1-post-lab-log", {
          secretKey: saved.current.secretKey,
          salt: saved.current.salt,
          signingKey: a.Fq.fromString(saved.current.signingKey),
          proverEnabled: false,
          blockMonitor: false,
          dataDirPrefix: `pxe_l1_post_${config.board}_${saved.current.salt}_`,
          onProgress: (_step: number, _total: number, message: string) =>
            setStatus(message),
        })) ||
        !local.current.wallet ||
        !local.current.address
      )
        throw new Error("Automatic account initialization failed");
      const [board, sponsor] = await Promise.all(
        ["/df-l1-post-artifact.json", "/df-sponsor-artifact.json"].map(
          async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Missing contract artifact");
            return response.json();
          }
        )
      );
      session.current = await createRequestSession(
        a,
        node,
        local.current.wallet,
        local.current.address,
        config,
        board,
        sponsor
      );
      setReady(true);
      setStatus("Connected. MetaMask pays only L1 gas for each post.");
    });
  const resume = async (job: Job) => {
    if (!config || !session.current)
      throw new Error("Connect your wallet first");
    const a = (window as unknown as Globals).__aztec;
    await validateRequestConfig(a, config);
    const rpc = new JsonRpcProvider(config.l1.rpcUrl, undefined, {
      cacheTimeout: -1,
    });
    try {
      await verifyRequestEntry(config, rpc);
      setStatus("Waiting for L1 request confirmation…");
      if (!(await readRequestReceipt(config, job, rpc))) {
        await rpc.waitForTransaction(job.l1Tx!, 1, 45_000);
        if (!(await readRequestReceipt(config, job, rpc)))
          throw new Error("L1 is not confirmed yet. Resume later.");
      }
      persist();
      // The debug time advance exists only in this guarded local prototype.
      // Public-network clients must wait for real checkpoint inclusion.
      const debug = a.createAztecNodeDebugClient(config.nodeUrl);
      for (let i = 0; i < 20 && !(await session.current.ready(job)); i++) {
        setStatus(`Waiting for the request to reach Aztec · ${i + 1}/20`);
        await debug.warpL2TimeAtLeastBy(12);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStatus("Publishing on L2 with Sponsored FPC…");
      await session.current.publish(job, persist);
      setStatus(`Published #${job.postId}. Content read back from the chain.`);
    } finally {
      rpc.destroy();
    }
  };
  const publish = () =>
    action(async () => {
      if (!config || !session.current || !saved.current || !injected.current)
        throw new Error("Connect your wallet first");
      if (saved.current.jobs.some((job) => job.postId === undefined))
        throw new Error(
          "Finish the existing request first to avoid paying twice"
        );
      await validateRequestConfig(
        (window as unknown as Globals).__aztec,
        config
      );
      if (
        (await injected.current.request({ method: "eth_chainId" })) !== "0x7a69"
      )
        throw new Error("Switch to local Anvil (31337)");
      const rpc = new JsonRpcProvider(config.l1.rpcUrl, undefined, {
        cacheTimeout: -1,
      });
      try {
        await verifyRequestEntry(config, rpc);
        const browser = new BrowserProvider(injected.current, "any", {
          cacheTimeout: -1,
        });
        const signer = await browser.getSigner();
        if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
          throw new Error("Wallet account changed. Reconnect to continue.");
        const job: Job = await session.current.create(text);
        const entry = new Contract(config.l1.entry, requestABI, signer);
        const gas = await entry.requestPost.estimateGas(
          config.board,
          job.commitment,
          job.secretHash,
          { value: 0n }
        );
        const fees = await rpc.getFeeData();
        setStatus(
          `Awaiting MetaMask: transfer 0 ETH, estimated L1 gas ${formatEther(gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n))} test ETH`
        );
        job.l1Attempted = true;
        saved.current.jobs.unshift(job);
        persist(); // Save secrets BEFORE asking MetaMask to broadcast.
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
            saved.current.jobs.shift();
            persist();
          }
          throw err;
        }
        await resume(job);
      } finally {
        rpc.destroy();
      }
    });
  const pending = jobs.find((job) => job.postId === undefined);
  return (
    <main className="shell l1-post-lab">
      <header>
        <a href="/">← Billboard</a>
        <h1>Post with MetaMask</h1>
      </header>
      <p>
        Local Anvil · Transfer 0 ETH · You pay L1 gas · Sponsored FPC pays L2
        gas
      </p>
      <button disabled={!config || busy} onClick={() => void connect()}>
        {payer ? "Reconnect" : "Connect MetaMask"}
      </button>
      {payer && <p>Payer address: {payer}</p>}
      <section>
        <label htmlFor="l1-post-text">Post text (up to 512 UTF-8 bytes)</label>
        <textarea
          id="l1-post-text"
          rows={4}
          value={text}
          disabled={busy || Boolean(pending)}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          disabled={!ready || busy || Boolean(pending)}
          onClick={() => void publish()}
        >
          Confirm & publish
        </button>
        {pending?.l1Tx && (
          <button
            disabled={!ready || busy}
            onClick={() =>
              void action(async () => {
                const job = saved.current?.jobs.find(
                  (item) => item.commitment === pending.commitment
                );
                if (job) await resume(job);
              })
            }
          >
            Resume request (no additional payment)
          </button>
        )}
        {pending && !pending.l1Tx && (
          <div>
            <p>
              Payment status unknown. Copy the transaction hash from MetaMask to
              recover. Do not pay again.
            </p>
            <input
              aria-label="L1 transaction hash"
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value)}
            />
            <button
              disabled={busy || !ready}
              onClick={() =>
                void action(async () => {
                  const job = saved.current?.jobs.find(
                    (item) => item.commitment === pending.commitment
                  );
                  if (!job || !config) return;
                  const rpc = new JsonRpcProvider(config.l1.rpcUrl);
                  try {
                    await verifyRequestEntry(config, rpc);
                    const candidate = await recoverRequest(
                      config,
                      job,
                      rpc,
                      recoveryHash
                    );
                    Object.assign(job, candidate);
                    persist();
                  } finally {
                    rpc.destroy();
                  }
                  await resume(job);
                })
              }
            >
              Recover transaction
            </button>
          </div>
        )}
        {pending?.l2Attempted && !pending.l2Tx && (
          <div>
            <p>
              L2 submission status unknown. Use the transaction hash to recover.
              No additional L1 payment is needed.
            </p>
            <input
              aria-label="L2 transaction hash"
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value)}
            />
            <button
              disabled={busy || !ready}
              onClick={() =>
                void action(async () => {
                  if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))
                    throw new Error("Invalid transaction hash format");
                  const job = saved.current?.jobs.find(
                    (item) => item.commitment === pending.commitment
                  );
                  if (!job || !session.current) return;
                  const candidate = { ...job, l2Tx: recoveryHash };
                  if (!(await session.current.discover(candidate)))
                    throw new Error("This transaction is not confirmed yet");
                  Object.assign(job, candidate);
                  persist();
                  setStatus(
                    `Published #${job.postId}. Onchain content verified.`
                  );
                })
              }
            >
              Verify L2 transaction
            </button>
          </div>
        )}
        <p role="status">{status}</p>
        {error && <p role="alert">{error}</p>}
      </section>
      <section>
        <h2>Publishing activity in this browser</h2>
        {jobs.map((job) => (
          <article key={job.commitment}>
            <p>
              {job.postId === undefined ? "Processing" : `#${job.postId}`} ·{" "}
              {job.text}
            </p>
            <details>
              <summary>Transaction details</summary>
              <p>L1: {job.l1Tx || "Awaiting confirmation"}</p>
              <p>L2: {job.l2Tx || "Awaiting publication"}</p>
            </details>
          </article>
        ))}
      </section>
      <details>
        <summary>Local test details</summary>
        <p>
          Uses simulated proofs. Browser test keys are stored unencrypted. The
          L1 payer address is public; posts are published on Aztec.
        </p>
        <p>Billboard: {config?.board}</p>
        <p>L1 request contract: {config?.l1.entry}</p>
        <p>Sponsored FPC：{config?.sponsoredFpc}</p>
      </details>
    </main>
  );
}
