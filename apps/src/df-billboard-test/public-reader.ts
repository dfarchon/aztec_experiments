import { poseidon2Hash } from "@zkpassport/poseidon2";

import type { Field, Layout } from "./feed-reader";

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// Aztec 6.0.0 PUBLIC_STORAGE_MAP_SLOT. The constants package itself imports
// the proving runtime; the SDK parity test guards this read-only constant.
export const MAP_SLOT_SEPARATOR = 4015149901n;

// Only the public storage reader uses this field/hash adapter. Wallets and
// proofs continue to use the unmodified Aztec SDK.
export class PublicField implements Field {
  private value: bigint;
  constructor(value: string | bigint) {
    this.value = BigInt(value);
    if (this.value < 0n || this.value >= FIELD_MODULUS)
      throw new Error("Invalid public storage field");
  }
  toBigInt() {
    return this.value;
  }
  toString() {
    return `0x${this.value.toString(16).padStart(64, "0")}`;
  }
}

export async function fetchPublicJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Unable to read board data (HTTP ${response.status})`);
  return response.json();
}

function address(value: string) {
  if (!/^0x[\da-f]{64}$/i.test(value)) throw new Error("Invalid board address");
  return value;
}

export function createPublicNode(url: string) {
  let id = 0;
  async function rpc(method: string, params: unknown[] = []) {
    const requestId = ++id;
    const result = await fetchPublicJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: `node_${method}`,
        params,
      }),
    });
    if (result.id !== requestId || result.error || !("result" in result))
      throw new Error(result.error?.message || "Invalid board RPC response");
    return result.result;
  }
  return {
    getNodeInfo: () => rpc("getNodeInfo"),
    getL1ContractAddresses: () => rpc("getL1ContractAddresses"),
    getContract: (value: { toString(): string }) =>
      rpc("getContract", [address(value.toString())]),
    getBlockNumber: async () => {
      const block = await rpc("getBlockNumber");
      if (!Number.isSafeInteger(block) || block < 0)
        throw new Error("Invalid board block number");
      return block as number;
    },
    getPublicStorageAt: async (
      block: number,
      value: { toString(): string },
      slot: Field
    ) =>
      new PublicField(
        await rpc("getPublicStorageAt", [
          block,
          address(value.toString()),
          slot.toString(),
        ])
      ),
  };
}

export const publicReadSDK = {
  Fr: PublicField,
  AztecAddress: { fromStringUnsafe: address },
  createAztecNodeClient: createPublicNode,
  deriveStorageSlotInMap: async (slot: Field, key: Field) =>
    new PublicField(
      poseidon2Hash([MAP_SLOT_SEPARATOR, slot.toBigInt(), key.toBigInt()])
    ),
};

export async function loadReadLayout(artifactHash: string): Promise<Layout> {
  const config = await fetchPublicJson("/df-read-config.json", {
    cache: "no-cache",
  });
  if (config.boardArtifactHash !== artifactHash)
    throw new Error("Board reader configuration does not match the deployment");
  const slot = (key: string) => ({
    slot: new PublicField(config.storageLayout[key].slot),
  });
  return {
    post_count: slot("post_count"),
    post_lengths: slot("post_lengths"),
    post_data: slot("post_data"),
  };
}
