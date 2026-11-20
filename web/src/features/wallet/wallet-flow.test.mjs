import assert from "node:assert/strict";
import test from "node:test";

import { readAccountFile, writeAccountFile } from "./account-files.ts";
import { hashDepositSecret } from "./deposit-secret.ts";
import {
  MAX_STAKE,
  postQuota,
  STAKE_UNIT,
  validateTopup,
} from "./stake-policy.ts";
import { createWalletFlow } from "./wallet-flow.ts";

const payer = `0x${"2".repeat(40)}`;
const board = `0x${"1".repeat(64)}`;
const config = {
  kind: "notch-stake",
  environment: "local",
  nodeUrl: "http://127.0.0.1:5180",
  rollupAddress: `0x${"3".repeat(64)}`,
  rollupVersion: 1,
  board,
  l1Stake: {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:5954",
    portal: `0x${"4".repeat(40)}`,
  },
};

function provider() {
  return {
    request: async ({ method }) =>
      method === "eth_requestAccounts" || method === "eth_accounts"
        ? [payer]
        : method === "eth_chainId"
          ? "0x7a69"
          : (() => {
              throw new Error(`Unexpected wallet call: ${method}`);
            })(),
  };
}

function installWalletGlobals(t) {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: { request: async (_name, _options, operation) => operation({}) },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  t.after(() => {
    for (const [name, descriptor] of [
      ["navigator", oldNavigator],
      ["localStorage", oldStorage],
      ["window", oldWindow],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return values;
}

test("stake tiers unlock five rolling daily posts per 0.0005 ETH", () => {
  assert.equal(STAKE_UNIT, 500_000_000_000_000n);
  assert.equal(MAX_STAKE, 2_000_000_000_000_000n);
  for (let tier = 0; tier <= 4; tier++) {
    assert.equal(postQuota(BigInt(tier) * STAKE_UNIT), tier * 5);
  }
});

test("top-ups can arrive in steps but never exceed the per-wallet cap", () => {
  validateTopup(STAKE_UNIT, 0n);
  validateTopup(STAKE_UNIT, 3n * STAKE_UNIT);
  validateTopup(4n * STAKE_UNIT, 0n);
  for (const [amount, current] of [
    [0n, 0n],
    [STAKE_UNIT - 1n, 0n],
    [STAKE_UNIT + 1n, 0n],
    [STAKE_UNIT, MAX_STAKE],
    [4n * STAKE_UNIT, STAKE_UNIT],
    [STAKE_UNIT, -1n],
  ]) {
    assert.throws(() => validateTopup(amount, current), /Stake must/);
  }
});

test("L1 connection and stake selection need no Aztec account or runtime", async (t) => {
  const values = installWalletGlobals(t);
  let state;
  const posting = createWalletFlow(
    config,
    undefined,
    (value) => {
      state = value;
    },
    () => {}
  );
  await posting.connect(provider());
  assert.equal(state.payer, payer);
  assert.equal(state.owner, "");
  assert.equal(state.aztecReady, false);
  await assert.rejects(
    posting.initializeAztec(),
    /Stake before initializing Aztec/
  );
  await posting.selectStakeAmount((2n * STAKE_UNIT).toString());
  assert.equal(state.stakeChoice, (2n * STAKE_UNIT).toString());
  assert.equal(state.pendingDeposit, false);
  const [key, stored] = [...values][0];
  assert.match(key, /^notch-stake\/6\.0\.0\//);
  assert.equal(JSON.parse(stored).stakeChoice, (2n * STAKE_UNIT).toString());
  await posting.disconnect();
  await posting.connect(provider());
  assert.equal(state.stakeChoice, (2n * STAKE_UNIT).toString());
  assert.equal(state.pendingDeposit, false);
  assert.equal(state.owner, "");
});

test("versioned account exports restore on a clean browser without payment", async (t) => {
  const values = installWalletGlobals(t);
  const key = `notch-stake/6.0.0/${board}/${payer}`;
  const aztecAddress = `0x${"a".repeat(64)}`;
  values.set(
    key,
    JSON.stringify({
      payer,
      secretKey: "0x15",
      salt: "9",
      signingKey: "0x24",
      address: aztecAddress,
      amount: (2n * STAKE_UNIT).toString(),
      remaining: 9,
      lastPost: "1700000000",
      deposit: null,
      exit: null,
      stakeChoice: STAKE_UNIT.toString(),
    })
  );
  const source = createWalletFlow(
    config,
    undefined,
    () => {},
    () => {}
  );
  await source.connect(provider());
  const exported = source.backup();
  assert(exported);
  const parsed = JSON.parse(exported.contents);
  assert.equal(parsed.kind, "notch-account");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.network.rollupAddress, config.rollupAddress);
  assert.equal(parsed.amount, (2n * STAKE_UNIT).toString());
  await source.disconnect();

  values.clear();
  const imported = createWalletFlow(
    config,
    undefined,
    () => {},
    () => {}
  );
  await imported.connect(provider());
  const runtime = {
    sdk: { Fq: { fromString: (value) => value } },
    createAztecNodeClient: () => ({}),
    deriveAccountAddress: async () => ({
      address: { toString: () => aztecAddress },
    }),
    setupAccount: async () => {
      throw new Error("Reached private setup");
    },
  };
  const file = (contents) =>
    new File([contents], "notch-account.json", {
      type: "application/json",
    });
  await assert.rejects(
    imported.restore(file("{broken"), runtime),
    /valid JSON/
  );
  await assert.rejects(
    imported.restore(
      file(
        JSON.stringify({
          ...parsed,
          network: { ...parsed.network, l1ChainId: 1 },
        })
      ),
      runtime
    ),
    /another network/
  );
  await imported.restore(file(exported.contents), runtime);
  const stored = JSON.parse(values.get(key));
  assert.equal(stored.amount, "0");
  assert.equal(stored.importedAmountHint, (2n * STAKE_UNIT).toString());
  assert.equal(stored.secretKey, "0x15");

  await assert.rejects(
    imported.initializeAztec(runtime),
    /Reached private setup/
  );
  await imported.disconnect();
});

test("silent connection only checks authorization and never requests approval or network switching", async (t) => {
  installWalletGlobals(t);
  let state;
  const posting = createWalletFlow(
    config,
    undefined,
    (value) => {
      state = value;
    },
    () => {}
  );
  const methods = [];
  const injected = {
    request: async ({ method }) => {
      methods.push(method);
      if (method === "eth_accounts") return [payer];
      if (method === "eth_chainId") return "0x7a69";
      throw Error("Unexpected wallet prompt: " + method);
    },
  };
  await posting.connect(injected, { payer });
  assert.equal(state.payer, payer);
  assert.deepEqual(methods, ["eth_accounts", "eth_chainId"]);
  await posting.disconnect();
  assert.equal(
    await posting.connect(injected, { payer: "0x" + "9".repeat(40) }),
    false
  );
  assert.equal(state.payer, "");
  await posting.disconnect();
});

test("versioned and legacy exports preserve string-valued pending transactions", async () => {
  const address = "0x" + "a".repeat(64);
  const runtime = {
    sdk: { Fq: { fromString: (value) => value } },
    deriveAccountAddress: async () => ({
      address: { toString: () => address },
    }),
  };
  const deposit = {
    amount: STAKE_UNIT.toString(),
    secret: "0x07",
    secretHash: hashDepositSecret(7n),
    submitted: true,
    l1Tx: "saved-l1",
    l2Tx: null,
    l2Attempted: false,
  };
  const exit = {
    amount: STAKE_UNIT.toString(),
    l1Tx: null,
    l2Tx: "saved-l2",
    l2Attempted: true,
  };
  for (const pending of [
    { deposit, exit: null },
    { deposit: null, exit },
  ]) {
    const record = {
      payer,
      secretKey: "0x01",
      salt: "1",
      signingKey: "0x02",
      amount: STAKE_UNIT.toString(),
      ...pending,
    };
    const backup = JSON.parse(
      writeAccountFile(record, address, config).contents
    );
    for (const legacy of [false, true]) {
      const file = { ...backup };
      if (legacy) {
        delete file.kind;
        delete file.version;
        delete file.network;
      }
      const restored = await readAccountFile(
        new File([JSON.stringify(file)], "account.json"),
        config,
        payer,
        runtime
      );
      assert.deepEqual(restored.deposit, pending.deposit);
      assert.deepEqual(restored.exit, pending.exit);
      assert.equal(restored.address, address);
    }
    const field = pending.deposit ? "deposit" : "exit";
    backup[field].amount = 500000000000000;
    await assert.rejects(
      readAccountFile(
        new File([JSON.stringify(backup)], "invalid.json"),
        config,
        payer,
        runtime
      ),
      /Backup/
    );
  }
});
