import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  keccak256,
  sha256,
} from "ethers";

import {
  decodeDFMessage,
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../shared/df-billboard.mjs";

export type RequestSDK = typeof import("../../../shared/sdk-entry.mjs");
type Wallet = Parameters<RequestSDK["Contract"]["at"]>[2];
type Owner = Parameters<RequestSDK["getFeeJuiceBalance"]>[0];
type Node = ReturnType<RequestSDK["createAztecNodeClient"]>;
export interface RequestConfig {
  kind: "local-sponsored-l1-post";
  nodeUrl: string;
  rollupAddress: string;
  rollupVersion: string;
  board: string;
  sponsoredFpc: string;
  sponsorSalt: string;
  l1: {
    chainId: number;
    rpcUrl: string;
    entry: string;
    inbox: string;
    runtimeCodeHash: string;
  };
}
export interface PostRequest {
  text: string;
  salt: string;
  secret: string;
  secretHash: string;
  commitment: string;
  l1Tx?: string;
  messageKey?: string;
  leafIndex?: string;
  l2Tx?: string;
  l2Attempted?: boolean;
  postId?: string;
}
export const requestABI = [
  "function requestPost(bytes32 board,bytes32 commitment,bytes32 secretHash) returns(bytes32 key,uint256 index)",
  "function INBOX() view returns(address)",
  "function ROLLUP_VERSION() view returns(uint256)",
  "event PostRequested(bytes32 indexed board,bytes32 indexed key,uint256 index,bytes32 commitment,bytes32 secretHash)",
];
const unwrap = (value: unknown): unknown =>
  value && typeof value === "object" && "result" in value
    ? value.result
    : value;

export function requestCommitment(text: string, salt: string, owner: string) {
  const encoded = encodeDFMessage(text);
  const packed = Array.from({ length: 17 }, (_, i) => {
    let field = 0n;
    for (let j = 0; j < 31; j++)
      field = field * 256n + BigInt(encoded.text[i * 31 + j] ?? 0);
    return field;
  });
  const words = [
    0x444642425f4c315f524551554553545f5631n,
    BigInt(encoded.length),
    ...packed,
    BigInt(salt),
    BigInt(owner),
  ];
  return (
    "0x00" +
    sha256(AbiCoder.defaultAbiCoder().encode(["uint256[21]"], [words])).slice(
      2,
      64
    )
  );
}

export async function validateRequestConfig(
  a: RequestSDK,
  config: RequestConfig
) {
  for (const url of [config.nodeUrl, config.l1.rpcUrl]) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      throw new Error("This prototype only supports local RPCs");
  }
  if (config.kind !== "local-sponsored-l1-post" || config.l1.chainId !== 31337)
    throw new Error("Unexpected request network");
  const node = a.createAztecNodeClient(config.nodeUrl);
  const [info, addresses] = await Promise.all([
    node.getNodeInfo(),
    node.getL1ContractAddresses(),
  ]);
  if (
    info.nodeVersion !== "5.0.1" ||
    info.realProofs !== false ||
    info.l1ChainId !== 31337 ||
    String(info.rollupVersion) !== config.rollupVersion ||
    addresses.rollupAddress.toString() !== config.rollupAddress ||
    addresses.inboxAddress.toString().toLowerCase() !==
      config.l1.inbox.toLowerCase()
  )
    throw new Error("Chain changed; refusing stale request deployment");
  return node;
}

export async function verifyRequestEntry(
  config: RequestConfig,
  rpc: JsonRpcProvider
) {
  if (
    (await rpc.getNetwork()).chainId !== BigInt(config.l1.chainId) ||
    keccak256(await rpc.getCode(config.l1.entry)) !== config.l1.runtimeCodeHash
  )
    throw new Error("L1 request contract/network mismatch");
  const entry = new Contract(config.l1.entry, requestABI, rpc);
  if (
    (await entry.INBOX()).toLowerCase() !== config.l1.inbox.toLowerCase() ||
    String(await entry.ROLLUP_VERSION()) !== config.rollupVersion
  )
    throw new Error("L1 inbox/version mismatch");
  return entry;
}

// Read-only recovery: an existing L1 hash never automatically triggers another payment.
export async function readRequestReceipt(
  config: RequestConfig,
  job: PostRequest,
  rpc: JsonRpcProvider
) {
  if (!job.l1Tx) throw new Error("Missing L1 request hash");
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(job.l1Tx),
    rpc.getTransactionReceipt(job.l1Tx),
  ]);
  if (!receipt) return false;
  if (receipt.status !== 1) throw new Error("L1 request reverted");
  const iface = new Interface(requestABI);
  const call = tx && iface.parseTransaction({ data: tx.data, value: tx.value });
  if (
    !tx ||
    tx.to?.toLowerCase() !== config.l1.entry.toLowerCase() ||
    tx.value !== 0n ||
    call?.name !== "requestPost" ||
    call.args.board !== config.board ||
    call.args.commitment !== job.commitment ||
    call.args.secretHash !== job.secretHash
  )
    throw new Error("L1 transaction does not match saved post");
  const events = receipt.logs
    .filter(
      (log) => log.address.toLowerCase() === config.l1.entry.toLowerCase()
    )
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((log) => log?.name === "PostRequested");
  const event = events[0];
  if (
    events.length !== 1 ||
    !event ||
    event.args.board !== config.board ||
    event.args.commitment !== job.commitment ||
    event.args.secretHash !== job.secretHash
  )
    throw new Error("L1 request receipt mismatch");
  job.messageKey = event.args.key;
  job.leafIndex = event.args.index.toString();
  return true;
}

// Do not overwrite durable recovery data until the supplied hash is verified.
export async function recoverRequest(
  config: RequestConfig,
  job: PostRequest,
  rpc: JsonRpcProvider,
  hash: string
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("交易哈希格式不正确");
  const candidate = { ...job, l1Tx: hash };
  if (!(await readRequestReceipt(config, candidate, rpc)))
    throw new Error("该 L1 交易尚未确认，请稍后重试");
  return candidate;
}

export async function createRequestSession(
  a: RequestSDK,
  node: Node,
  wallet: Wallet,
  owner: Owner,
  config: RequestConfig,
  rawBoard: Parameters<RequestSDK["loadContractArtifact"]>[0],
  rawSponsor: Parameters<RequestSDK["loadContractArtifact"]>[0]
) {
  const artifact = a.loadContractArtifact(rawBoard);
  const address = a.AztecAddress.fromStringUnsafe(config.board);
  const instance = await node.getContract(address);
  if (
    !instance ||
    !instance.currentContractClassId.equals(
      (await a.getContractClassFromArtifact(artifact)).id
    )
  )
    throw new Error("Request board artifact mismatch");
  await wallet.registerContract(instance, artifact);
  const board = await a.Contract.at(address, artifact, wallet);
  if (
    String(
      unwrap(await board.methods.get_l1_inbox().simulate({ from: a.NO_FROM }))
    ).toLowerCase() !== config.l1.entry.toLowerCase()
  )
    throw new Error("Board trusts a different L1 entry");
  const sponsorArtifact = a.loadContractArtifact(rawSponsor);
  const sponsor = await a.getContractInstanceFromInstantiationParams(
    sponsorArtifact,
    { salt: new a.Fr(BigInt(config.sponsorSalt)) }
  );
  if (sponsor.address.toString() !== config.sponsoredFpc)
    throw new Error("Sponsor artifact mismatch");
  await wallet.registerContract(sponsor, sponsorArtifact);
  const payment = new a.SponsoredFeePaymentMethod(sponsor.address);
  const eventType = artifact.outputs.structs.events.find(
    (event) => event.kind === "struct" && event.path.endsWith("::PostPublished")
  );
  if (!eventType) throw new Error("Post event missing");
  const metadata = {
    abiType: eventType,
    eventSelector: await a.EventSelector.fromSignature("PostPublished(u32)"),
    fieldNames: ["id"],
  };
  const call = (job: PostRequest) => {
    if (!job.leafIndex) throw new Error("L1 request not confirmed");
    if (
      requestCommitment(job.text, job.salt, owner.toString()) !== job.commitment
    )
      throw new Error("Post/account changed after L1 request");
    const encoded = encodeDFMessage(job.text);
    return board.methods.post_from_l1(
      encoded.text,
      encoded.length,
      a.Fr.fromString(job.salt),
      a.Fr.fromString(job.secret),
      new a.Fr(BigInt(job.leafIndex))
    );
  };
  return {
    owner,
    board,
    node,
    async create(text: string): Promise<PostRequest> {
      encodeDFMessage(text);
      const salt = a.Fr.random().toString();
      const secret = a.Fr.random();
      return {
        text,
        salt,
        secret: secret.toString(),
        secretHash: (await a.computeSecretHash(secret)).toString(),
        commitment: requestCommitment(text, salt, owner.toString()),
      };
    },
    async ready(job: PostRequest) {
      return Boolean(
        job.messageKey &&
        (await node.getL1ToL2MessageMembershipWitness(
          "latest",
          a.Fr.fromString(job.messageKey)
        ))
      );
    },
    async simulate(job: PostRequest) {
      return call(job).simulate({
        from: owner,
        fee: await getBillboardFeeOptions(node, payment, a.GasFees),
      });
    },
    async discover(job: PostRequest) {
      if (!job.l2Tx) return false;
      const hash = a.TxHash.fromString(job.l2Tx);
      const receipt = await node.getTxReceipt(hash);
      if (String(receipt.executionResult) === "reverted")
        throw new Error("L2 publication reverted; request remains retryable");
      if (String(receipt.executionResult) !== "success") return false;
      if (!job.messageKey) throw new Error("Missing confirmed L1 message");
      const nullifier = await a.siloNullifier(
        address,
        await a.computeFeeJuiceMessageNullifier(
          a.Fr.fromString(job.messageKey),
          a.Fr.fromString(job.secret)
        )
      );
      const effect = await node.getTxEffect(hash);
      if (!effect?.data.nullifiers.some((value) => value.equals(nullifier)))
        throw new Error(
          "This L2 transaction did not consume the saved L1 request"
        );
      const { events } = await a.getPublicEvents<{ id: bigint }>(
        node,
        metadata,
        { contractAddress: address, txHash: hash }
      );
      if (events.length !== 1) throw new Error("Missing unique post event");
      const id = String(events[0].event.id);
      const [fields, length] = unwrap(
        await board.methods.get_post(BigInt(id)).simulate({ from: a.NO_FROM })
      ) as [unknown[], unknown];
      if (decodeDFMessage(fields, length) !== job.text)
        throw new Error("Post body mismatch");
      job.postId = id;
      return true;
    },
    async publish(job: PostRequest, persist: () => void) {
      if (job.l2Tx) {
        const receipt = await node.getTxReceipt(a.TxHash.fromString(job.l2Tx));
        if (String(receipt.executionResult) === "reverted") {
          job.l2Tx = undefined;
          job.l2Attempted = false;
          persist();
          throw new Error(
            "L2 transaction reverted; retry this request without another L1 payment"
          );
        }
        if (await this.discover(job)) {
          persist();
          return;
        }
        throw new Error("Existing L2 transaction pending; resume later");
      }
      if (job.l2Attempted)
        throw new Error(
          "L2 submission outcome unknown; check the transaction before retrying. Do not pay L1 again."
        );
      if (!(await this.ready(job)))
        throw new Error("L1 request is not available on L2 yet");
      const fee = await getBillboardFeeOptions(node, payment, a.GasFees);
      await call(job).simulate({ from: owner, fee });
      // Guard ambiguous broadcast failures. Never automatically repay/repost.
      job.l2Attempted = true;
      persist();
      const recoveringWallet = wallet as Wallet & {
        onTxPrepared?: ((hash: string) => void) | null;
      };
      const previous = recoveringWallet.onTxPrepared;
      if ("onTxPrepared" in recoveringWallet)
        recoveringWallet.onTxPrepared = (hash) => {
          job.l2Tx = hash;
          persist();
        };
      try {
        const sent = await call(job).send({
          from: owner,
          fee,
          wait: a.NO_WAIT,
        });
        job.l2Tx = sent.txHash.toString();
      } finally {
        if ("onTxPrepared" in recoveringWallet)
          recoveringWallet.onTxPrepared = previous;
      }
      persist();
      for (let i = 0; i < 45; i++) {
        if (await this.discover(job)) {
          persist();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("L2 transaction submitted; resume to check confirmation");
    },
  };
}
