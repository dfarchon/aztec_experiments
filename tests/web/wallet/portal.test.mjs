import assert from "node:assert/strict";
import test from "node:test";

import { Interface, keccak256, zeroPadValue } from "ethers";

import {
  findDeposit,
  portalABI,
  readDepositHistory,
  submitDeposit,
  verifyPortal,
  waitForDepositReceipt,
} from "../../../web/src/features/wallet/portal.ts";
import {
  MAX_STAKE,
  STAKE_UNIT,
} from "../../../web/src/features/wallet/stake-policy.ts";

const address = (digit) => `0x${digit.repeat(40)}`;
const payer = address("1"),
  inbox = address("2"),
  rollup = address("3"),
  portalAddress = address("4");
const board = `0x${"5".repeat(64)}`;
const config = {
  environment: "local",
  nodeUrl: "http://127.0.0.1:5180",
  rollupAddress: rollup,
  rollupVersion: 1,
  board,
  l1Stake: {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:5954",
    portal: portalAddress,
    inbox,
    runtimeCodeHash: keccak256("0x1234"),
  },
};
const iface = new Interface(portalABI);

test("portal verification requires matching node and portal Inbox addresses", async (t) => {
  let nodeInbox = inbox,
    contractInbox = inbox,
    calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          l1ChainId: 31337,
          nodeVersion: "6.0.0",
          realProofs: false,
          rollupVersion: 1,
          l1ContractAddresses: {
            rollupAddress: rollup,
            inboxAddress: nodeInbox,
          },
        },
      })
    );
  });
  const provider = {
    getNetwork: async () => ({ chainId: 31337n }),
    getCode: async () => "0x1234",
    call: async ({ data }) => {
      calls++;
      const name = iface.parseTransaction({ data }).name;
      const result = {
        board,
        INBOX: contractInbox,
        ROLLUP_VERSION: 1n,
        MAX_STAKE,
      }[name];
      return iface.encodeFunctionResult(name, [result]);
    },
  };
  await verifyPortal(provider, config);
  assert.equal(calls, 4);
  nodeInbox = address("9");
  calls = 0;
  await assert.rejects(
    verifyPortal(provider, config),
    /Stake portal or network mismatch/
  );
  assert.equal(calls, 0);
  nodeInbox = inbox;
  contractInbox = address("8");
  await assert.rejects(
    verifyPortal(provider, config),
    /linked to another board/
  );
});

test("a reverted deposit reports the L1 revert before reading transaction data", async () => {
  let reads = 0;
  const provider = {
    waitForTransaction: async () => ({ status: 0 }),
    getTransaction: async () => {
      reads++;
    },
  };
  await assert.rejects(
    waitForDepositReceipt(provider, {}, payer, { l1Tx: "known" }, config),
    /Deposit reverted on L1/
  );
  assert.equal(reads, 0);
});

test("a confirmed deposit verifies the Portal event before returning its message", async () => {
  const job = {
    l1Tx: "known",
    amount: STAKE_UNIT.toString(),
    secretHash: `0x${"6".repeat(64)}`,
  };
  const key = `0x${"7".repeat(64)}`;
  const event = iface.encodeEventLog(iface.getEvent("Deposited"), [
    payer,
    STAKE_UNIT,
    key,
    1n,
    job.secretHash,
  ]);
  const tx = {
    to: portalAddress,
    from: payer,
    value: STAKE_UNIT,
    data: iface.encodeFunctionData("deposit", [job.secretHash]),
  };
  const provider = {
    waitForTransaction: async () => ({
      status: 1,
      logs: [{ address: portalAddress, ...event }],
    }),
    getTransaction: async () => tx,
  };
  assert.deepEqual(
    await waitForDepositReceipt(provider, {}, payer, job, config),
    { messageKey: key, leafIndex: "1" }
  );
  job.amount = (2n * STAKE_UNIT).toString();
  await assert.rejects(
    waitForDepositReceipt(provider, {}, payer, job, config),
    /does not match/
  );
});

test("stake preflight checks the existing deposit once and refuses recovery or cap violations before a wallet prompt", async () => {
  for (const [hasAccount, current, error] of [
    [false, MAX_STAKE, /Continue setup/],
    [true, MAX_STAKE, /0.002 ETH cap/],
  ]) {
    let reads = 0,
      prompts = 0;
    const portal = {
      deposits: async () => {
        reads++;
        return current;
      },
    };
    const injected = {
      request: async () => {
        prompts++;
        throw Error("Unexpected approval");
      },
    };
    await assert.rejects(
      submitDeposit(
        portal,
        injected,
        payer,
        { amount: STAKE_UNIT.toString() },
        () => {},
        () => {},
        hasAccount
      ),
      error
    );
    assert.equal(reads, 1);
    assert.equal(prompts, 0);
  }
});

test("recoverable deposits bind gas estimation and submission to the signed nonce", async () => {
  let nonce = 7;
  const overrides = [];
  const deposit = async (_hash, options) => {
    overrides.push(options);
    return { hash: "l1-hash" };
  };
  deposit.estimateGas = async (_hash, options) => {
    overrides.push(options);
    return 50000n;
  };
  const portal = { deposits: async () => 0n, connect: () => ({ deposit }) };
  const injected = {
    request: async ({ method }) => {
      if (method === "eth_accounts") return [payer];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_getTransactionCount")
        return `0x${nonce.toString(16)}`;
      throw Error(`Unexpected wallet call: ${method}`);
    },
  };
  const job = {
    amount: STAKE_UNIT.toString(),
    secretHash: `0x${"a".repeat(64)}`,
    nonce: 7,
  };
  let submitted = false;
  assert.equal(
    await submitDeposit(
      portal,
      injected,
      payer,
      job,
      () => {},
      () => {
        submitted = true;
      },
      true
    ),
    "l1-hash"
  );
  assert(submitted);
  assert.deepEqual(overrides, [
    { value: STAKE_UNIT, nonce: 7 },
    { value: STAKE_UNIT, nonce: 7 },
  ]);
  nonce = 8;
  submitted = false;
  overrides.length = 0;
  await assert.rejects(
    submitDeposit(
      portal,
      injected,
      payer,
      job,
      () => {},
      () => {
        submitted = true;
      },
      true
    ),
    (error) => error.code === "NONCE_CHANGED"
  );
  assert(!submitted);
  assert.deepEqual(overrides, []);
});

test("historical log reads split at 10,000 blocks and shrink to a provider range cap", async () => {
  const secretHash = `0x${"6".repeat(64)}`;
  const l1Tx = `0x${"8".repeat(64)}`;
  const deposit = {
    ...iface.encodeEventLog(iface.getEvent("Deposited"), [
      payer,
      STAKE_UNIT,
      `0x${"7".repeat(64)}`,
      1n,
      secretHash,
    ]),
    blockNumber: 100,
    index: 0,
    transactionHash: l1Tx,
  };
  const pages = [];
  const provider = {
    getBlockNumber: async () => 2500,
    getTransactionReceipt: async () => ({
      status: 1,
      logs: [{ ...deposit, address: portalAddress }],
    }),
    getLogs: async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 1000)
        throw Object.assign(
          new Error("ranges over 1000 blocks are not supported on free plan"),
          { code: 35 }
        );
      pages.push([fromBlock, toBlock]);
      return fromBlock <= 100 && toBlock >= 100 ? [deposit] : [];
    },
    getTransaction: async () => ({
      from: payer,
      to: portalAddress,
      nonce: 4,
      value: STAKE_UNIT,
      data: iface.encodeFunctionData("deposit", [secretHash]),
    }),
  };
  const active = await readDepositHistory(
    provider,
    { ...config, l1Stake: { ...config.l1Stake, deploymentBlock: 0 } },
    payer,
    STAKE_UNIT
  );
  assert.deepEqual(pages, [
    [0, 624],
    [625, 1249],
    [1250, 1874],
    [1875, 2499],
    [2500, 2500],
  ]);
  assert.equal(active.length, 1);
  assert.equal(active[0].nonce, 4);
});

test("an archive-only L1 RPC reports an actionable log error", async () => {
  const provider = {
    getBlockNumber: async () => 100,
    getLogs: async () => {
      throw Object.assign(new Error("could not coalesce error"), {
        info: {
          error: {
            code: -32602,
            message:
              "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
          },
        },
      });
    },
  };
  await assert.rejects(
    readDepositHistory(
      provider,
      { ...config, l1Stake: { ...config.l1Stake, deploymentBlock: 0 } },
      payer,
      STAKE_UNIT
    ),
    /historical logs required for wallet recovery/
  );
});

test("rate limits and timeouts fail once without shrinking the range", async () => {
  for (const [message, expected] of [
    ["Too Many Requests", /rate-limiting historical log reads/],
    ["upstream timeout", /timed out while reading historical logs/],
  ]) {
    let calls = 0;
    const provider = {
      getBlockNumber: async () => 20_500,
      getLogs: async () => {
        calls++;
        throw new Error(message);
      },
    };
    await assert.rejects(
      readDepositHistory(
        provider,
        { ...config, l1Stake: { ...config.l1Stake, deploymentBlock: 0 } },
        payer,
        STAKE_UNIT
      ),
      expected
    );
    assert.equal(calls, 1);
  }
});

test("an RPC behind the deployment block fails before requesting logs", async () => {
  let calls = 0;
  const provider = {
    getBlockNumber: async () => 99,
    getLogs: async () => {
      calls++;
      return [];
    },
  };
  await assert.rejects(
    readDepositHistory(
      provider,
      { ...config, l1Stake: { ...config.l1Stake, deploymentBlock: 100 } },
      payer,
      STAKE_UNIT
    ),
    /not synchronized to the configured deployment block/
  );
  assert.equal(calls, 0);
});

test("deposit lookup scans bounded ranges with payer and secret topics", async () => {
  const secretHash = `0x${"6".repeat(64)}`;
  const pages = [];
  const provider = {
    getBlockNumber: async () => 20_500,
    getLogs: async ({ fromBlock, toBlock, topics }) => {
      pages.push([fromBlock, toBlock]);
      assert.deepEqual(topics.slice(1), [
        zeroPadValue(payer, 32),
        null,
        secretHash,
      ]);
      return [];
    },
  };
  const matches = await findDeposit(
    provider,
    { ...config, l1Stake: { ...config.l1Stake, deploymentBlock: 5 } },
    payer,
    secretHash
  );
  assert.deepEqual(pages, [
    [5, 10_004],
    [10_005, 20_004],
    [20_005, 20_500],
  ]);
  assert.deepEqual(matches, []);
});

test("mainnet type-4 deposit confirms and recovers using its actual Portal event", async () => {
  // Public transaction 0xf1669408982307824c92cd1928692f7858eab8902a2c33e2ea3889a570e40d3e.
  const sender = "0x702566bed3cdf6804cb807f3489dfe567a6a1cbf";
  const portal = "0x472b1dc69736c9b6034ce7aabba1ff5f7f16307a";
  const deployment = {
    ...config,
    l1Stake: { ...config.l1Stake, portal, deploymentBlock: 26507083 },
  };
  const job = {
    l1Tx: "0xf1669408982307824c92cd1928692f7858eab8902a2c33e2ea3889a570e40d3e",
    amount: STAKE_UNIT.toString(),
    secretHash:
      "0x233bc46be13d3a56adc4997391d21a8fd1c51119411c96b320f3e82c78042d7d",
    nonce: 21,
  };
  const key =
    "0x00010ecba63f32714ec0ad1e2ebb6407756e1e3d4722494ca48e02f98e08820a";
  const log = {
    address: portal,
    transactionHash: job.l1Tx,
    blockNumber: 26507083,
    index: 0,
    ...iface.encodeEventLog(iface.getEvent("Deposited"), [
      sender,
      STAKE_UNIT,
      key,
      1637n,
      job.secretHash,
    ]),
  };
  const receipt = { status: 1, logs: [log] };
  const provider = {
    waitForTransaction: async () => receipt,
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 26507083,
    getLogs: async () => [log],
    getTransaction: async () => ({
      from: sender,
      to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
      value: 0n,
      data: "0x",
      type: 4,
      nonce: 22,
    }),
  };
  assert.deepEqual(
    await waitForDepositReceipt(provider, {}, sender, job, deployment),
    { messageKey: key, leafIndex: "1637" }
  );
  const active = await readDepositHistory(
    provider,
    deployment,
    sender,
    STAKE_UNIT
  );
  assert.equal(active[0].secretHash, job.secretHash);
  assert.equal(active[0].nonce, 22);
  for (const wrong of [
    { amount: (2n * STAKE_UNIT).toString() },
    { secretHash: `0x${"9".repeat(64)}` },
  ]) {
    await assert.rejects(
      waitForDepositReceipt(
        provider,
        {},
        sender,
        { ...job, ...wrong },
        deployment
      ),
      /Deposit receipt does not match/
    );
  }
  await assert.rejects(
    waitForDepositReceipt(provider, {}, payer, job, deployment),
    /Deposit receipt does not match/
  );
  log.address = address("9");
  await assert.rejects(
    waitForDepositReceipt(provider, {}, sender, job, deployment),
    /Deposit receipt does not match/
  );
  log.address = portal;
  receipt.status = 0;
  await assert.rejects(
    waitForDepositReceipt(provider, {}, sender, job, deployment),
    /reverted/
  );
  receipt.status = 1;
  provider.getTransaction = async () => null;
  await assert.rejects(
    readDepositHistory(provider, deployment, sender, STAKE_UNIT),
    /still syncing/
  );
});
