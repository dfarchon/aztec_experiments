import {
  BrowserProvider,
  Contract,
  type Eip1193Provider,
  formatEther,
  hexlify,
  Interface,
  JsonRpcProvider,
  keccak256,
  parseEther,
  sha256,
  solidityPacked,
  toUtf8Bytes,
} from "ethers";

export type L1Stage =
  | "waiting-proof"
  | "ready"
  | "signing"
  | "confirming"
  | "published";
export interface L1Job {
  l2Tx: string;
  text: string;
  stage: L1Stage;
  postId?: string;
  l1Tx?: string;
  gas?: string;
  fee?: string;
  error?: string;
}
export interface L1View {
  available: boolean;
  address: string;
  busy: boolean;
  error: string;
  jobs: L1Job[];
}
export const emptyL1View: L1View = {
  available: false,
  address: "",
  busy: false,
  error: "",
  jobs: [],
};
export type L1Proof = [number, number, bigint, string[]];
export interface L1Ports {
  discover(tx: string): Promise<{ id: string; leaf: string; index: number }>;
  witness(tx: string, leaf: string, index: number): Promise<L1Proof | null>;
  validate(): Promise<void>;
  checkPublished(job: L1Job): Promise<boolean>;
  checkReceipt(hash: string): Promise<"pending" | "success" | "reverted">;
  estimate(job: L1Job, proof: L1Proof): Promise<{ gas: string; fee: string }>;
  connect(): Promise<string>;
  send(job: L1Job, proof: L1Proof, address: string): Promise<string>;
  prove(): Promise<void>;
  faucet(address: string): Promise<void>;
  stop?(): void;
}

// Only public text, source IDs and transaction hashes are persisted, scoped to
// rollup + board + recipient. Refreshing never resubmits the L2 transaction.
export function createL1Queue(
  ports: L1Ports,
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  emit: (view: L1View) => void
) {
  const view: L1View = { ...emptyL1View, available: true, jobs: [] };
  let disposed = false;
  const checking = new Set<string>();
  const generations = new Map<string, number>();
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const notify = () => {
    if (!disposed)
      emit({ ...view, jobs: view.jobs.map((job) => ({ ...job })) });
  };
  const save = () => {
    try {
      storage.setItem(
        key,
        JSON.stringify(
          view.jobs.map(({ l2Tx, text, postId, l1Tx }) => ({
            l2Tx,
            text,
            postId,
            l1Tx,
          }))
        )
      );
    } catch {
      view.error = "无法保存 L1 进度；请保留交易哈希，勿关闭页面。";
    }
    notify();
  };
  const update = (job: L1Job, patch: Partial<L1Job>) => {
    Object.assign(job, patch);
    save();
  };
  const check = async (job: L1Job) => {
    if (
      disposed ||
      checking.has(job.l2Tx) ||
      job.stage === "signing" ||
      job.stage === "published"
    )
      return;
    checking.add(job.l2Tx);
    const generation = generations.get(job.l2Tx) || 0;
    const apply = (patch: Partial<L1Job>) => {
      if (!disposed && generation === (generations.get(job.l2Tx) || 0))
        update(job, patch);
    };
    try {
      if (job.postId && (await ports.checkPublished(job))) {
        apply({ stage: "published", error: undefined });
        return;
      }
      if (job.l1Tx) {
        const status = await ports.checkReceipt(job.l1Tx);
        if (status === "pending") {
          apply({ stage: "confirming", error: undefined });
          return;
        }
        if (status === "reverted") {
          apply({
            l1Tx: undefined,
            stage: "ready",
            error: "L1 交易回退；可重试，无需重新发帖。",
          });
          return;
        }
        if (!(await ports.checkPublished(job)))
          throw new Error("L1 回执成功但未找到匹配正文，请核对合约。");
        apply({ stage: "published", error: undefined });
        return;
      }
      const event = await ports.discover(job.l2Tx);
      apply({ postId: event.id });
      const proof = await ports.witness(job.l2Tx, event.leaf, event.index);
      if (!proof) {
        apply({ stage: "waiting-proof", error: undefined });
        return;
      }
      const estimate = await ports.estimate(job, proof);
      apply({ ...estimate, stage: "ready", error: undefined });
    } catch (error) {
      apply({ error: message(error) });
    } finally {
      checking.delete(job.l2Tx);
    }
  };
  const refresh = () => Promise.all(view.jobs.map(check)).then(() => undefined);
  const walletAction = async (fn: () => Promise<void>) => {
    if (view.busy) return;
    view.busy = true;
    view.error = "";
    notify();
    try {
      await fn();
    } catch (error) {
      view.error = message(error);
    } finally {
      view.busy = false;
      notify();
    }
  };
  return {
    snapshot: () => view,
    async initialize() {
      await ports.validate();
      try {
        const jobs: unknown = JSON.parse(storage.getItem(key) || "[]");
        if (Array.isArray(jobs))
          view.jobs = jobs
            .filter(
              (job): job is L1Job =>
                job &&
                typeof job.l2Tx === "string" &&
                /^0x[\da-f]{64}$/i.test(job.l2Tx) &&
                typeof job.text === "string" &&
                toUtf8Bytes(job.text).length > 0 &&
                toUtf8Bytes(job.text).length <= 512
            )
            .map((job) => ({
              l2Tx: job.l2Tx,
              text: job.text,
              postId: job.postId,
              l1Tx: job.l1Tx,
              stage: job.l1Tx ? "confirming" : "waiting-proof",
            }));
      } catch {
        view.error = "保存的 L1 记录无效，请保留交易哈希以便恢复。";
      }
      notify();
      await refresh();
    },
    add(l2Tx: string, text: string) {
      if (view.jobs.some((job) => job.l2Tx === l2Tx)) return;
      const job: L1Job = { l2Tx, text, stage: "waiting-proof" };
      view.jobs.unshift(job);
      save();
      void check(job);
    },
    refresh,
    connect: () =>
      walletAction(async () => {
        view.address = await ports.connect();
      }),
    disconnect() {
      view.address = "";
      view.error = "MetaMask 账号或网络已变化，请重新连接。";
      notify();
    },
    prove: () =>
      walletAction(async () => {
        await ports.prove();
        await refresh();
      }),
    faucet: () =>
      walletAction(async () => {
        if (!view.address) throw new Error("请先连接 MetaMask");
        await ports.faucet(view.address);
      }),
    publish: (tx: string) =>
      walletAction(async () => {
        const job = view.jobs.find((entry) => entry.l2Tx === tx);
        if (!job || job.stage !== "ready" || job.l1Tx) return;
        if (!view.address) throw new Error("请先连接 MetaMask");
        generations.set(job.l2Tx, (generations.get(job.l2Tx) || 0) + 1);
        try {
          await ports.validate();
          if (await ports.checkPublished(job)) {
            update(job, { stage: "published", error: undefined });
            return;
          }
          const event = await ports.discover(job.l2Tx);
          const proof = await ports.witness(job.l2Tx, event.leaf, event.index);
          if (!proof) {
            update(job, { stage: "waiting-proof" });
            return;
          }
          update(job, { stage: "signing", error: undefined });
          const hash = await ports.send(job, proof, view.address);
          // Persist before waiting so reload/rejection cannot duplicate the L2 post.
          update(job, { l1Tx: hash, stage: "confirming" });
          await check(job);
        } catch (error) {
          update(job, {
            stage: job.l1Tx ? "confirming" : "ready",
            error: message(error),
          });
        }
      }),
    dispose() {
      disposed = true;
      ports.stop?.();
    },
  };
}

export interface L1Deployment {
  board: string;
  rollupVersion: string;
  l1: {
    rpcUrl: string;
    chainId: number;
    publisher: string;
    runtimeCodeHash: string;
  };
}
type Injected = Eip1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  providers?: Injected[];
  on?(event: string, callback: () => void): void;
  removeListener?(event: string, callback: () => void): void;
};
export async function findMetaMask(): Promise<Injected> {
  const provider = await new Promise<Injected | undefined>((resolve) => {
    const found: Injected[] = [];
    const announce = (event: Event) => {
      const detail = (
        event as CustomEvent<{ info: { rdns: string }; provider: Injected }>
      ).detail;
      if (detail?.info.rdns === "io.metamask") found.push(detail.provider);
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", announce);
      const injected = (window as Window & { ethereum?: Injected }).ethereum;
      resolve(
        found[0] ||
          (injected?.providers || [injected]).find(
            (item) => item?.isMetaMask && !item.isRabby
          )
      );
    }, 200);
  });
  if (!provider)
    throw new Error(
      "此浏览器未发现 MetaMask，请在已安装扩展的浏览器打开本站。"
    );
  return provider;
}

const ABI = [
  "function L2_BOARD() view returns(bytes32)",
  "function ROLLUP_VERSION() view returns(uint256)",
  "function isPublished(uint32) view returns(bool)",
  "function getPost(uint32) view returns(bytes)",
  "function publish(uint32,bytes,uint256,uint256,uint256,bytes32[])",
];
// Browser writes always go through the selected MetaMask provider, never an
// unlocked Anvil signer or a private key stored by the application.
export function createL1Ports(
  deployment: L1Deployment,
  bridge: Pick<L1Ports, "discover" | "witness" | "prove">,
  changed: () => void
): L1Ports {
  const config = deployment.l1;
  if (
    config.chainId !== 31337 ||
    !["localhost", "127.0.0.1"].includes(new URL(config.rpcUrl).hostname)
  )
    throw new Error("L1 测试只允许本地 Anvil 31337");
  const rpc = new JsonRpcProvider(config.rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  const contract = new Contract(config.publisher, ABI, rpc);
  const iface = new Interface(ABI);
  let injected: Injected | undefined;
  const validate = async () => {
    if (
      (await rpc.getNetwork()).chainId !== 31337n ||
      keccak256(await rpc.getCode(config.publisher)) !==
        config.runtimeCodeHash ||
      (await contract.L2_BOARD()).toLowerCase() !==
        deployment.board.toLowerCase() ||
      BigInt(await contract.ROLLUP_VERSION()) !==
        BigInt(deployment.rollupVersion)
    )
      throw new Error("L1 网络或接收合约不匹配，请重新部署；不会提交交易。");
  };
  const data = (job: L1Job, proof: L1Proof) =>
    iface.encodeFunctionData("publish", [
      job.postId,
      toUtf8Bytes(job.text),
      ...proof,
    ]);
  return {
    ...bridge,
    validate,
    checkPublished: async (job) => {
      if (!job.postId || !(await contract.isPublished(job.postId)))
        return false;
      if (
        (await contract.getPost(job.postId)) !== hexlify(toUtf8Bytes(job.text))
      )
        throw new Error("L1 正文与本地待发布记录不同。");
      return true;
    },
    checkReceipt: async (hash) => {
      const receipt = await rpc.getTransactionReceipt(hash);
      return !receipt
        ? "pending"
        : receipt.status === 1
          ? "success"
          : "reverted";
    },
    estimate: async (job, proof) => {
      const gas = await rpc.estimateGas({
        to: config.publisher,
        data: data(job, proof),
      });
      const fees = await rpc.getFeeData();
      return {
        gas: gas.toString(),
        fee: formatEther(gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n)),
      };
    },
    connect: async () => {
      injected ||= await findMetaMask();
      // Prompt immediately, before any slower network checks.
      const accounts = (await injected.request({
        method: "eth_requestAccounts",
      })) as string[];
      const chainId = "0x7a69";
      if ((await injected.request({ method: "eth_chainId" })) !== chainId) {
        try {
          await injected.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId }],
          });
        } catch (error) {
          if ((error as { code?: number }).code !== 4902) throw error;
          await injected.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId,
                chainName: "Billboard Local Anvil",
                rpcUrls: [config.rpcUrl],
                nativeCurrency: {
                  name: "Local ETH",
                  symbol: "ETH",
                  decimals: 18,
                },
              },
            ],
          });
          await injected.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId }],
          });
        }
      }
      await validate();
      injected.removeListener?.("accountsChanged", changed);
      injected.removeListener?.("chainChanged", changed);
      injected.on?.("accountsChanged", changed);
      injected.on?.("chainChanged", changed);
      if (!accounts[0]) throw new Error("MetaMask 未授权账号");
      return accounts[0];
    },
    send: async (job, proof, address) => {
      if (
        !injected ||
        (await injected.request({ method: "eth_chainId" })) !== "0x7a69"
      )
        throw new Error("请将 MetaMask 切换到本地 Anvil 网络后重新连接。");
      const provider = new BrowserProvider(injected, "any", {
        cacheTimeout: -1,
      });
      const signer = await provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== address.toLowerCase())
        throw new Error("MetaMask 账号已变化，请重新连接。");
      const estimate = await rpc.estimateGas({
        to: config.publisher,
        from: address,
        data: data(job, proof),
      });
      const fee = await rpc.getFeeData();
      if (
        (await rpc.getBalance(address)) <
        estimate * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n)
      )
        throw new Error("本地 ETH 不足，请领取本地测试 ETH。");
      const tx = await signer.sendTransaction({
        to: config.publisher,
        data: data(job, proof),
        value: 0n,
        gasLimit: (estimate * 120n) / 100n,
      });
      return tx.hash;
    },
    faucet: async (address) => {
      await validate();
      await rpc.send("anvil_setBalance", [
        address,
        `0x${((await rpc.getBalance(address)) + parseEther("1")).toString(16)}`,
      ]);
    },
    stop: () => {
      injected?.removeListener?.("accountsChanged", changed);
      injected?.removeListener?.("chainChanged", changed);
      rpc.destroy();
    },
  };
}

export function l1MessageLeaf(
  board: string,
  version: string,
  publisher: string,
  content: string
) {
  return `0x00${sha256(
    solidityPacked(
      ["bytes32", "uint256", "address", "uint256", "bytes32"],
      [board, version, publisher, 31337, content]
    )
  ).slice(2, -2)}`;
}
