// @ts-nocheck -- Aztec's generated contract methods are loaded at runtime.
import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  keccak256,
} from "ethers";

import {
  encodeDFMessage,
  getBillboardFeeOptions,
} from "../../../shared/df-billboard.mjs";
import {
  accountSetupOptions,
  createAccountKeys,
  readStored,
  writeStored,
} from "./accounts.ts";
import {
  findMetaMask,
  switchEthereumChain,
  waitForWalletApproval,
  WALLET_APPROVAL_TIMEOUT_MS,
} from "./l1.ts";
import {
  environment,
  networkPolicy,
  validateChain,
  validateRpc,
} from "./network.ts";
import { MAX_STAKE, STAKE_UNIT, validateTopup } from "./stake-policy.ts";
import { withWalletLock } from "./wallet-lock.ts";

export { MAX_STAKE, STAKE_UNIT } from "./stake-policy.ts";
export const portalABI = [
  "function deposit(bytes32 secretHash) payable returns(bytes32 key,uint256 index)",
  "function withdraw(uint256 amount,uint256 epoch,uint256 numCheckpointsInEpoch,uint256 leafIndex,bytes32[] path)",
  "function deposits(address) view returns(uint256)",
  "function board() view returns(bytes32)",
  "function INBOX() view returns(address)",
  "function ROLLUP_VERSION() view returns(uint256)",
  "function MAX_STAKE() view returns(uint256)",
  "event Deposited(address indexed depositor,uint256 amount,bytes32 indexed key,uint256 index,bytes32 indexed secretHash)",
];

const unwrap = (value) =>
  value && typeof value === "object" && "result" in value
    ? value.result
    : value;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iface = new Interface(portalABI);

export function createStakePosting(config, a, emit, progress) {
  const env = environment(config.environment);
  const policy = networkPolicy(env);
  const l1 = config.l1Stake;
  let injected,
    accountRequest,
    payer = "",
    saved,
    wallet,
    owner,
    board,
    node,
    payment,
    disposed = false;
  let key = "";
  const snapshot = () =>
    emit({
      available: true,
      payer,
      owner: owner?.toString() || "",
      amount: saved?.amount || "0",
      pendingDeposit: Boolean(saved?.deposit),
      depositPrepared: Boolean(saved?.deposit && !saved.deposit.submitted),
      depositNeedsHash: Boolean(
        saved?.deposit?.submitted && !saved.deposit.l1Tx
      ),
      claimNeedsHash: Boolean(
        saved?.deposit?.l2Attempted && !saved.deposit.l2Tx
      ),
      pendingExit: Boolean(saved?.exit),
      exitNeedsHash: Boolean(saved?.exit?.l2Attempted && !saved.exit.l2Tx),
      backedUp: Boolean(saved?.backedUp),
      lastPost: saved?.lastPost || "0",
    });
  const persist = () => {
    writeStored(localStorage, key, saved);
    snapshot();
  };
  const rpc = () =>
    new JsonRpcProvider(l1.rpcUrl, undefined, { cacheTimeout: -1 });
  async function verify(provider) {
    if (l1.chainId !== policy.chainId)
      throw new Error("Wrong L1 configuration");
    for (const url of [config.nodeUrl, l1.rpcUrl]) validateRpc(url, env);
    node = a.createAztecNodeClient(config.nodeUrl);
    const [info, addresses, evmNetwork, code] = await Promise.all([
      node.getNodeInfo(),
      node.getL1ContractAddresses(),
      provider.getNetwork(),
      provider.getCode(l1.portal),
    ]);
    validateChain(env, config, info, addresses.rollupAddress.toString());
    if (
      evmNetwork.chainId !== BigInt(l1.chainId) ||
      addresses.inboxAddress.toString().toLowerCase() !==
        l1.inbox.toLowerCase() ||
      keccak256(code) !== l1.runtimeCodeHash
    )
      throw new Error("Stake portal or network mismatch");
    const portal = new Contract(l1.portal, portalABI, provider);
    const [bound, inbox, version, maximum] = await Promise.all([
      portal.board(),
      portal.INBOX(),
      portal.ROLLUP_VERSION(),
      portal.MAX_STAKE(),
    ]);
    if (
      bound.toLowerCase() !== config.board.toLowerCase() ||
      inbox.toLowerCase() !== l1.inbox.toLowerCase() ||
      String(version) !== String(config.rollupVersion) ||
      maximum !== MAX_STAKE
    )
      throw new Error("Stake portal is linked to another board");
    return portal;
  }
  async function assertPayer() {
    if (!injected || !payer) throw new Error("Connect your wallet first");
    const [chain, accounts] = await Promise.all([
      injected.request({ method: "eth_chainId" }),
      injected.request({ method: "eth_accounts" }),
    ]);
    if (
      BigInt(chain) !== BigInt(l1.chainId) ||
      accounts[0]?.toLowerCase() !== payer.toLowerCase()
    )
      throw new Error(
        "Wallet account or network changed. Reconnect to continue."
      );
  }
  async function refresh() {
    if (!board || !owner) return;
    const result = unwrap(
      await board.methods.get_stake_info(owner).simulate({ from: owner })
    );
    saved.amount = BigInt(result[0]).toString();
    if (BigInt(result[1]) !== 0n && BigInt(result[1]) !== BigInt(payer))
      throw new Error("Aztec stake belongs to another L1 wallet");
    saved.lastPost = BigInt(result[2]).toString();
    persist();
  }
  async function setup() {
    const globals = window;
    globals.RPC_CONFIG = { nodeUrl: config.nodeUrl };
    const local = {};
    progress("Preparing your private account…");
    if (
      !(await globals.ensureAztecSetup(local, "log", {
        ...accountSetupOptions(
          a,
          saved,
          `pxe_notch_stake_${config.board}_${saved.salt}_`,
          policy.realProofs
        ),
        onProgress: (_step, _total, message) => progress(message),
      })) ||
      !local.wallet ||
      !local.address
    )
      throw new Error("Private account setup failed");
    wallet = local.wallet;
    owner = local.address;
    const [boardRaw, sponsorRaw] = await Promise.all(
      ["/df-board-artifact.json", "/df-sponsor-artifact.json"].map(
        async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error("Missing contract artifact");
          return response.json();
        }
      )
    );
    const artifact = a.loadContractArtifact(boardRaw);
    const address = a.AztecAddress.fromStringUnsafe(config.board);
    const instance = await node.getContract(address);
    if (
      !instance ||
      !instance.currentContractClassId.equals(
        (await a.getContractClassFromArtifact(artifact)).id
      )
    )
      throw new Error("Board artifact mismatch");
    await wallet.registerContract(instance, artifact);
    board = await a.Contract.at(address, artifact, wallet);
    const linked = unwrap(
      await board.methods.get_l1_portal().simulate({ from: a.NO_FROM })
    );
    if (String(linked).toLowerCase() !== l1.portal.toLowerCase())
      throw new Error("Board trusts another stake portal");
    const sponsorArtifact = a.loadContractArtifact(sponsorRaw);
    const sponsor = await a.getContractInstanceFromInstantiationParams(
      sponsorArtifact,
      { salt: new a.Fr(BigInt(config.sponsorSalt)) }
    );
    if (sponsor.address.toString() !== config.sponsoredFpc)
      throw new Error("Sponsor artifact mismatch");
    await wallet.registerContract(sponsor, sponsorArtifact);
    payment = new a.SponsoredFeePaymentMethod(sponsor.address);
    await refresh();
  }
  async function fee() {
    if (
      (await a.getFeeJuiceBalance(
        a.AztecAddress.fromStringUnsafe(config.sponsoredFpc),
        node
      )) <= 0n
    )
      throw new Error("L2 sponsor is empty. No L1 payment was requested.");
    return getBillboardFeeOptions(node, payment, a.GasFees);
  }
  async function confirmDeposit() {
    const job = saved?.deposit;
    if (!job) throw new Error("No deposit to resume");
    await assertPayer();
    const provider = rpc();
    try {
      const portal = await verify(provider);
      if (!job.l1Tx) {
        const matches = await portal.queryFilter(
          portal.filters.Deposited(payer, null, null, null, job.secretHash),
          l1.deploymentBlock || 0
        );
        if (matches.length > 1)
          throw new Error("Multiple deposits used the same recovery secret");
        if (matches.length) {
          job.l1Tx = matches[0].transactionHash;
          job.submitted = true;
          persist();
        }
      }
      if (!job.l1Tx)
        throw new Error(
          "Deposit transaction not found. Enter its hash or retry after checking your wallet."
        );
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(job.l1Tx),
        provider.getTransactionReceipt(job.l1Tx),
      ]);
      if (!receipt)
        throw new Error(
          "Deposit is pending on L1. Resume later; do not pay again."
        );
      if (receipt.status !== 1) throw new Error("Deposit reverted on L1");
      const call =
        tx && iface.parseTransaction({ data: tx.data, value: tx.value });
      if (
        !tx ||
        tx.to?.toLowerCase() !== l1.portal.toLowerCase() ||
        tx.from.toLowerCase() !== payer.toLowerCase() ||
        tx.value !== BigInt(job.amount) ||
        call?.name !== "deposit" ||
        call.args.secretHash !== job.secretHash
      )
        throw new Error("Saved deposit does not match the L1 transaction");
      const events = receipt.logs
        .filter((log) => log.address.toLowerCase() === l1.portal.toLowerCase())
        .map((log) => {
          try {
            return iface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((event) => event?.name === "Deposited");
      if (
        events.length !== 1 ||
        events[0].args.depositor.toLowerCase() !== payer.toLowerCase() ||
        events[0].args.amount !== BigInt(job.amount) ||
        events[0].args.secretHash !== job.secretHash
      )
        throw new Error("Deposit receipt mismatch");
      job.messageKey = events[0].args.key;
      job.leafIndex = events[0].args.index.toString();
      persist();
    } finally {
      provider.destroy();
    }
    if (job.l2Tx) {
      const receipt = await node.getTxReceipt(a.TxHash.fromString(job.l2Tx));
      if (String(receipt.executionResult) === "success") {
        saved.deposit = null;
        await refresh();
        return;
      }
      if (String(receipt.executionResult) !== "reverted")
        throw new Error(
          "Aztec claim is pending. Resume later; do not deposit again."
        );
      job.l2Tx = null;
      persist();
    }
    if (job.l2Attempted)
      throw new Error(
        "Claim submission is uncertain. Check its transaction before retrying."
      );
    let ready = false;
    for (let i = 0; i < (env === "local" ? 24 : 60); i++) {
      if (disposed)
        throw new Error("Deposit saved. Reconnect to resume claim.");
      ready = Boolean(
        await node.getL1ToL2MessageMembershipWitness(
          "latest",
          a.Fr.fromString(job.messageKey)
        )
      );
      if (ready) break;
      progress("Waiting for the deposit on Aztec…");
      if (env === "local")
        await a
          .createAztecNodeDebugClient(config.nodeUrl)
          .warpL2TimeAtLeastBy(12);
      await wait(env === "local" ? 1000 : 5000);
    }
    if (!ready)
      throw new Error("Deposit is saved. Resume the Aztec claim later.");
    const call = board.methods.claim_deposit(
      a.EthAddress.fromString(payer),
      BigInt(job.amount),
      a.Fr.fromString(job.secret),
      a.Fr.fromString(job.leafIndex)
    );
    const options = { from: owner, fee: await fee() };
    await call.simulate(options);
    job.l2Attempted = true;
    persist();
    const previous = wallet.onTxPrepared;
    if ("onTxPrepared" in wallet)
      wallet.onTxPrepared = (hash) => {
        job.l2Tx = hash;
        persist();
      };
    try {
      const sent = await call.send(options);
      job.l2Tx = sent.receipt.txHash.toString();
      persist();
      if (sent.receipt.executionResult !== "success")
        throw new Error("Aztec deposit claim reverted");
      saved.deposit = null;
      await refresh();
    } finally {
      if ("onTxPrepared" in wallet) wallet.onTxPrepared = previous;
    }
  }
  async function sendDeposit() {
    const job = saved?.deposit;
    if (!job || job.submitted)
      throw new Error(
        "Deposit was already submitted. Recover its transaction hash."
      );
    await assertPayer();
    await fee();
    const provider = rpc();
    try {
      const portal = await verify(provider);
      const previous = await portal.queryFilter(
        portal.filters.Deposited(payer, null, null, null, job.secretHash),
        l1.deploymentBlock || 0
      );
      if (previous.length) {
        if (previous.length !== 1)
          throw new Error("Multiple deposits used the same recovery secret");
        job.l1Tx = previous[0].transactionHash;
        job.submitted = true;
        persist();
        return await confirmDeposit();
      }
      const value = BigInt(job.amount);
      if ((await portal.deposits(payer)) + value > MAX_STAKE)
        throw new Error("This L1 wallet already reached the 0.002 ETH cap");
      const signer = await new BrowserProvider(injected, "any", {
        cacheTimeout: -1,
      }).getSigner();
      if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
        throw new Error("Wallet changed");
      const entry = portal.connect(signer);
      await entry.deposit.estimateGas(job.secretHash, { value });
      // Preserve the prepared secret before asking the wallet to spend ETH.
      job.submitted = true;
      persist();
      progress("Confirm the stake in your wallet…");
      try {
        const tx = await entry.deposit(job.secretHash, { value });
        job.l1Tx = tx.hash;
        persist();
      } catch (error) {
        if (error?.code === "ACTION_REJECTED" || error?.code === 4001) {
          job.submitted = false;
          persist();
        }
        throw error;
      }
    } finally {
      provider.destroy();
    }
    await confirmDeposit();
  }
  async function completeExit() {
    const job = saved?.exit;
    if (!job?.l2Tx)
      throw new Error(
        "Withdrawal transaction is not known. Recover its hash first."
      );
    await assertPayer();
    const hash = a.TxHash.fromString(job.l2Tx);
    const receipt = await node.getTxReceipt(hash);
    if (String(receipt.executionResult) === "reverted")
      throw new Error("Aztec withdrawal reverted. Reconnect and try again.");
    if (String(receipt.executionResult) !== "success")
      throw new Error("Aztec withdrawal is pending. Complete it later.");
    const effect = await node.getTxEffect(hash);
    const index =
      effect?.data.l2ToL1Msgs.findIndex((message) => !message.isZero()) ?? -1;
    if (index < 0)
      throw new Error("Withdrawal message missing from Aztec receipt");
    const witness = await node.getL2ToL1MembershipWitness(
      hash,
      effect.data.l2ToL1Msgs[index],
      index
    );
    if (!witness)
      throw new Error("Withdrawal proof is not ready. Complete it later.");
    const provider = rpc();
    try {
      const portal = await verify(provider);
      if ((await portal.deposits(payer)) === 0n) {
        saved.exit = null;
        await refresh();
        return;
      }
      if (!job.l1Tx) {
        const signer = await new BrowserProvider(injected, "any", {
          cacheTimeout: -1,
        }).getSigner();
        if ((await signer.getAddress()).toLowerCase() !== payer.toLowerCase())
          throw new Error("Wallet changed");
        const path = witness.siblingPath
          .toBufferArray()
          .map(
            (byte) =>
              `0x${Array.from(byte, (value) => value.toString(16).padStart(2, "0")).join("")}`
          );
        progress("Confirm the withdrawal in your wallet…");
        const tx = await portal
          .connect(signer)
          .withdraw(
            BigInt(job.amount),
            witness.epochNumber,
            witness.numCheckpointsInEpoch,
            witness.leafIndex,
            path
          );
        job.l1Tx = tx.hash;
        persist();
      }
      const [tx, l1Receipt] = await Promise.all([
        provider.getTransaction(job.l1Tx),
        provider.getTransactionReceipt(job.l1Tx),
      ]);
      if (!l1Receipt)
        throw new Error("L1 withdrawal is pending. Complete it later.");
      if (
        l1Receipt.status !== 1 ||
        tx?.to?.toLowerCase() !== l1.portal.toLowerCase()
      )
        throw new Error("L1 withdrawal failed or did not target the portal");
      saved.exit = null;
      await refresh();
    } finally {
      provider.destroy();
    }
  }
  const operations = {
    async connect() {
      if (!injected) {
        injected = await findMetaMask();
        injected.on?.("accountsChanged", () => {
          payer = "";
          snapshot();
        });
        injected.on?.("chainChanged", () => {
          payer = "";
          snapshot();
        });
      }
      const request = injected.request({
        method: accountRequest ? "eth_accounts" : "eth_requestAccounts",
      });
      if (!accountRequest) {
        accountRequest = request;
        void request
          .finally(() => {
            if (accountRequest === request) accountRequest = null;
          })
          .catch(() => {});
      }
      const accounts = await waitForWalletApproval(
        request,
        "connection",
        WALLET_APPROVAL_TIMEOUT_MS
      );
      if (!accounts[0]) throw new Error("Wallet access was not authorized");
      await switchEthereumChain(
        injected,
        `0x${l1.chainId.toString(16)}`,
        l1.rpcUrl,
        env
      );
      const provider = rpc();
      try {
        await verify(provider);
      } finally {
        provider.destroy();
      }
      payer = accounts[0];
      key = `notch-stake/6.0.0/${config.board}/${payer.toLowerCase()}`;
      saved = readStored(localStorage, key);
      if (saved && saved.payer?.toLowerCase() !== payer.toLowerCase())
        throw new Error("Saved private account belongs to another L1 wallet");
      if (!saved) {
        saved = {
          ...createAccountKeys(a),
          payer,
          amount: "0",
          backedUp: false,
          deposit: null,
          exit: null,
        };
        persist();
      }
      await setup();
      snapshot();
    },
    async deposit(amount) {
      if (!board || !saved) throw new Error("Connect your wallet first");
      if (!saved.backedUp)
        throw new Error("Download your private account backup before staking");
      if (saved.deposit || saved.exit)
        throw new Error("Finish the pending operation first");
      await assertPayer();
      const value = BigInt(amount);
      validateTopup(value, BigInt(saved.amount));
      const secret = a.Fr.random();
      saved.deposit = {
        amount: value.toString(),
        secret: secret.toString(),
        secretHash: (await a.computeSecretHash(secret)).toString(),
        submitted: false,
        l1Tx: null,
        l2Tx: null,
        l2Attempted: false,
      };
      persist();
    },
    async resume() {
      if (!saved?.deposit) throw new Error("No pending deposit");
      if (!saved.deposit.submitted) await sendDeposit();
      else await confirmDeposit();
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
      if (!board || !saved || BigInt(saved.amount) === 0n)
        throw new Error("No stake to withdraw");
      if (saved.deposit || saved.exit)
        throw new Error("Finish the pending operation first");
      await assertPayer();
      const options = { from: owner, fee: await fee() };
      const call = board.methods.withdraw();
      await call.simulate(options);
      const amount = saved.amount;
      saved.exit = { amount, l2Tx: null, l1Tx: null, l2Attempted: true };
      persist();
      const previous = wallet.onTxPrepared;
      if ("onTxPrepared" in wallet)
        wallet.onTxPrepared = (hash) => {
          saved.exit.l2Tx = hash;
          persist();
        };
      try {
        const sent = await call.send(options);
        saved.exit.l2Tx = sent.receipt.txHash.toString();
        persist();
        if (sent.receipt.executionResult !== "success")
          throw new Error("Aztec withdrawal reverted");
      } finally {
        if ("onTxPrepared" in wallet) wallet.onTxPrepared = previous;
      }
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
      if (!board || BigInt(saved?.amount || 0) < STAKE_UNIT)
        throw new Error("Stake before posting");
      if (saved.deposit || saved.exit)
        throw new Error("Finish the pending operation first");
      await assertPayer();
      const { text, length } = encodeDFMessage(message);
      const tx = await board.methods
        .post(text, length)
        .send({ from: owner, fee: await fee() });
      if (tx.receipt.executionResult !== "success")
        throw new Error("Posting failed");
      await refresh();
      return message;
    },
    async restore(file) {
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
      if (file.size > 64 * 1024) throw new Error("Backup file is too large");
      const backup = JSON.parse(await file.text());
      if (
        backup.board !== config.board ||
        backup.payer?.toLowerCase() !== payer.toLowerCase() ||
        !["secretKey", "salt", "signingKey", "address"].every(
          (name) => typeof backup[name] === "string" && backup[name]
        )
      )
        throw new Error("Backup does not match this board and L1 wallet");
      const derived = await window.deriveAccountAddress(
        backup.secretKey,
        BigInt(backup.salt),
        a.Fq.fromString(backup.signingKey)
      );
      if (
        derived.address.toString().toLowerCase() !==
        backup.address.toLowerCase()
      )
        throw new Error("Backup keys do not match the Aztec address");
      await wallet?.pxe?.stop?.();
      saved = {
        secretKey: backup.secretKey,
        salt: backup.salt,
        signingKey: backup.signingKey,
        payer,
        amount: "0",
        backedUp: true,
        deposit: backup.deposit || null,
        exit: backup.exit || null,
      };
      persist();
      await setup();
    },
    backup() {
      if (!saved || !owner) return null;
      saved.backedUp = true;
      persist();
      return {
        filename: `notch-account-${owner.toString().slice(0, 10)}.json`,
        contents: JSON.stringify(
          {
            secretKey: saved.secretKey,
            salt: saved.salt,
            signingKey: saved.signingKey,
            address: owner.toString(),
            payer,
            board: config.board,
            deposit: saved.deposit,
            exit: saved.exit,
          },
          null,
          2
        ),
      };
    },
    async disconnect() {
      payer = "";
      await wallet?.pxe?.stop?.();
      wallet = null;
      board = null;
      owner = null;
      saved = null;
      snapshot();
    },
    dispose() {
      disposed = true;
      void wallet?.pxe?.stop?.().catch(() => {});
    },
  };
  return {
    ...operations,
    connect: () =>
      withWalletLock(`notch-stake:${config.board}`, operations.connect),
    deposit: (amount) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.deposit(amount)
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
    post: (text) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.post(text)
      ),
    restore: (file) =>
      withWalletLock(`notch-stake:${config.board}`, () =>
        operations.restore(file)
      ),
  };
}
