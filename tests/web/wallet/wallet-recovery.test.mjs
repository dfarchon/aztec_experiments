import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Barretenberg } from "@aztec-foundation/bb.js";
import { getSchnorrInitializerlessAccountContractAddress } from "@aztec-labs/accounts/schnorr";
import { Fq, Fr } from "@aztec-labs/aztec.js/fields";
import { build } from "esbuild";
import { getBytes, Interface, Wallet } from "ethers";

import {
  readAccountFile,
  writeAccountFile,
} from "../../../web/src/features/wallet/account-files.ts";
import { depositWasClaimed } from "../../../web/src/features/wallet/aztec.ts";
import {
  portalABI,
  readDepositHistory,
} from "../../../web/src/features/wallet/portal.ts";
import { STAKE_UNIT } from "../../../web/src/features/wallet/stake-policy.ts";
import {
  accountRecoveryMessage,
  deriveAccountKeys,
  deriveDepositSecret,
} from "../../../web/src/features/wallet/wallet-recovery.ts";

// Public, disposable test identity; no deployment keys or network calls are used.
const wallet = new Wallet(`0x${"11".repeat(32)}`);
const payer = wallet.address;
const config = {
  kind: "notch-stake",
  schemaVersion: 2,
  environment: "local",
  nodeUrl: "http://127.0.0.1:5180",
  board: `0x${"1".repeat(64)}`,
  rollupAddress: `0x${"2".repeat(40)}`,
  rollupVersion: 1,
  l1Stake: {
    chainId: 31337,
    portal: `0x${"3".repeat(40)}`,
    rpcUrl: "http://127.0.0.1:5954",
    deploymentBlock: 10,
  },
};
const iface = new Interface(portalABI);
const keys = deriveAccountKeys(
  await wallet.signMessage(accountRecoveryMessage(config, payer)),
  config,
  payer
);
const addressOf = async (value) =>
  (
    await getSchnorrInitializerlessAccountContractAddress(
      Fq.fromString(value.signingKey),
      Fr.fromString(value.salt),
      Fr.fromString(value.secretKey)
    )
  ).toString();
// Address hashing needs WASM, but does not need proof CRS or a running node.
await Barretenberg.initSingleton({ skipSrsInit: true, threads: 1 });
test.after(() => Barretenberg.destroySingleton());
const expectedAddress = await addressOf(keys);

// Keep the state machine and cryptographic derivations real, replacing only chain/SDK IO.
const compiled = await build({
  entryPoints: [
    fileURLToPath(
      new URL(
        "../../../web/src/features/wallet/wallet-flow.ts",
        import.meta.url
      )
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  packages: "external",
  plugins: [
    {
      name: "offline-chain",
      setup(build) {
        build.onResolve({ filter: /^\.\/(portal|aztec)\.ts$/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: (path.includes("portal")
            ? [
                "createL1Provider",
                "findDeposit",
                "readDepositHistory",
                "sendWithdrawal",
                "submitDeposit",
                "verifyPortal",
                "verifyWithdrawalReceipt",
                "waitForDepositReceipt",
              ]
            : [
                "checkSponsor",
                "claimDeposit",
                "createAztecBoardSession",
                "depositWasClaimed",
                "publishPost",
                "readStakeInfo",
                "startWithdrawal",
                "withdrawalProof",
              ]
          )
            .map(
              (name) =>
                `export const ${name} = (...args) => globalThis.__notchRecoveryTest.${name}(...args);`
            )
            .join("\n"),
          loader: "js",
        }));
      },
    },
  ],
});
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports
);
const { createWalletFlow } = loaded.exports;

function fixture(t) {
  const names = ["navigator", "localStorage", "window", "__notchRecoveryTest"];
  const previous = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  const values = new Map();
  const f = {
    balance: 0n,
    amount: 0n,
    used: 2,
    nextNonce: 7,
    claimed: new Set(),
    deposits: [],
    sends: 0,
    claims: 0,
    signatures: 0,
    state: null,
  };
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  for (const [name, value] of Object.entries({
    navigator: {
      locks: { request: async (_key, _options, operation) => operation({}) },
    },
    localStorage: storage,
    window: {},
    __notchRecoveryTest: f,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() =>
    names.forEach((name, i) =>
      previous[i]
        ? Object.defineProperty(globalThis, name, previous[i])
        : delete globalThis[name]
    )
  );
  f.injected = {
    async request({ method, params }) {
      if (method === "wallet_requestPermissions")
        return [{ parentCapability: "eth_accounts" }];
      if (method === "eth_accounts") return [payer];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "personal_sign") {
        f.signatures++;
        if (f.signError) throw f.signError;
        return wallet.signMessage(getBytes(params[0]));
      }
      throw Error(`Unexpected wallet operation: ${method}`);
    },
  };
  f.provider = {
    destroy() {},
    getBlockNumber: async () => 50,
    getTransactionCount: async (_payer, block) =>
      f.nextNonce + (f.pendingL1 && block === "pending" ? 1 : 0),
    getLogs: async () =>
      f.deposits.map((job, index) => ({
        ...iface.encodeEventLog(iface.getEvent("Deposited"), [
          payer,
          BigInt(job.amount),
          job.messageKey,
          job.leafIndex,
          job.secretHash,
        ]),
        transactionHash: job.l1Tx,
        blockNumber: 20 + index,
        index,
      })),
    getTransaction: async (hash) => {
      const job = f.deposits.find((job) => job.l1Tx === hash);
      return {
        from: payer,
        to: config.l1Stake.portal,
        nonce: job.nonce,
        value: BigInt(job.amount),
        data: iface.encodeFunctionData("deposit", [job.secretHash]),
      };
    },
  };
  f.addDeposit = (nonce, amount = STAKE_UNIT) => {
    const job = {
      ...deriveDepositSecret(keys, config, payer, nonce, amount.toString()),
      nonce,
      amount: amount.toString(),
      l1Tx: `0x${(nonce + 1).toString(16).padStart(64, "0")}`,
      messageKey: `0x${(nonce + 100).toString(16).padStart(64, "0")}`,
      leafIndex: (nonce + 1).toString(),
    };
    f.deposits.push(job);
    f.balance += amount;
    return job;
  };
  f.portal = { deposits: async () => f.balance };
  f.createL1Provider = () => f.provider;
  f.verifyPortal = async () => f.portal;
  f.readDepositHistory = readDepositHistory;
  f.findDeposit = async (_portal, _payer, secretHash) =>
    f.deposits
      .filter((job) => job.secretHash === secretHash)
      .map((job) => ({ transactionHash: job.l1Tx }));
  f.checkSponsor = async () => {};
  f.submitDeposit = async (
    _portal,
    _injected,
    _payer,
    job,
    _progress,
    before
  ) => {
    if (f.nonceChanged) {
      f.nonceChanged = false;
      f.nextNonce++;
      throw Object.assign(Error("nonce changed"), { code: "NONCE_CHANGED" });
    }
    before();
    f.sends++;
    f.nextNonce++;
    const stored = JSON.parse([...values.values()][0]);
    assert.equal(stored.keyDerivation, "l1-signature-v1");
    assert.equal(stored.deposit.submitted, true);
    const event = f.addDeposit(job.nonce, BigInt(job.amount));
    assert.equal(job.secretHash, event.secretHash);
    return event.l1Tx;
  };
  f.waitForDepositReceipt = async (_provider, _portal, _payer, job) =>
    f.waitPending
      ? null
      : {
          messageKey: f.deposits.find((d) => d.l1Tx === job.l1Tx).messageKey,
          leafIndex: "1",
        };
  f.createAztecBoardSession = async (
    _config,
    _runtime,
    record,
    _progress,
    lifecycle
  ) => {
    const address = await addressOf(record);
    lifecycle.assertActive();
    lifecycle.onAccountReady(address);
    return {
      owner: { toString: () => address },
      wallet: { pxe: { stop: async () => {} } },
    };
  };
  f.readStakeInfo = async () => [
    f.amount,
    BigInt(payer),
    1700000000n,
    f.amount === 0n ? 0n : (f.amount / STAKE_UNIT) * 5n - BigInt(f.used),
  ];
  f.depositWasClaimed = async (_session, _config, job) =>
    f.claimed.has(job.l1Tx);
  f.claimDeposit = async (_session, _config, _payer, job) => {
    f.claims++;
    assert(!f.claimed.has(job.l1Tx));
    f.claimed.add(job.l1Tx);
    f.amount += BigInt(job.amount);
    return "complete";
  };
  f.open = async () => {
    const flow = createWalletFlow(
      config,
      undefined,
      (state) => {
        f.state = state;
      },
      () => {}
    );
    await flow.connect(f.injected);
    return flow;
  };
  return { f, values };
}

test("signature recovery reproduces all three keys and the actual Aztec address across browsers", async () => {
  const again = deriveAccountKeys(
    await wallet.signMessage(accountRecoveryMessage(config, payer)),
    config,
    payer
  );
  assert.deepEqual(again, keys);
  assert.equal(await addressOf(again), expectedAddress);
  for (const alternate of [
    { ...config, board: `0x${"4".repeat(64)}` },
    { ...config, l1Stake: { ...config.l1Stake, chainId: 1 } },
  ]) {
    const scoped = deriveAccountKeys(
      await wallet.signMessage(accountRecoveryMessage(alternate, payer)),
      alternate,
      payer
    );
    assert.notEqual(scoped.secretKey, keys.secretKey);
  }
  assert.throws(
    () =>
      deriveAccountKeys(
        Wallet.createRandom().signingKey.sign(`0x${"ab".repeat(32)}`)
          .serialized,
        config,
        payer
      ),
    /another Ethereum wallet/
  );
  const first = deriveDepositSecret(
    keys,
    config,
    payer,
    7,
    STAKE_UNIT.toString()
  );
  assert.notEqual(
    first.secretHash,
    deriveDepositSecret(keys, config, payer, 8, STAKE_UNIT.toString())
      .secretHash
  );
  assert.notEqual(
    first.secretHash,
    deriveDepositSecret(keys, config, payer, 7, (2n * STAKE_UNIT).toString())
      .secretHash
  );
});

test("new stakes are recoverable before payment and a clean browser restores Ready without paying twice", async (t) => {
  const { f, values } = fixture(t);
  let flow = await f.open();
  await flow.stake(STAKE_UNIT.toString());
  await flow.initializeAztec({});
  assert.equal(f.state.owner, expectedAddress);
  assert.equal(f.state.remaining, 3);
  await flow.stake(STAKE_UNIT.toString());
  assert.equal(f.state.amount, (2n * STAKE_UNIT).toString());
  await flow.disconnect();
  values.clear();
  flow = await f.open();
  await flow.recoverAccount();
  await flow.initializeAztec({});
  assert.equal(f.state.owner, expectedAddress);
  assert.equal(f.state.remaining, 8);
  assert.equal(f.state.pendingDeposit, false);
  assert.equal(f.sends, 2);
  assert.equal(f.claims, 2);
  assert.equal(f.signatures, 2);
});

test("a paid but unclaimed deposit recovers from L1 history and claims once without another payment", async (t) => {
  const { f, values } = fixture(t);
  let flow = await f.open();
  await flow.stake(STAKE_UNIT.toString());
  await flow.disconnect();
  values.clear();
  flow = await f.open();
  // Clicking Stake with an existing balance must recover rather than send another deposit.
  await flow.stake(STAKE_UNIT.toString());
  await flow.initializeAztec({});
  assert.equal(f.sends, 1);
  assert.equal(f.claims, 1);
  assert.equal(f.state.remaining, 3);
  assert.equal(f.state.owner, expectedAddress);
  assert.equal(f.state.pendingDeposit, false);
});

test("recovery skips claimed top-ups, resumes the remaining top-up and preserves used quota", async (t) => {
  const { f } = fixture(t);
  const first = f.addDeposit(1);
  f.addDeposit(2);
  f.amount = STAKE_UNIT;
  f.claimed.add(first.l1Tx);
  const flow = await f.open();
  await flow.recoverAccount();
  await flow.initializeAztec({});
  assert.equal(f.sends, 0);
  assert.equal(f.claims, 1);
  assert.equal(f.state.remaining, 8);
  assert.equal(f.state.pendingDeposit, false);
});

test("rejected signatures and incompatible old deposits never request payment or overwrite keys", async (t) => {
  const { f, values } = fixture(t);
  const flow = await f.open();
  const initial = [...values.values()][0];
  f.signError = Object.assign(Error("Rejected"), { code: 4001 });
  await assert.rejects(flow.stake(STAKE_UNIT.toString()), /Rejected/);
  assert.equal([...values.values()][0], initial);
  assert.equal(f.sends, 0);
  delete f.signError;
  const old = f.addDeposit(1);
  old.secretHash = `0x${"12".repeat(32)}`;
  await assert.rejects(flow.recoverAccount(), /original account backup/);
  assert.equal([...values.values()][0], initial);
  assert.equal(f.sends, 0);
});

test("nonce changes before submission discard only the unsigned job and allow a safe retry", async (t) => {
  const { f, values } = fixture(t);
  const flow = await f.open();
  f.nonceChanged = true;
  await assert.rejects(flow.stake(STAKE_UNIT.toString()), /nonce changed/);
  const saved = JSON.parse([...values.values()][0]);
  assert.equal(saved.deposit, null);
  assert.equal(saved.secretKey, keys.secretKey);
  await flow.stake(STAKE_UNIT.toString());
  assert.equal(f.sends, 1);
  assert.equal(f.deposits[0].nonce, 8);
});

test("recovery checkpoints and derivation version survive export and import", async (t) => {
  const { f, values } = fixture(t);
  f.addDeposit(1);
  f.addDeposit(2);
  const flow = await f.open();
  await flow.recoverAccount();
  const saved = JSON.parse([...values.values()][0]);
  const backup = writeAccountFile(saved, expectedAddress, config);
  const restored = await readAccountFile(
    new File([backup.contents], "account.json"),
    config,
    payer,
    {
      sdk: { Fq },
      deriveAccountAddress: async (secretKey, salt, signingKey) => {
        const address = await addressOf({
          secretKey,
          salt: salt.toString(),
          signingKey: signingKey.toString(),
        });
        return { address: { toString: () => address } };
      },
    }
  );
  assert.equal(restored.keyDerivation, "l1-signature-v1");
  assert.equal(restored.recoveryAmount, (2n * STAKE_UNIT).toString());
  assert.equal(restored.recoveryDeposits.length, 1);
});

test("recovery nullifier checks keep secrets local and treat tree index zero as consumed", async () => {
  const seen = [];
  const session = {
    runtime: {
      sdk: {
        Fr: { fromString: (x) => x },
        AztecAddress: { fromStringUnsafe: (x) => x },
        MerkleTreeId: { NULLIFIER_TREE: 0 },
        computeL1ToL2MessageNullifier: async (message, secret) => {
          seen.push([message, secret]);
          return "nullifier";
        },
        siloNullifier: async (board, nullifier) => {
          seen.push([board, nullifier]);
          return "siloed";
        },
      },
    },
    node: {
      findLeavesIndexes: async (...args) => {
        seen.push(args);
        return [0n];
      },
    },
  };
  assert.equal(
    await depositWasClaimed(session, config, {
      messageKey: "message",
      secret: "secret",
    }),
    true
  );
  assert.deepEqual(seen.at(-1), ["latest", 0, ["siloed"]]);
});

test("history scanning is paged, discards fully withdrawn cycles and rejects inconsistent balances", async () => {
  const pages = [];
  const deposit = (block, nonce) => {
    const claim = deriveDepositSecret(
      keys,
      config,
      payer,
      nonce,
      STAKE_UNIT.toString()
    );
    return {
      ...iface.encodeEventLog(iface.getEvent("Deposited"), [
        payer,
        STAKE_UNIT,
        `0x${"ab".repeat(32)}`,
        nonce,
        claim.secretHash,
      ]),
      blockNumber: block,
      index: 0,
      transactionHash: `0x${nonce.toString(16).padStart(64, "0")}`,
    };
  };
  const logs = [
    deposit(10, 1),
    {
      ...iface.encodeEventLog(iface.getEvent("Withdrawn"), [payer, STAKE_UNIT]),
      blockNumber: 11,
      index: 0,
    },
    deposit(4011, 3),
  ];
  const provider = {
    getBlockNumber: async () => 4020,
    getLogs: async ({ fromBlock, toBlock, topics }) => {
      pages.push([fromBlock, toBlock]);
      assert.equal(topics[0].length, 2);
      return logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
      );
    },
    getTransaction: async () => ({
      from: payer,
      to: config.l1Stake.portal,
      nonce: 3,
      value: STAKE_UNIT,
      data: iface.encodeFunctionData("deposit", [
        deriveDepositSecret(keys, config, payer, 3, STAKE_UNIT.toString())
          .secretHash,
      ]),
    }),
  };
  const active = await readDepositHistory(provider, config, payer, STAKE_UNIT);
  assert.deepEqual(pages, [
    [10, 2009],
    [2010, 4009],
    [4010, 4020],
  ]);
  assert.equal(active.length, 1);
  assert.equal(active[0].nonce, 3);
  await assert.rejects(
    readDepositHistory(provider, config, payer, 2n * STAKE_UNIT),
    /history changed or is incomplete/
  );
  provider.getTransaction = async () => ({
    from: Wallet.createRandom().address,
    to: config.l1Stake.portal,
    nonce: 3,
    value: STAKE_UNIT,
    data: iface.encodeFunctionData("deposit", [active[0].secretHash]),
  });
  await assert.rejects(
    readDepositHistory(provider, config, payer, STAKE_UNIT),
    /transaction mismatch/
  );
});

test("a wallet change during signing cannot save keys or submit funds", async (t) => {
  const { f, values } = fixture(t);
  const flow = await f.open();
  const initial = [...values.values()][0];
  const request = f.injected.request;
  let changed = false;
  f.injected.request = async (args) => {
    if (args.method === "eth_accounts" && changed)
      return [Wallet.createRandom().address];
    const result = await request(args);
    if (args.method === "personal_sign") changed = true;
    return result;
  };
  await assert.rejects(
    flow.stake(STAKE_UNIT.toString()),
    /account or network changed/
  );
  assert.equal(f.sends, 0);
  assert.equal([...values.values()][0], initial);
});

test("recovery stays blocked if consumed messages do not reconstruct the L1 balance", async (t) => {
  const { f } = fixture(t);
  const job = f.addDeposit(1);
  f.claimed.add(job.l1Tx);
  const flow = await f.open();
  await flow.recoverAccount();
  await assert.rejects(flow.initializeAztec({}), /recovery is incomplete/);
  assert.equal(f.state.pendingDeposit, true);
  assert.equal(f.sends, 0);
  await assert.rejects(
    flow.stake(STAKE_UNIT.toString()),
    /recovery is incomplete/
  );
  assert.equal(f.sends, 0);
});

test("a clean browser cannot pay again while an earlier L1 transaction is unconfirmed", async (t) => {
  const { f } = fixture(t);
  const flow = await f.open();
  f.pendingL1 = true;
  await assert.rejects(
    flow.stake(STAKE_UNIT.toString()),
    /L1 transaction is still pending/
  );
  assert.equal(f.sends, 0);
  assert.equal(f.signatures, 0);
});
