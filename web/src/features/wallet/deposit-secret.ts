// Deposit secrets connect the public L1 payment to the private Aztec note.
import { poseidon2Hash } from "@zkpassport/poseidon2";

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECRET_HASH_DOMAIN = 4199652938n;
const hex = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

export function hashDepositSecret(secret: bigint) {
  if (secret <= 0n || secret >= FIELD_MODULUS)
    throw new Error("Invalid deposit secret");
  return hex(poseidon2Hash([SECRET_HASH_DOMAIN, secret]));
}

export function createDepositSecret() {
  let secret = 0n;
  while (secret === 0n || secret >= FIELD_MODULUS) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = BigInt(
      `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    );
  }
  return {
    secret: hex(secret),
    secretHash: hashDepositSecret(secret),
  };
}
