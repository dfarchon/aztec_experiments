import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STAKE,
  postQuota,
  STAKE_UNIT,
  validateTopup,
} from "./stake-policy.ts";

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
