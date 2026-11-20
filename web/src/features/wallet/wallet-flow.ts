import {
  importedAccountRecord,
  readAccountFile,
  writeAccountFile,
} from "./account-files.ts";
import { createAccountKeys, hasAccountKeys } from "./account-keys.ts";
import {
  accountStorageKey,
  newAccountRecord,
  readAccountRecord,
  writeAccountRecord,
} from "./account-storage.ts";
import {
  type AztecBoardSession,
  checkSponsor,
  claimDeposit,
  createAztecBoardSession,
  publishPost,
  readStakeInfo,
  startWithdrawal,
  withdrawalProof,
} from "./aztec.ts";
import { createDepositSecret } from "./deposit-secret.ts";
import {
  switchEthereumChain,
  waitForWalletApproval,
  WALLET_APPROVAL_TIMEOUT_MS,
} from "./l1.ts";
import {
  createL1Provider,
  findDeposit,
  sendWithdrawal,
  submitDeposit,
  verifyPortal,
  verifyWithdrawalReceipt,
  waitForDepositReceipt,
} from "./portal.ts";
import { MAX_STAKE, STAKE_UNIT, validateTopup } from "./stake-policy.ts";
import { withWalletLock } from "./wallet-lock.ts";
import type {
  DepositRecord,
  NotchDeployment,
  StakeListener,
  WalletAccountRecord,
  WalletFlow,
  WalletProgress,
} from "./wallet-types.ts";

export { MAX_STAKE, STAKE_UNIT } from "./stake-policy.ts";

export function createWalletFlow(
  config: NotchDeployment,
  initialRuntime: unknown,
  emit: StakeListener,
  progress: WalletProgress
): WalletFlow {
  let runtime = initialRuntime as AztecBoardSession["runtime"] | undefined;
  let injected: Parameters<WalletFlow["connect"]>[0] | undefined;
  let payer = "";
  let saved: WalletAccountRecord | null = null;
  let session: AztecBoardSession | null = null;
  let storageKey = "";
  let disposed = false;

  const snapshot = () => {
    if (disposed || !saved) return;
    emit({
      available: true,
      payer,
      owner: session ? session.owner.toString() : "",
      aztecReady: Boolean(session),
      setupComplete: Boolean(
        saved.setupComplete ||
        (hasAccountKeys(saved) && BigInt(saved.amount) > 0n && !saved.deposit)
      ),
      amount: saved.amount || "0",
      stakeChoice: saved.stakeChoice || STAKE_UNIT.toString(),
      remaining: session ? (saved.remaining ?? null) : null,
      pendingDeposit: Boolean(saved.deposit),
      pendingAmount: saved.deposit?.amount || "0",
      depositL1Confirmed: Boolean(saved.deposit?.messageKey),
      depositPrepared: Boolean(saved.deposit && !saved.deposit.submitted),
      depositNeedsHash: Boolean(
        saved.deposit?.submitted && !saved.deposit.l1Tx
      ),
      claimNeedsHash: Boolean(
        saved.deposit?.l2Attempted && !saved.deposit.l2Tx
      ),
      pendingExit: Boolean(saved.exit),
      exitNeedsHash: Boolean(saved.exit?.l2Attempted && !saved.exit.l2Tx),
      lastPost: saved.lastPost || "0",
    });
  };

  const persist = () => {
    if (disposed) throw new Error("Wallet session ended");
    if (!saved || !storageKey) throw new Error("No wallet account is open");
    writeAccountRecord(localStorage, storageKey, saved);
    snapshot();
  };

  const emitDisconnected = () => {
    if (disposed) return;
    emit({
      available: true,
      payer: "",
      owner: "",
      aztecReady: false,
      setupComplete: false,
      amount: "0",
      stakeChoice: STAKE_UNIT.toString(),
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
    });
  };

  async function assertPayer() {
    if (!injected || !payer) throw new Error("Connect your wallet first");
    const [chain, accounts] = await Promise.all([
      injected.request({ method: "eth_chainId" }),
      injected.request({ method: "eth_accounts" }),
    ]);
    if (
      BigInt(chain as string) !== BigInt(config.l1Stake.chainId) ||
      (accounts as string[])[0]?.toLowerCase() !== payer.toLowerCase()
    )
      throw new Error(
        "Wallet account or network changed. Reconnect to continue."
      );
  }

  async function refresh() {
    if (!session || !saved) return;
    const result = await readStakeInfo(session, session.owner);
    const stakeAmount = BigInt(result[0]);
    const depositor = BigInt(result[1]);
    if (depositor !== 0n && depositor !== BigInt(payer))
      throw new Error("Aztec stake belongs to another L1 wallet");
    if (
      stakeAmount === 0n &&
      saved.importedAmountHint &&
      BigInt(saved.importedAmountHint) > 0n
    )
      throw new Error(
        "Aztec stake note was not found after sync. Check the node and try again."
      );
    if (stakeAmount > 0n && !saved.deposit) saved.setupComplete = true;
    saved.amount = stakeAmount.toString();
    saved.lastPost = BigInt(result[2]).toString();
    saved.remaining = Number(BigInt(result[3]));
    delete saved.importedAmountHint;
    persist();
  }

  async function confirmDeposit(): Promise<boolean> {
    const job = saved?.deposit;
    if (!job) throw new Error("No deposit to resume");
    await assertPayer();
    const provider = createL1Provider(config);
    try {
      const portal = await verifyPortal(provider, config);
      if (!job.l1Tx) {
        const matches = await findDeposit(
          portal,
          payer,
          job.secretHash,
          config.l1Stake.deploymentBlock || 0
        );
        if (matches.length > 1)
          throw new Error("Multiple deposits used the same recovery secret");
        if (matches.length) {
          job.l1Tx = matches[0].transactionHash;
          job.submitted = true;
          persist();
        }
      }
      if (!job.l1Tx) {
        progress("Waiting for L1 confirmation. Do not stake again.");
        return false;
      }
      const receipt = await waitForDepositReceipt(
        provider,
        portal,
        payer,
        job,
        config
      );
      if (!receipt) {
        progress("Waiting for L1 confirmation. Do not stake again.");
        return false;
      }
      job.messageKey = receipt.messageKey;
      job.leafIndex = receipt.leafIndex;
      persist();
    } finally {
      provider.destroy();
    }
    if (!session) return true;
    const claimSession = session;
    const result = await claimDeposit(
      claimSession,
      config,
      payer,
      job,
      persist,
      progress,
      () => {
        if (disposed || saved?.deposit !== job || session !== claimSession)
          throw new Error("Deposit saved. Reconnect to resume claim.");
      }
    );
    if (result !== "complete") return false;
    saved!.deposit = null;
    await refresh();
    return true;
  }

  async function sendDeposit(onSubmitted?: () => void): Promise<boolean> {
    const job = saved?.deposit;
    if (!job || job.submitted)
      throw new Error(
        "Deposit was already submitted. Recover its transaction hash."
      );
    await assertPayer();
    progress("Checking the L2 sponsor…");
    await checkSponsor(config);
    const provider = createL1Provider(config);
    try {
      progress("Checking the L1 stake…");
      const portal = await verifyPortal(provider, config);
      const previous = await findDeposit(
        portal,
        payer,
        job.secretHash,
        config.l1Stake.deploymentBlock || 0
      );
      if (previous.length) {
        if (previous.length !== 1)
          throw new Error("Multiple deposits used the same recovery secret");
        job.l1Tx = previous[0].transactionHash;
        job.submitted = true;
        persist();
        return confirmDeposit();
      }
      try {
        job.l1Tx = await submitDeposit(
          portal,
          injected!,
          payer,
          job,
          progress,
          () => {
            job.submitted = true;
            persist();
          },
          hasAccountKeys(saved)
        );
        persist();
        onSubmitted?.();
      } catch (error) {
        if (
          (error as { code?: string | number }).code === "ACTION_REJECTED" ||
          (error as { code?: string | number }).code === 4001
        ) {
          job.submitted = false;
          persist();
        }
        throw error;
      }
    } finally {
      provider.destroy();
    }
    return confirmDeposit();
  }

  async function completeExit() {
    const job = saved?.exit;
    if (!job?.l2Tx || !saved || !session)
      throw new Error(
        "Withdrawal transaction is not known. Recover its hash first."
      );
    await assertPayer();
    const witness = await withdrawalProof(session, job.l2Tx);
    const provider = createL1Provider(config);
    try {
      const portal = await verifyPortal(provider, config);
      if ((await portal.deposits(payer)) === 0n) {
        saved.exit = null;
        await refresh();
        return;
      }
      if (!job.l1Tx) {
        job.l1Tx = await sendWithdrawal(
          portal,
          injected!,
          payer,
          job.amount,
          witness,
          progress
        );
        persist();
      }
      if (!(await verifyWithdrawalReceipt(provider, config, job.l1Tx)))
        throw new Error("L1 withdrawal is pending. Complete it later.");
      saved.exit = null;
      await refresh();
    } finally {
      provider.destroy();
    }
  }

  const operations: WalletFlow = {
    async connect(provider, savedSession) {
      if (!provider || typeof provider.request !== "function")
        throw new Error("Choose an Ethereum wallet first");
      injected = provider;
      session = null;
      snapshot();
      try {
        const accounts = (await waitForWalletApproval(
          provider.request({
            method: savedSession ? "eth_accounts" : "eth_requestAccounts",
          }),
          "connection",
          WALLET_APPROVAL_TIMEOUT_MS
        )) as string[];
        if (savedSession) {
          const chain = (await provider.request({
            method: "eth_chainId",
          })) as string;
          if (
            !accounts[0] ||
            accounts[0].toLowerCase() !== savedSession.payer.toLowerCase() ||
            BigInt(chain) !== BigInt(config.l1Stake.chainId)
          )
            return false;
        }
        if (!accounts[0]) throw new Error("Wallet access was not authorized");
        if (!savedSession)
          await switchEthereumChain(
            provider,
            `0x${config.l1Stake.chainId.toString(16)}`,
            config.l1Stake.rpcUrl,
            config.environment
          );
        payer = accounts[0];
        storageKey = accountStorageKey(config, payer);
        saved = readAccountRecord(localStorage, storageKey);
        if (saved && saved.payer.toLowerCase() !== payer.toLowerCase())
          throw new Error("Saved private account belongs to another L1 wallet");
        if (!saved) {
          saved = newAccountRecord(payer);
          persist();
        }
        snapshot();
        provider.on?.("accountsChanged", walletChanged);
        provider.on?.("chainChanged", walletChanged);
      } catch (error) {
        session = null;
        await stopSession();
        snapshot();
        throw error;
      }
    },

    async initializeAztec(nextRuntime) {
      if (!payer || !saved) throw new Error("Connect your L1 wallet first");
      if (session) return true;
      if (saved.deposit && !saved.deposit.messageKey)
        throw new Error("Wait for L1 confirmation before initializing Aztec");
      if (
        !saved.deposit &&
        BigInt(saved.amount) === 0n &&
        !hasAccountKeys(saved)
      )
        throw new Error("Stake before initializing Aztec");
      runtime = nextRuntime;
      if (!saved.secretKey) {
        Object.assign(
          saved,
          createAccountKeys(
            runtime!.sdk as Parameters<typeof createAccountKeys>[0]
          )
        );
        persist();
      }
      const record = saved;
      const assertActive = () => {
        if (disposed || saved !== record)
          throw new Error("Wallet session ended");
      };
      try {
        session = await createAztecBoardSession(
          config,
          runtime!,
          record,
          progress,
          {
            assertActive,
            onAccountReady: (address) => {
              assertActive();
              record.address = address;
              persist();
            },
          }
        );
        assertActive();
        await assertPayer();
        assertActive();
        await refresh();
        snapshot();
      } catch (error) {
        await stopSession();
        snapshot();
        throw error;
      }
      if (saved.deposit) return confirmDeposit();
      return true;
    },

    selectStakeAmount(amount) {
      if (!payer || !saved) throw new Error("Connect your wallet first");
      if (saved.exit) throw new Error("Finish the pending operation first");
      const value = BigInt(amount);
      if (value < STAKE_UNIT || value > MAX_STAKE || value % STAKE_UNIT !== 0n)
        throw new Error("Choose a valid stake amount");
      if (
        saved.deposit?.submitted ||
        saved.deposit?.l1Tx ||
        saved.deposit?.messageKey ||
        saved.deposit?.l2Attempted
      )
        throw new Error(
          "This stake may already be on L1. Finish or recover it before changing the amount."
        );
      saved.stakeChoice = value.toString();
      persist();
    },

    async stake(amount, onSubmitted) {
      if (!payer || !saved) throw new Error("Connect your wallet first");
      if (saved.exit) throw new Error("Finish the pending operation first");
      if (
        saved.deposit?.submitted ||
        saved.deposit?.l1Tx ||
        saved.deposit?.messageKey ||
        saved.deposit?.l2Attempted
      )
        return operations.resume();
      const value = BigInt(amount);
      validateTopup(value, BigInt(saved.amount));
      saved.stakeChoice = value.toString();
      if (saved.deposit && BigInt(saved.deposit.amount) !== value)
        saved.deposit = null;
      if (!saved.deposit) {
        await assertPayer();
        const { secret, secretHash } = createDepositSecret();
        saved.deposit = {
          amount: value.toString(),
          secret,
          secretHash,
          submitted: false,
          l1Tx: null,
          l2Tx: null,
          l2Attempted: false,
        } satisfies DepositRecord;
      }
      persist();
      return sendDeposit(onSubmitted);
    },

    async resume() {
      if (!saved?.deposit) throw new Error("No pending deposit");
      if (!saved.deposit.submitted) return sendDeposit();
      return confirmDeposit();
    },

    async recoverDeposit(hash) {
      if (
        !saved?.deposit?.submitted ||
        saved.deposit.l1Tx ||
        !/^0x[\da-f]{64}$/i.test(hash)
      )
        throw new Error("Enter the existing L1 deposit transaction hash");
      saved.deposit.l1Tx = hash;
      persist();
      await confirmDeposit();
    },

    async recoverClaim(hash) {
      if (
        !saved?.deposit?.l2Attempted ||
        saved.deposit.l2Tx ||
        !/^0x[\da-f]{64}$/i.test(hash)
      )
        throw new Error("Enter the existing Aztec claim transaction hash");
      saved.deposit.l2Tx = hash;
      persist();
      await confirmDeposit();
    },

    async withdraw() {
      if (!session || !saved || BigInt(saved.amount) === 0n)
        throw new Error("No stake to withdraw");
      if (saved.deposit || Boolean(saved.exit))
        throw new Error("Finish the pending operation first");
      await assertPayer();
      const result = await startWithdrawal(
        session,
        config,
        saved.amount,
        session.owner,
        () => {
          saved!.exit = {
            amount: saved!.amount,
            l2Tx: null,
            l1Tx: null,
            l2Attempted: true,
          };
          persist();
        },
        (hash) => {
          saved!.exit!.l2Tx = hash;
          persist();
        }
      );
      const exitRecord = saved.exit;
      if (!exitRecord)
        throw new Error("Withdrawal transaction was not recorded");
      exitRecord.l2Tx = result.l2Tx;
      persist();
      await completeExit();
    },

    async resumeExit() {
      await completeExit();
    },

    async recoverExit(hash) {
      if (
        !saved?.exit?.l2Attempted ||
        saved.exit.l2Tx ||
        !/^0x[\da-f]{64}$/i.test(hash)
      )
        throw new Error("Enter the existing Aztec withdrawal transaction hash");
      saved.exit.l2Tx = hash;
      persist();
      await completeExit();
    },

    async post(message) {
      if (!session || !saved || BigInt(saved.amount) < STAKE_UNIT)
        throw new Error("Stake before posting");
      if (saved.deposit || saved.exit)
        throw new Error("Finish the pending operation first");
      await assertPayer();
      await publishPost(session, config, message, session.owner);
      await refresh();
      return message;
    },

    async restore(file, nextRuntime) {
      if (
        !saved ||
        !payer ||
        BigInt(saved.amount) !== 0n ||
        saved.deposit ||
        saved.exit
      )
        throw new Error(
          "Connect the original L1 wallet before restoring a backup"
        );
      runtime = nextRuntime;
      const imported = await readAccountFile(file, config, payer, runtime!);
      saved = importedAccountRecord(payer, imported);
      persist();
      return true;
    },

    backup() {
      if (!saved || !payer || !hasAccountKeys(saved)) return null;
      return writeAccountFile(
        saved,
        session?.owner.toString() || saved.address || "",
        config
      );
    },

    async disconnect() {
      injected?.removeListener?.("accountsChanged", walletChanged);
      injected?.removeListener?.("chainChanged", walletChanged);
      injected = undefined;
      payer = "";
      saved = null;
      await stopSession();
      emitDisconnected();
    },

    dispose() {
      disposed = true;
      injected?.removeListener?.("accountsChanged", walletChanged);
      injected?.removeListener?.("chainChanged", walletChanged);
      void session?.wallet?.pxe?.stop?.().catch(() => {});
    },
  };

  async function stopSession() {
    const previous = session;
    session = null;
    await previous?.wallet?.pxe?.stop?.().catch(() => {});
  }

  const walletChanged = () => {
    void operations.disconnect().catch(() => {});
  };

  return {
    ...operations,
    connect: (provider, savedSession) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.connect(provider, savedSession)
      ),
    stake: (amount, onSubmitted) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.stake(amount, onSubmitted)
      ),
    resume: () =>
      withWalletLock(`notch-stake:${config.board}`, operations.resume),
    recoverDeposit: (hash) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.recoverDeposit(hash)
      ),
    recoverClaim: (hash) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.recoverClaim(hash)
      ),
    withdraw: () =>
      withWalletLock(`notch-stake:${config.board}`, operations.withdraw),
    resumeExit: () =>
      withWalletLock(`notch-stake:${config.board}`, operations.resumeExit),
    recoverExit: (hash) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.recoverExit(hash)
      ),
    post: (message) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.post(message)
      ),
    restore: (file, nextRuntime) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.restore(file, nextRuntime)
      ),
  };
}
