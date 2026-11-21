import assert from "node:assert/strict";
import test from "node:test";

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";

import { resolveSponsoredFpc } from "../../runtime/sponsored-fpc.mjs";

const sdk = { AztecAddress, getContractClassFromArtifact };
const artifact = SponsoredFPCContract.artifact;
const instance = await getContractInstanceFromInstantiationParams(artifact, {
  salt: Fr.fromString("0x01"),
});
const address = instance.address.toString();

test("custom FPC resolution checks the deployed class without assuming a canonical salt", async () => {
  let calls = 0;
  const node = {
    getContract: async (requested) => {
      calls++;
      assert.equal(requested.toString(), address);
      return instance;
    },
  };
  assert.equal(
    await resolveSponsoredFpc(node, sdk, artifact, address),
    instance
  );
  assert.equal(calls, 1);
});

test("missing, mismatched-address and changed-class FPCs fail closed", async () => {
  const deployed = AztecAddress.fromStringUnsafe(address);
  for (const instance of [
    undefined,
    { address: AztecAddress.fromBigIntUnsafe(1n) },
    { address: deployed, currentContractClassId: Fr.ZERO },
  ]) {
    await assert.rejects(
      resolveSponsoredFpc(
        { getContract: async () => instance },
        sdk,
        artifact,
        address
      ),
      /Sponsored FPC/
    );
  }
});
