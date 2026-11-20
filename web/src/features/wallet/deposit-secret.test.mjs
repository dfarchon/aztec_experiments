import assert from "node:assert/strict";
import test from "node:test";

import { createDepositSecret, hashDepositSecret } from "./deposit-secret.ts";

test("lightweight L1 stake secret matches the Aztec secret hash vector", () => {
  assert.equal(
    hashDepositSecret(123456n),
    "0x062d3caa297561992e3129de63fa21a50255d9c24de9c09b854cb8d52be4a5d4"
  );
  assert.throws(() => hashDepositSecret(0n), /Invalid deposit secret/);
  const first = createDepositSecret();
  const second = createDepositSecret();
  assert.match(first.secret, /^0x[\da-f]{64}$/);
  assert.equal(first.secretHash, hashDepositSecret(BigInt(first.secret)));
  assert.notEqual(first.secret, second.secret);
});
