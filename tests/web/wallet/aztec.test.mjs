import assert from "node:assert/strict";
import test from "node:test";

import {
  claimDeposit,
  createAztecBoardSession,
  publishPost,
  withdrawalProof,
} from "../../../web/src/features/wallet/aztec.ts";

const config = {
  environment: "local",
  board: "board",
  sponsorSalt: "0",
  sponsoredFpc: "sponsor",
  l1Stake: { portal: "portal" },
};
const record = () => ({
  secretKey: "0x01",
  salt: "1",
  signingKey: "0x02",
  amount: "0",
});
function setupFixture(t) {
  let active = true,
    stops = 0;
  const events = [];
  const wallet = {
    pxe: {
      stop: async () => {
        stops++;
      },
    },
    registerContract: async (instance) => {
      events.push(`registered:${instance.address}`);
    },
  };
  const board = {
    methods: { get_l1_portal: () => ({ simulate: async () => "portal" }) },
  };
  const runtime = {
    sdk: {
      SDK_VERSION: "6.0.0",
      Fq: { fromString: (x) => x },
      Fr: class {},
      AztecAddress: { fromStringUnsafe: (x) => x },
      loadContractArtifact: (x) => x,
      getContractClassFromArtifact: async () => ({ id: "class" }),
      Contract: { at: async () => board },
      SponsoredFeePaymentMethod: class {
        constructor(address) {
          this.address = address;
        }
      },
    },
    setupAccount: async (state) => {
      state.instance = {
        currentContractClassId: { toString: () => "account-class" },
      };
      state.wallet = wallet;
      state.address = { toString: () => "original-address" };
      state.aztecNode = {
        getContract: async (address) => ({
          address,
          currentContractClassId: {
            equals: () => true,
            toString: () => "class",
          },
        }),
      };
      return true;
    },
  };
  t.mock.method(globalThis, "fetch", async () => {
    events.push("fetch");
    return { ok: true, json: async () => ({}) };
  });
  const saved = record();
  const lifecycle = {
    assertActive: () => {
      if (!active) throw Error("Wallet session ended");
    },
    onAccountReady: (address) => {
      saved.address = address;
      events.push("saved");
    },
  };
  return {
    runtime,
    saved,
    lifecycle,
    events,
    wallet,
    cancel: () => {
      active = false;
    },
    stops: () => stops,
  };
}

test("setup saves the derived address before artifacts and transfers the live PXE only on success", async (t) => {
  const f = setupFixture(t);
  const session = await createAztecBoardSession(
    config,
    f.runtime,
    f.saved,
    () => {},
    f.lifecycle
  );
  assert.equal(session.wallet, f.wallet);
  assert.equal(f.saved.address, "original-address");
  assert.equal(f.events[0], "saved");
  assert.equal(f.stops(), 0);
  assert.equal(session.payment.address, "sponsor");
  assert(f.events.includes("registered:sponsor"));
});

test("mainnet setup uses the supplied FPC instance without deriving a testnet address", async (t) => {
  const f = setupFixture(t);
  const mainnet = {
    ...config,
    environment: "mainnet",
    sponsoredFpc: "maintained-mainnet-fpc",
    sponsorSalt: undefined,
  };
  const setup = f.runtime.setupAccount;
  f.runtime.setupAccount = async (state, options) => {
    assert.equal(options.proverEnabled, true);
    return setup(state);
  };
  const session = await createAztecBoardSession(
    mainnet,
    f.runtime,
    f.saved,
    () => {},
    f.lifecycle
  );
  assert.equal(session.payment.address, mainnet.sponsoredFpc);
  assert(f.events.includes(`registered:${mainnet.sponsoredFpc}`));
});

test("a wrong FPC class stops setup and closes the PXE", async (t) => {
  const f = setupFixture(t);
  const setup = f.runtime.setupAccount;
  f.runtime.setupAccount = async (state) => {
    await setup(state);
    const getContract = state.aztecNode.getContract;
    state.aztecNode.getContract = async (address) =>
      address === "sponsor"
        ? { address, currentContractClassId: { toString: () => "wrong-class" } }
        : getContract(address);
    return true;
  };
  await assert.rejects(
    createAztecBoardSession(config, f.runtime, f.saved, () => {}, f.lifecycle),
    /FPC class/
  );
  assert.equal(f.stops(), 1);
  assert(!f.events.includes("registered:sponsor"));
});

test("mainnet posting uses the maintained sponsor without a balance precheck", async () => {
  let sent;
  class GasFees {
    constructor(da, l2) {
      this.feePerDaGas = da;
      this.feePerL2Gas = l2;
    }
  }
  const session = {
    runtime: {
      sdk: {
        GasFees,
        getFeeJuiceBalance: async () => {
          throw new Error("Mainnet balance should not be queried");
        },
      },
    },
    node: {
      getBlock: async () => ({
        header: {
          globalVariables: { gasFees: { feePerDaGas: 1n, feePerL2Gas: 1n } },
        },
      }),
      getPredictedMinFees: async () => [{ feePerDaGas: 1n, feePerL2Gas: 1n }],
    },
    payment: "maintained-fpc",
    board: {
      methods: {
        post: () => ({
          send: async (options) => {
            sent = options;
            return { receipt: { executionResult: "success" } };
          },
        }),
      },
    },
  };
  await publishPost(
    session,
    { ...config, environment: "mainnet" },
    "Hello mainnet",
    "owner"
  );
  assert.equal(sent.from, "owner");
  assert.equal(sent.fee.paymentMethod, session.payment);
});

test("artifact failures stop the unreturned PXE while preserving account identity", async (t) => {
  const f = setupFixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("Artifact download failed");
  });
  await assert.rejects(
    createAztecBoardSession(config, f.runtime, f.saved, () => {}, f.lifecycle),
    /Artifact download failed/
  );
  assert.equal(f.saved.address, "original-address");
  assert.equal(f.stops(), 1);
});

test("disposal during setup stops its PXE without fetching artifacts or saving late identity", async (t) => {
  const f = setupFixture(t);
  const setup = f.runtime.setupAccount;
  f.runtime.setupAccount = async (state) => {
    await setup(state);
    f.cancel();
    return true;
  };
  await assert.rejects(
    createAztecBoardSession(config, f.runtime, f.saved, () => {}, f.lifecycle),
    /Wallet session ended/
  );
  assert.deepEqual(f.events, []);
  assert.equal(f.saved.address, undefined);
  assert.equal(f.stops(), 1);
});

test("partial setup and cleanup failures preserve the original failure", async (t) => {
  const f = setupFixture(t);
  let cleanupCalls = 0;
  f.runtime.setupAccount = async (state) => {
    state.pxe = {
      stop: async () => {
        cleanupCalls++;
        throw Error("Stop failed");
      },
    };
    throw Error("Setup failed");
  };
  await assert.rejects(
    createAztecBoardSession(config, f.runtime, f.saved, () => {}, f.lifecycle),
    /Setup failed/
  );
  assert.equal(cleanupCalls, 1);
});

test("disposal during artifact loading prevents contract registration and closes the PXE", async (t) => {
  const f = setupFixture(t);
  let registrations = 0;
  f.wallet.registerContract = async () => {
    registrations++;
  };
  t.mock.method(globalThis, "fetch", async () => {
    f.cancel();
    return { ok: true, json: async () => ({}) };
  });
  await assert.rejects(
    createAztecBoardSession(config, f.runtime, f.saved, () => {}, f.lifecycle),
    /Wallet session ended/
  );
  assert.equal(registrations, 0);
  assert.equal(f.stops(), 1);
});

function claimFixture() {
  let active = true,
    witnesses = 0,
    warps = 0,
    simulations = 0,
    sends = 0;
  const job = {
    messageKey: "key",
    leafIndex: "1",
    secret: "secret",
    amount: "500000000000000",
    l2Attempted: false,
    l2Tx: null,
  };
  const call = {
    simulate: async () => {
      simulations++;
    },
    send: async () => {
      sends++;
      throw Error("Unexpected send");
    },
  };
  const session = {
    runtime: {
      sdk: {
        Fr: { fromString: (x) => x },
        EthAddress: { fromString: (x) => x },
        AztecAddress: { fromStringUnsafe: (x) => x },
        createAztecNodeDebugClient: () => ({
          warpL2TimeAtLeastBy: async () => {
            warps++;
          },
        }),
        getFeeJuiceBalance: async () => 1n,
        GasFees: class {},
      },
    },
    node: {
      getL1ToL2MessageMembershipWitness: async () => {
        witnesses++;
        return false;
      },
      getBlock: async () => ({
        header: {
          globalVariables: { gasFees: { feePerDaGas: 1n, feePerL2Gas: 1n } },
        },
      }),
      getPredictedMinFees: async () => [{ feePerDaGas: 1n, feePerL2Gas: 1n }],
    },
    board: { methods: { claim_deposit: () => call } },
    wallet: {},
    owner: "owner",
  };
  return {
    job,
    session,
    call,
    cancel: () => {
      active = false;
    },
    assertActive: () => {
      if (!active) throw Error("Session cancelled");
    },
    counts: () => ({ witnesses, warps, simulations, sends }),
  };
}

test("a cancelled claim performs no RPC or submission", async () => {
  const f = claimFixture();
  f.cancel();
  await assert.rejects(
    claimDeposit(
      f.session,
      config,
      "payer",
      f.job,
      () => {},
      () => {},
      f.assertActive
    ),
    /Session cancelled/
  );
  assert.deepEqual(f.counts(), {
    witnesses: 0,
    warps: 0,
    simulations: 0,
    sends: 0,
  });
});

test("cancellation while awaiting a witness prevents time advancement and claiming", async () => {
  const f = claimFixture();
  f.session.node.getL1ToL2MessageMembershipWitness = async () => {
    f.cancel();
    return true;
  };
  await assert.rejects(
    claimDeposit(
      f.session,
      config,
      "payer",
      f.job,
      () => {},
      () => {},
      f.assertActive
    ),
    /Session cancelled/
  );
  assert.equal(f.counts().warps, 0);
  assert.equal(f.counts().sends, 0);
});

test("cancellation during a polling delay stops the next poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = claimFixture();
  const pending = assert.rejects(
    claimDeposit(
      f.session,
      config,
      "payer",
      f.job,
      () => {},
      () => {},
      f.assertActive
    ),
    /Session cancelled/
  );
  await new Promise((resolve) => setImmediate(resolve));
  f.cancel();
  t.mock.timers.tick(1000);
  await pending;
  assert.deepEqual(f.counts(), {
    witnesses: 1,
    warps: 1,
    simulations: 0,
    sends: 0,
  });
});

test("cancellation during simulation prevents persisting or sending a claim", async () => {
  const f = claimFixture();
  let writes = 0;
  f.session.node.getL1ToL2MessageMembershipWitness = async () => true;
  f.call.simulate = async () => f.cancel();
  await assert.rejects(
    claimDeposit(
      f.session,
      config,
      "payer",
      f.job,
      () => {
        writes++;
      },
      () => {},
      f.assertActive
    ),
    /Session cancelled/
  );
  assert.equal(writes, 0);
  assert.equal(f.job.l2Attempted, false);
  assert.equal(f.counts().sends, 0);
});

test("withdrawal proof absence is pending, while reverted transactions remain errors", async () => {
  let executionResult = "success";
  const session = {
    runtime: { sdk: { TxHash: { fromString: (hash) => hash } } },
    node: {
      getTxReceipt: async () => ({ executionResult }),
      getTxEffect: async () => ({
        data: { l2ToL1Msgs: [{ isZero: () => false }] },
      }),
      getL2ToL1MembershipWitness: async () => undefined,
    },
  };
  assert.equal(await withdrawalProof(session, "saved-exit"), null);
  executionResult = "reverted";
  await assert.rejects(
    withdrawalProof(session, "saved-exit"),
    /withdrawal reverted/
  );
});
