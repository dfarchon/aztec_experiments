import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import {
  readRequestReceipt,
  recoverRequest,
  requestABI,
  requestCommitment,
} from "./l1-request-core.ts";

test("commitment matches Noir vector and binds body, salt and owner", () => {
  const expected =
    "0x00d54d44ffea3f9915c55df999bf41127de33c1f49d9c7fef71a17aee13aa70f";
  assert.equal(requestCommitment("hi", "0x07", "0x09"), expected);
  assert.notEqual(requestCommitment("bye", "0x07", "0x09"), expected);
  assert.notEqual(requestCommitment("hi", "0x08", "0x09"), expected);
  assert.notEqual(requestCommitment("hi", "0x07", "0x0a"), expected);
  assert.throws(() => requestCommitment("", "0x07", "0x09"));
  assert.throws(() => requestCommitment("中".repeat(171), "0x07", "0x09"));
});

test("recovery authenticates zero value, target, calldata and matching receipt event", async () => {
  const hex = (value) => "0x" + value.toString(16).padStart(64, "0");
  const entry = "0x" + "11".repeat(20);
  const config = { board: hex(2), l1: { entry } };
  const iface = new Interface(requestABI);
  const original = { l1Tx: hex(10), commitment: hex(3), secretHash: hex(4) };
  const log = {
    address: entry,
    ...iface.encodeEventLog(iface.getEvent("PostRequested"), [
      config.board,
      hex(5),
      16,
      hex(3),
      hex(4),
    ]),
  };
  let tx = {
    to: entry,
    value: 0n,
    data: iface.encodeFunctionData("requestPost", [
      config.board,
      hex(3),
      hex(4),
    ]),
  };
  let receipt = { status: 1, logs: [log] };
  const rpc = {
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
  };
  const job = { ...original };
  const saved = {
    commitment: original.commitment,
    secretHash: original.secretHash,
  };
  const recovered = await recoverRequest(config, saved, rpc, original.l1Tx);
  assert.equal(recovered.messageKey, hex(5));
  assert.equal(saved.l1Tx, undefined, "Recovery must not mutate saved data");
  assert(await readRequestReceipt(config, job, rpc));
  assert.equal(job.messageKey, hex(5));
  assert.equal(job.leafIndex, "16");
  tx = { ...tx, value: 1n };
  await assert.rejects(
    () => recoverRequest(config, saved, rpc, original.l1Tx),
    /match/
  );
  assert.equal(
    saved.l1Tx,
    undefined,
    "Invalid hash must not lock out correction"
  );
  await assert.rejects(
    () => readRequestReceipt(config, { ...original }, rpc),
    /match/
  );
  tx = { ...tx, value: 0n, to: "0x" + "22".repeat(20) };
  await assert.rejects(
    () => readRequestReceipt(config, { ...original }, rpc),
    /match/
  );
  tx = { ...tx, to: entry };
  receipt = { status: 0, logs: [] };
  await assert.rejects(
    () => readRequestReceipt(config, { ...original }, rpc),
    /reverted/
  );
  receipt = { status: 1, logs: [{ ...log, address: "0x" + "22".repeat(20) }] };
  await assert.rejects(
    () => readRequestReceipt(config, { ...original }, rpc),
    /mismatch/
  );
  receipt = null;
  assert.equal(await readRequestReceipt(config, { ...original }, rpc), false);
  await assert.rejects(
    () => recoverRequest(config, saved, rpc, original.l1Tx),
    /尚未确认/
  );
  await assert.rejects(
    () => recoverRequest(config, saved, rpc, "bad hash"),
    /格式/
  );
  assert.equal(saved.l1Tx, undefined);
});
