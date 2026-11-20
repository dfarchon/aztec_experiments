import assert from "node:assert/strict";
import test from "node:test";

import { Interface, keccak256 } from "ethers";

import {
  portalABI,
  submitDeposit,
  verifyPortal,
  waitForDepositReceipt,
} from "./portal.ts";
import { MAX_STAKE, STAKE_UNIT } from "./stake-policy.ts";

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

test("a confirmed deposit verifies its call and event before returning its message", async () => {
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
  tx.value = 2n * STAKE_UNIT;
  await assert.rejects(
    waitForDepositReceipt(provider, {}, payer, job, config),
    /does not match/
  );
});

test("stake preflight checks the existing deposit once and refuses recovery or cap violations before a wallet prompt", async () => {
  for (const [hasAccount, current, error] of [
    [false, MAX_STAKE, /Restore its account backup/],
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
