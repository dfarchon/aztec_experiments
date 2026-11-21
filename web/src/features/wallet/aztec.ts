/* eslint-disable @typescript-eslint/no-explicit-any -- generated SDK values cross this adapter boundary */
import {
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../../protocol/message.mjs";
import { resolveSponsoredFpc } from "../../../../runtime/sponsored-fpc.mjs";
import {
  type AztecRuntime,
  createAztecRuntime,
} from "../../../../runtime/wallet-runtime.mjs";
import { environment, networkPolicy } from "../../app/network.ts";
import {
  createPublicNode,
  PublicField,
  publicReadSDK,
} from "../feed/public-reader.ts";
import { accountSetupOptions, hasAccountKeys } from "./account-keys.ts";
import { loadAztecSdk } from "./runtime-sdk.ts";
import type {
  DepositRecord,
  NotchDeployment,
  WalletAccountRecord,
  WalletProgress,
} from "./wallet-types.ts";

export interface WalletRuntimeConfig {
  nodeUrl: string;
  onLog(message: string, type?: string): void;
}

export async function loadWalletRuntime({
  nodeUrl,
  onLog,
}: WalletRuntimeConfig): Promise<AztecRuntime> {
  const sdk = await loadAztecSdk();
  return createAztecRuntime(sdk, { nodeUrl, onLog });
}

export interface AztecBoardSession {
  runtime: AztecRuntime;
  node: any;
  wallet: any;
  owner: any;
  board: any;
  payment: any;
}

export async function createAztecBoardSession(
  config: NotchDeployment,
  runtime: AztecRuntime,
  record: WalletAccountRecord,
  progress: WalletProgress,
  lifecycle: {
    assertActive(): void;
    onAccountReady(address: string, classId: string): void;
  }
): Promise<AztecBoardSession> {
  const sdk = runtime.sdk;
  const policy = networkPolicy(environment(config.environment));
  if (!hasAccountKeys(record))
    throw new Error("Private account keys are missing");
  const local: Record<string, any> = {};
  progress("Preparing your private account…");
  try {
    lifecycle.assertActive();
    const ready = await runtime.setupAccount(local, {
      ...accountSetupOptions(
        sdk as Parameters<typeof accountSetupOptions>[0],
        record,
        `pxe_notch_stake_${config.board}_${record.salt}_`,
        policy.realProofs
      ),
      onProgress: (_step, _total, message) => {
        lifecycle.assertActive();
        progress(message);
      },
    });
    lifecycle.assertActive();
    if (!ready || !local.wallet || !local.address)
      throw new Error("Private account setup failed");
    if (!local.instance?.currentContractClassId || !sdk.SDK_VERSION)
      throw new Error(
        "Private account contract metadata is unavailable. Retry setup."
      );
    lifecycle.onAccountReady(
      local.address.toString(),
      local.instance.currentContractClassId.toString()
    );
    const node = local.aztecNode ?? sdk.createAztecNodeClient(config.nodeUrl);

    const [boardResponse, sponsorResponse] = await Promise.all(
      ["/df-board-artifact.json", "/df-sponsor-artifact.json"].map(
        async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error("Missing contract artifact");
          return response.json();
        }
      )
    );
    lifecycle.assertActive();
    const artifact = sdk.loadContractArtifact(boardResponse);
    const address = sdk.AztecAddress.fromStringUnsafe(config.board);
    const instance = await node.getContract(address);
    lifecycle.assertActive();
    if (!instance) throw new Error("Board artifact mismatch");
    const expectedClass = await sdk.getContractClassFromArtifact(artifact);
    lifecycle.assertActive();
    if (!instance.currentContractClassId.equals(expectedClass.id))
      throw new Error("Board artifact mismatch");
    await local.wallet.registerContract(instance, artifact);
    lifecycle.assertActive();
    const board = await sdk.Contract.at(address, artifact, local.wallet);
    lifecycle.assertActive();
    const linked = await board.methods
      .get_l1_portal()
      .simulate({ from: sdk.NO_FROM });
    lifecycle.assertActive();
    const linkedPortal =
      linked && typeof linked === "object" && "result" in linked
        ? linked.result
        : linked;
    if (
      String(linkedPortal).toLowerCase() !== config.l1Stake.portal.toLowerCase()
    )
      throw new Error("Board trusts another stake portal");

    const sponsorArtifact = sdk.loadContractArtifact(sponsorResponse);
    const sponsor = await resolveSponsoredFpc(
      node,
      sdk,
      sponsorArtifact,
      config.sponsoredFpc
    );
    lifecycle.assertActive();
    await local.wallet.registerContract(sponsor, sponsorArtifact);
    lifecycle.assertActive();
    return {
      runtime,
      node,
      wallet: local.wallet,
      owner: local.address,
      board,
      payment: new sdk.SponsoredFeePaymentMethod(sponsor.address),
    };
  } catch (error) {
    try {
      await (local.pxe ?? local.wallet?.pxe)?.stop?.();
    } catch {
      // Cleanup must not hide the original setup or cancellation error.
    }
    throw error;
  }
}

export async function readStakeInfo(
  session: AztecBoardSession,
  owner: unknown
) {
  const result = await session.board.methods
    .get_stake_info(owner)
    .simulate({ from: owner });
  return (
    result && typeof result === "object" && "result" in result
      ? result.result
      : result
  ) as [bigint, bigint, bigint, bigint];
}

export async function checkSponsor(config: NotchDeployment) {
  const slot = await publicReadSDK.deriveStorageSlotInMap(
    new PublicField(1n),
    new PublicField(config.sponsoredFpc)
  );
  const balance = await createPublicNode(config.nodeUrl).getPublicStorageAt(
    "latest" as never,
    new PublicField(3n),
    slot
  );
  if (balance.toBigInt() <= 0n)
    throw new Error("L2 sponsor is empty. No L1 payment was requested.");
}

export async function depositWasClaimed(
  session: AztecBoardSession,
  config: NotchDeployment,
  deposit: DepositRecord
) {
  if (!deposit.messageKey) throw new Error("Missing deposit message key");
  const sdk = session.runtime.sdk;
  // Aztec 6 consume_l1_to_l2_message([secret]) uses this single-secret nullifier.
  const nullifier = await sdk.computeL1ToL2MessageNullifier(
    sdk.Fr.fromString(deposit.messageKey),
    sdk.Fr.fromString(deposit.secret)
  );
  const siloed = await sdk.siloNullifier(
    sdk.AztecAddress.fromStringUnsafe(config.board),
    nullifier
  );
  const indexes = await session.node.findLeavesIndexes(
    "latest",
    sdk.MerkleTreeId.NULLIFIER_TREE,
    [siloed]
  );
  return indexes[0] !== undefined && indexes[0] !== null;
}

async function feeOptions(session: AztecBoardSession, config: NotchDeployment) {
  const sdk = session.runtime.sdk;
  if (environment(config.environment) !== "mainnet") {
    const balance = await sdk.getFeeJuiceBalance(
      sdk.AztecAddress.fromStringUnsafe(config.sponsoredFpc),
      session.node
    );
    if (balance <= 0n)
      throw new Error("L2 sponsor is empty. No L1 payment was requested.");
  }
  return getBillboardFeeOptions(session.node, session.payment, sdk.GasFees);
}

export async function claimDeposit(
  session: AztecBoardSession,
  config: NotchDeployment,
  payer: string,
  deposit: DepositRecord,
  persist: () => void,
  progress: WalletProgress,
  assertActive: () => void
) {
  assertActive();
  const sdk = session.runtime.sdk;
  if (deposit.l2Tx) {
    const receipt = await session.node.getTxReceipt(
      sdk.TxHash.fromString(deposit.l2Tx)
    );
    assertActive();
    if (String(receipt.executionResult) === "success") return "complete";
    if (String(receipt.executionResult) !== "reverted") return "pending";
    deposit.l2Tx = null;
    persist();
  }
  if (deposit.l2Attempted)
    throw new Error(
      "Claim submission is uncertain. Check its transaction before retrying."
    );
  if (!deposit.messageKey || !deposit.leafIndex)
    throw new Error("Wait for L1 confirmation before claiming the stake");

  const env = environment(config.environment);
  let messageReady = false;
  for (let index = 0; index < (env === "local" ? 24 : 6); index++) {
    assertActive();
    messageReady = Boolean(
      await session.node.getL1ToL2MessageMembershipWitness(
        "latest",
        sdk.Fr.fromString(deposit.messageKey)
      )
    );
    assertActive();
    if (messageReady) break;
    progress("Waiting for the deposit on Aztec…");
    if (env === "local")
      await sdk
        .createAztecNodeDebugClient(config.nodeUrl)
        .warpL2TimeAtLeastBy(12);
    await new Promise((resolve) =>
      setTimeout(resolve, env === "local" ? 1000 : 5000)
    );
  }
  assertActive();
  if (!messageReady) {
    progress("Waiting for the stake on Aztec. Do not stake again.");
    return "pending";
  }

  const call = session.board.methods.claim_deposit(
    sdk.EthAddress.fromString(payer),
    BigInt(deposit.amount),
    sdk.Fr.fromString(deposit.secret),
    sdk.Fr.fromString(deposit.leafIndex)
  );
  const options = {
    from: session.owner,
    fee: await feeOptions(session, config),
  };
  assertActive();
  await call.simulate(options);
  assertActive();
  deposit.l2Attempted = true;
  persist();
  const previous = session.wallet.onTxPrepared;
  if ("onTxPrepared" in session.wallet)
    session.wallet.onTxPrepared = (hash: string) => {
      deposit.l2Tx = hash;
      persist();
    };
  try {
    const sent = await call.send(options);
    deposit.l2Tx = sent.receipt.txHash.toString();
    persist();
    if (sent.receipt.executionResult !== "success")
      throw new Error("Aztec deposit claim reverted");
    return "complete";
  } finally {
    if ("onTxPrepared" in session.wallet)
      session.wallet.onTxPrepared = previous;
  }
}

export async function publishPost(
  session: AztecBoardSession,
  config: NotchDeployment,
  message: string,
  owner: unknown
) {
  const { text, length } = encodeDFMessage(message);
  const transaction = await session.board.methods
    .post(text, length)
    .send({ from: owner, fee: await feeOptions(session, config) });
  if (transaction.receipt.executionResult !== "success")
    throw new Error("Posting failed");
  return transaction;
}

export async function startWithdrawal(
  session: AztecBoardSession,
  config: NotchDeployment,
  amount: string,
  owner: unknown,
  beforeSubmit: () => void,
  onPrepared: (hash: string) => void
) {
  const options = {
    from: owner,
    fee: await feeOptions(session, config),
  };
  const call = session.board.methods.withdraw();
  await call.simulate(options);
  beforeSubmit();
  const previous = session.wallet.onTxPrepared;
  if ("onTxPrepared" in session.wallet)
    session.wallet.onTxPrepared = onPrepared;
  try {
    const sent = await call.send(options);
    if (sent.receipt.executionResult !== "success")
      throw new Error("Aztec withdrawal reverted");
    return {
      amount,
      l2Tx: sent.receipt.txHash.toString(),
    };
  } finally {
    if ("onTxPrepared" in session.wallet)
      session.wallet.onTxPrepared = previous;
  }
}

export async function withdrawalProof(
  session: AztecBoardSession,
  l2Tx: string
) {
  const sdk = session.runtime.sdk;
  const hash = sdk.TxHash.fromString(l2Tx);
  const receipt = await session.node.getTxReceipt(hash);
  if (String(receipt.executionResult) === "reverted")
    throw new Error("Aztec withdrawal reverted. Reconnect and try again.");
  if (String(receipt.executionResult) !== "success") return null;
  const effect = await session.node.getTxEffect(hash);
  const index =
    effect?.data.l2ToL1Msgs.findIndex(
      (message: { isZero(): boolean }) => !message.isZero()
    ) ?? -1;
  if (index < 0)
    throw new Error("Withdrawal message missing from Aztec receipt");
  const witness = await session.node.getL2ToL1MembershipWitness(
    hash,
    effect.data.l2ToL1Msgs[index],
    index
  );
  return witness ?? null;
}
