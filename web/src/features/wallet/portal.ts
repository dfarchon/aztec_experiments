import {
  BrowserProvider,
  Contract,
  Interface,
  type JsonRpcProvider,
  keccak256,
  type Log,
  type TransactionReceipt,
  zeroPadValue,
} from "ethers";

import {
  environment,
  networkPolicy,
  validateChain,
  validateRpc,
} from "../../app/network.ts";
import { createPublicNode } from "../feed/public-reader.ts";
import { type InjectedProvider, waitForWalletApproval } from "./l1.ts";
import { L1ReadProvider } from "./l1-reader.ts";
import { MAX_STAKE } from "./stake-policy.ts";
import type {
  DepositRecord,
  NotchDeployment,
  WalletProgress,
} from "./wallet-types.ts";

export const portalABI = [
  "function deposit(bytes32 secretHash) payable returns(bytes32 key,uint256 index)",
  "function withdraw(uint256 amount,uint256 epoch,uint256 numCheckpointsInEpoch,uint256 leafIndex,bytes32[] path)",
  "function deposits(address) view returns(uint256)",
  "function board() view returns(bytes32)",
  "function INBOX() view returns(address)",
  "function ROLLUP_VERSION() view returns(uint256)",
  "function MAX_STAKE() view returns(uint256)",
  "event Deposited(address indexed depositor,uint256 amount,bytes32 indexed key,uint256 index,bytes32 indexed secretHash)",
  "event Withdrawn(address indexed depositor,uint256 amount)",
];

const portalInterface = new Interface(portalABI);

interface DepositMethod {
  (
    secretHash: string,
    overrides?: { value: bigint; nonce?: number }
  ): Promise<{
    hash: string;
  }>;
  estimateGas(
    secretHash: string,
    overrides?: { value: bigint; nonce?: number }
  ): Promise<bigint>;
}

interface WithdrawMethod {
  (
    amount: bigint,
    epoch: number,
    checkpoints: number,
    leafIndex: number,
    path: string[]
  ): Promise<{ hash: string }>;
}

export interface PortalContract {
  board(): Promise<string>;
  INBOX(): Promise<string>;
  ROLLUP_VERSION(): Promise<bigint>;
  MAX_STAKE(): Promise<bigint>;
  deposits(address: string): Promise<bigint>;
  connect(signer: unknown): {
    deposit: DepositMethod;
    withdraw: WithdrawMethod;
  };
  deposit: DepositMethod;
  withdraw: WithdrawMethod;
}

export function createL1Provider(config: NotchDeployment) {
  return new L1ReadProvider(config.l1Stake.rpcUrl);
}

// Display-only balance check; paid operations still verify the full portal binding.
export async function readL1Stake(config: NotchDeployment, payer: string) {
  const provider = createL1Provider(config);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const portal = new Contract(config.l1Stake.portal, portalABI, provider);
    const amount = await Promise.race([
      portal.deposits(payer),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("L1 stake check timed out. Continue setup to retry.")
            ),
          15000
        );
      }),
    ]);
    return BigInt(amount);
  } finally {
    clearTimeout(timer);
    provider.destroy();
  }
}

export async function verifyPortal(
  provider: JsonRpcProvider,
  config: NotchDeployment
): Promise<PortalContract> {
  const env = environment(config.environment);
  const policy = networkPolicy(env);
  const portalConfig = config.l1Stake;
  if (portalConfig.chainId !== policy.chainId)
    throw new Error("Wrong L1 configuration");
  for (const url of [config.nodeUrl, portalConfig.rpcUrl])
    validateRpc(url, env);

  const [info, evmNetwork, code] = await Promise.all([
    createPublicNode(config.nodeUrl).getNodeInfo(),
    provider.getNetwork(),
    provider.getCode(portalConfig.portal),
  ]);
  const l1Contracts = (
    info as {
      l1ContractAddresses: {
        rollupAddress: { toString(): string };
        inboxAddress: { toString(): string };
      };
    }
  ).l1ContractAddresses;
  validateChain(
    env,
    config,
    info as Parameters<typeof validateChain>[2],
    l1Contracts.rollupAddress.toString()
  );
  if (
    evmNetwork.chainId !== BigInt(portalConfig.chainId) ||
    l1Contracts.inboxAddress.toString().toLowerCase() !==
      portalConfig.inbox.toLowerCase() ||
    keccak256(code) !== portalConfig.runtimeCodeHash
  )
    throw new Error("Stake portal or network mismatch");

  const portal = new Contract(
    portalConfig.portal,
    portalABI,
    provider
  ) as unknown as PortalContract;
  const [bound, inbox, version, maximum] = await Promise.all([
    portal.board(),
    portal.INBOX(),
    portal.ROLLUP_VERSION(),
    portal.MAX_STAKE(),
  ]);
  if (
    bound.toLowerCase() !== config.board.toLowerCase() ||
    inbox.toLowerCase() !== portalConfig.inbox.toLowerCase() ||
    String(version) !== String(config.rollupVersion) ||
    maximum !== MAX_STAKE
  )
    throw new Error("Stake portal is linked to another board");
  return portal;
}

export const L1_LOG_CHUNK_SIZE = 10_000;
const MIN_L1_LOG_CHUNK_SIZE = 100;

interface LogFilter {
  address: string;
  topics: (string | string[] | null)[];
}

function rpcErrorText(error: unknown) {
  const value = error as {
    info?: { error?: { message?: unknown } };
    shortMessage?: unknown;
    message?: unknown;
  };
  return [value?.info?.error?.message, value?.shortMessage, value?.message]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0
    )
    .join(" | ");
}

function isArchiveRestriction(text: string) {
  return /personal token|archive (?:request|data)/i.test(text);
}

function isRateLimit(text: string) {
  return /rate.?limit|too many requests|\b429\b/i.test(text);
}

function isTimeout(text: string) {
  return /timeout|timed out|deadline exceeded/i.test(text);
}

function isRangeRestriction(text: string) {
  return /block range|ranges? (?:over|is too)|too many (?:results|logs)|more than \d+ (?:results|logs)|query (?:exceeds|returned)|response size/i.test(
    text
  );
}

function l1RpcFailure(error: unknown) {
  const text = rpcErrorText(error);
  if (isRateLimit(text))
    return new Error(
      "L1 RPC is rate-limiting historical log reads. Try again shortly."
    );
  if (isTimeout(text))
    return new Error(
      "L1 RPC timed out while reading historical logs. Try again shortly."
    );
  if (isArchiveRestriction(text))
    return new Error(
      "L1 RPC cannot read the historical logs required for wallet recovery. Try again later or contact the site operator."
    );
  if (isRangeRestriction(text))
    return new Error(
      "L1 RPC rejected the historical log request. Try again later or contact the site operator."
    );
  return error instanceof Error
    ? error
    : new Error(text || "L1 RPC request failed");
}

async function readLogs(
  provider: JsonRpcProvider,
  filter: LogFilter,
  fromBlock: number,
  toBlock: number
) {
  if (fromBlock > toBlock)
    throw new Error(
      "L1 RPC is not synchronized to the configured deployment block. Try again later or contact the site operator."
    );
  const logs: Log[] = [];
  let chunkSize = L1_LOG_CHUNK_SIZE;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      logs.push(
        ...(await provider.getLogs({
          ...filter,
          fromBlock: start,
          toBlock: end,
        }))
      );
      start = end + 1;
    } catch (error) {
      const text = rpcErrorText(error);
      // Providers with a smaller block-range cap usually accept a narrower
      // query, so halve the chunk instead of failing the whole recovery.
      if (
        chunkSize > MIN_L1_LOG_CHUNK_SIZE &&
        !isArchiveRestriction(text) &&
        !isRateLimit(text) &&
        !isTimeout(text) &&
        isRangeRestriction(text)
      ) {
        chunkSize = Math.max(MIN_L1_LOG_CHUNK_SIZE, Math.floor(chunkSize / 2));
        continue;
      }
      throw l1RpcFailure(error);
    }
  }
  return logs;
}

export async function findDeposit(
  provider: JsonRpcProvider,
  config: NotchDeployment,
  payer: string,
  secretHash: string
) {
  const from = config.l1Stake.deploymentBlock ?? 0;
  const end = await provider.getBlockNumber();
  const topic = portalInterface.getEvent("Deposited")!.topicHash;
  return readLogs(
    provider,
    {
      address: config.l1Stake.portal,
      topics: [
        topic,
        zeroPadValue(payer, 32),
        null,
        zeroPadValue(secretHash, 32),
      ],
    },
    from,
    end
  );
}

export async function readDepositHistory(
  provider: JsonRpcProvider,
  config: NotchDeployment,
  payer: string,
  expectedBalance: bigint
) {
  const end = await provider.getBlockNumber();
  const from = config.l1Stake.deploymentBlock ?? 0;
  const topics = ["Deposited", "Withdrawn"].map(
    (name) => portalInterface.getEvent(name)!.topicHash
  );
  let balance = 0n;
  let active: {
    amount: string;
    secretHash: string;
    messageKey: string;
    leafIndex: string;
    l1Tx: string;
    nonce: number;
  }[] = [];
  const logs = await readLogs(
    provider,
    {
      address: config.l1Stake.portal,
      topics: [topics, zeroPadValue(payer, 32)],
    },
    from,
    end
  );
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of logs) {
    const event = portalInterface.parseLog(log);
    if (!event || event.args.depositor.toLowerCase() !== payer.toLowerCase())
      throw new Error("Deposit recovery log mismatch");
    const amount = BigInt(event.args.amount);
    if (event.name === "Withdrawn") {
      balance -= amount;
      if (balance < 0n) throw new Error("Incomplete deposit recovery history");
      if (balance === 0n) active = [];
    } else {
      balance += amount;
      active.push({
        amount: amount.toString(),
        secretHash: String(event.args.secretHash),
        messageKey: String(event.args.key),
        leafIndex: String(event.args.index),
        l1Tx: log.transactionHash,
        nonce: 0,
      });
    }
  }
  if (balance !== expectedBalance || balance > MAX_STAKE)
    throw new Error(
      "L1 stake history changed or is incomplete. Retry recovery."
    );
  for (const deposit of active) {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(deposit.l1Tx),
      provider.getTransactionReceipt(deposit.l1Tx),
    ]);
    if (!transaction || !receipt)
      throw new Error(
        "L1 deposit is still syncing. Try again shortly. Do not stake again."
      );
    const message = verifiedDepositEvent(receipt, config, payer, deposit);
    if (
      message.messageKey.toLowerCase() !== deposit.messageKey.toLowerCase() ||
      message.leafIndex !== deposit.leafIndex
    )
      throw new Error("Deposit recovery message mismatch");
    // The Portal event identifies the depositor; an outer transaction may be
    // sent to a wallet executor or submitted by a relayer instead of the payer.
    deposit.nonce =
      transaction.from.toLowerCase() === payer.toLowerCase()
        ? transaction.nonce
        : await provider.getTransactionCount(payer);
  }
  return active;
}

export async function waitForDepositReceipt(
  provider: JsonRpcProvider,
  portal: PortalContract,
  payer: string,
  job: DepositRecord,
  config: NotchDeployment
) {
  if (!job.l1Tx) return null;
  const env = environment(config.environment);
  let receipt;
  try {
    receipt = await provider.waitForTransaction(
      job.l1Tx,
      1,
      env === "local" ? 2_000 : 35_000
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "TIMEOUT") throw error;
  }
  if (!receipt) return null;

  if (receipt.status !== 1) throw new Error("Deposit reverted on L1");
  return verifiedDepositEvent(receipt, config, payer, job);
}

// A successful event from the verified Portal is authoritative for both direct
// deposits and EIP-7702/batched wallet calls. Outer value/to/nonce need not match.
function verifiedDepositEvent(
  receipt: TransactionReceipt,
  config: NotchDeployment,
  payer: string,
  deposit: { amount: string; secretHash: string }
) {
  if (receipt.status !== 1) throw new Error("Deposit reverted on L1");
  const events = receipt.logs
    .filter(
      (log) => log.address.toLowerCase() === config.l1Stake.portal.toLowerCase()
    )
    .map((log) => {
      try {
        return portalInterface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(
      (event) =>
        event?.name === "Deposited" &&
        event.args.depositor.toLowerCase() === payer.toLowerCase() &&
        String(event.args.secretHash).toLowerCase() ===
          deposit.secretHash.toLowerCase()
    );
  if (events.length !== 1 || events[0]!.args.amount !== BigInt(deposit.amount))
    throw new Error(
      "Deposit receipt does not match the wallet, amount or claim secret"
    );
  return {
    messageKey: String(events[0]!.args.key),
    leafIndex: String(events[0]!.args.index),
  };
}

export async function submitDeposit(
  portal: PortalContract,
  injected: InjectedProvider,
  payer: string,
  job: DepositRecord,
  progress: WalletProgress,
  beforeSubmit: () => void,
  hasAccount: boolean
): Promise<string> {
  const value = BigInt(job.amount);
  const currentStake = await portal.deposits(payer);
  if (currentStake > 0n && !hasAccount)
    throw new Error(
      "Existing L1 stake found. Continue setup before staking again."
    );
  if (currentStake + value > MAX_STAKE)
    throw new Error("This L1 wallet already reached the 0.002 ETH cap");
  progress("Checking wallet account…");
  const signer = await waitForWalletApproval(
    new BrowserProvider(injected, "any", {
      cacheTimeout: -1,
    }).getSigner(),
    "account access"
  );
  if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
    throw new Error("Wallet changed");
  const entry = portal.connect(signer);
  if (job.nonce !== undefined) {
    const nonce = await signer.getNonce("pending");
    if (nonce !== job.nonce)
      throw Object.assign(
        new Error(
          "Wallet nonce changed. Retry this stake before confirming payment."
        ),
        { code: "NONCE_CHANGED" }
      );
  }
  const overrides = {
    value,
    ...(job.nonce === undefined ? {} : { nonce: job.nonce }),
  };
  progress("Checking stake gas…");
  await waitForWalletApproval(
    entry.deposit.estimateGas(job.secretHash, overrides),
    "stake gas estimate"
  );
  beforeSubmit();
  progress("Confirm the stake in your wallet…");
  const transaction = await waitForWalletApproval(
    entry.deposit(job.secretHash, overrides),
    "stake confirmation"
  );
  return transaction.hash;
}

export async function sendWithdrawal(
  portal: PortalContract,
  injected: InjectedProvider,
  payer: string,
  amount: string,
  witness: {
    epochNumber: number;
    numCheckpointsInEpoch: number;
    leafIndex: number;
    siblingPath: { toBufferArray(): Uint8Array[] };
  },
  progress: WalletProgress
) {
  const signer = await new BrowserProvider(injected, "any", {
    cacheTimeout: -1,
  }).getSigner();
  if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
    throw new Error("Wallet changed");
  const path = witness.siblingPath
    .toBufferArray()
    .map(
      (bytes) =>
        `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`
    );
  progress("Confirm the withdrawal in your wallet…");
  const transaction = await portal
    .connect(signer)
    .withdraw(
      BigInt(amount),
      witness.epochNumber,
      witness.numCheckpointsInEpoch,
      witness.leafIndex,
      path
    );
  return String(transaction.hash);
}

export async function verifyWithdrawalReceipt(
  provider: JsonRpcProvider,
  config: NotchDeployment,
  hash: string
) {
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(hash),
    provider.getTransactionReceipt(hash),
  ]);
  if (!receipt) return false;
  if (
    receipt.status !== 1 ||
    transaction?.to?.toLowerCase() !== config.l1Stake.portal.toLowerCase()
  )
    throw new Error("L1 withdrawal failed or did not target the portal");
  return true;
}
