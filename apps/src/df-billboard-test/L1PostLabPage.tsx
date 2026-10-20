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
  const [status, setStatus] = useState("准备本地验证环境…");
  const [error, setError] = useState("");
  const [text, setText] = useState("L1 只付 gas，L2 由 Sponsored FPC 代付。");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recoveryHash, setRecoveryHash] = useState("");
  const saved = useRef<Saved>();
  const session = useRef<Session>();
  const injected = useRef<Awaited<ReturnType<typeof findMetaMask>>>();
  const local = useRef<Local>({});
  const locked = useRef(false);
  const storageKey = config
    ? `l1-post-lab/5.0.1/${config.rollupAddress}/${config.board}`
    : "";
  const persist = () => {
    if (!saved.current || !storageKey) throw new Error("恢复数据未就绪");
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
      if (!response.ok) throw new Error("请先部署 L1 发帖验证合约");
      const config = (await response.json()) as RequestConfig;
      await loadAztecRuntime();
      await validateRequestConfig(
        (window as unknown as Globals).__aztec,
        config
      );
      if (active) {
        setConfig(config);
        setStatus("连接 MetaMask 后即可发布，无需充值");
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
      if (!accounts[0]) throw new Error("钱包未授权");
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
          dataDirPrefix: `pxe_l1_post_${config.board}_${saved.current.salt}_`,
          onProgress: (_step: number, _total: number, message: string) =>
            setStatus(message),
        })) ||
        !local.current.wallet ||
        !local.current.address
      )
        throw new Error("自动账号初始化失败");
      const [board, sponsor] = await Promise.all(
        ["/df-l1-post-artifact.json", "/df-sponsor-artifact.json"].map(
          async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("合约产物缺失");
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
      setStatus("已连接；每帖仅由 MetaMask 支付 L1 gas");
    });
  const resume = async (job: Job) => {
    if (!config || !session.current) throw new Error("请先连接钱包");
    const a = (window as unknown as Globals).__aztec;
    await validateRequestConfig(a, config);
    const rpc = new JsonRpcProvider(config.l1.rpcUrl, undefined, {
      cacheTimeout: -1,
    });
    try {
      await verifyRequestEntry(config, rpc);
      setStatus("等待 L1 请求确认…");
      if (!(await readRequestReceipt(config, job, rpc))) {
        await rpc.waitForTransaction(job.l1Tx!, 1, 45_000);
        if (!(await readRequestReceipt(config, job, rpc)))
          throw new Error("L1 尚未确认，可稍后继续");
      }
      persist();
      // The debug time advance exists only in this guarded local prototype.
      // Public-network clients must wait for real checkpoint inclusion.
      const debug = a.createAztecNodeDebugClient(config.nodeUrl);
      for (let i = 0; i < 20 && !(await session.current.ready(job)); i++) {
        setStatus(`等待请求进入 Aztec · ${i + 1}/20`);
        await debug.warpL2TimeAtLeastBy(12);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStatus("Sponsored FPC 代付 L2，正在发布…");
      await session.current.publish(job, persist);
      setStatus(`发布成功 #${job.postId}；已从链上读回正文`);
    } finally {
      rpc.destroy();
    }
  };
  const publish = () =>
    action(async () => {
      if (!config || !session.current || !saved.current || !injected.current)
        throw new Error("请先连接钱包");
      if (saved.current.jobs.some((job) => job.postId === undefined))
        throw new Error("请先完成已有请求，避免重复支付");
      await validateRequestConfig(
        (window as unknown as Globals).__aztec,
        config
      );
      if (
        (await injected.current.request({ method: "eth_chainId" })) !== "0x7a69"
      )
        throw new Error("请切到本地 Anvil 31337");
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
          throw new Error("钱包账号改变，请重新连接");
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
          `等待 MetaMask：转账 0 ETH，预计 L1 gas ${formatEther(gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n))} 测试 ETH`
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
        <a href="/">← 留言板</a>
        <h1>MetaMask 按帖发布</h1>
      </header>
      <p>本地 Anvil · 转账 0 ETH · 用户付 L1 gas · Sponsored FPC 付 L2 gas</p>
      <button disabled={!config || busy} onClick={() => void connect()}>
        {payer ? "重新连接" : "连接 MetaMask"}
      </button>
      {payer && <p>付款地址：{payer}</p>}
      <section>
        <label htmlFor="l1-post-text">帖子正文（最多 512 UTF-8 字节）</label>
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
          确认并发布
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
            继续已有请求（不重复付款）
          </button>
        )}
        {pending && !pending.l1Tx && (
          <div>
            <p>付款结果未知。请从 MetaMask 复制交易哈希恢复，勿重复支付。</p>
            <input
              aria-label="L1 交易哈希"
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
              恢复交易
            </button>
          </div>
        )}
        {pending?.l2Attempted && !pending.l2Tx && (
          <div>
            <p>
              L2 提交结果未知。可用链上交易哈希核对恢复，不需要再次支付 L1。
            </p>
            <input
              aria-label="L2 交易哈希"
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value)}
            />
            <button
              disabled={busy || !ready}
              onClick={() =>
                void action(async () => {
                  if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))
                    throw new Error("交易哈希格式不正确");
                  const job = saved.current?.jobs.find(
                    (item) => item.commitment === pending.commitment
                  );
                  if (!job || !session.current) return;
                  const candidate = { ...job, l2Tx: recoveryHash };
                  if (!(await session.current.discover(candidate)))
                    throw new Error("该交易尚未确认");
                  Object.assign(job, candidate);
                  persist();
                  setStatus(`发布成功 #${job.postId}；已核对链上正文`);
                })
              }
            >
              核对 L2 交易
            </button>
          </div>
        )}
        <p role="status">{status}</p>
        {error && <p role="alert">{error}</p>}
      </section>
      <section>
        <h2>本浏览器的发布记录</h2>
        {jobs.map((job) => (
          <article key={job.commitment}>
            <p>
              {job.postId === undefined ? "处理中" : `#${job.postId}`} ·{" "}
              {job.text}
            </p>
            <details>
              <summary>交易详情</summary>
              <p>L1：{job.l1Tx || "等待确认"}</p>
              <p>L2：{job.l2Tx || "等待发布"}</p>
            </details>
          </article>
        ))}
      </section>
      <details>
        <summary>本地验证信息</summary>
        <p>
          使用模拟证明；浏览器测试密钥未加密保存。L1 付款地址公开，帖子在 Aztec
          发布。
        </p>
        <p>留言板：{config?.board}</p>
        <p>L1 请求合约：{config?.l1.entry}</p>
        <p>Sponsored FPC：{config?.sponsoredFpc}</p>
      </details>
    </main>
  );
}
