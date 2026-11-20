import {
  computeHmac,
  hexlify,
  Signature,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";

import type { AccountKeys } from "./account-keys.ts";
import { hashDepositSecret } from "./deposit-secret.ts";
import { type InjectedProvider, waitForWalletApproval } from "./l1.ts";
import type { NotchDeployment } from "./wallet-types.ts";

export const RECOVERY_VERSION = "l1-signature-v1";
const FR = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const FQ = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

function scope(config: NotchDeployment, payer: string) {
  return [
    `Version: ${RECOVERY_VERSION}`,
    `Ethereum account: ${payer.toLowerCase()}`,
    `Chain ID: ${config.l1Stake.chainId}`,
    `Portal: ${config.l1Stake.portal.toLowerCase()}`,
    `Aztec board: ${config.board.toLowerCase()}`,
    `Rollup: ${config.rollupAddress.toLowerCase()}`,
    `Rollup version: ${config.rollupVersion}`,
  ].join("\n");
}

export function accountRecoveryMessage(config: NotchDeployment, payer: string) {
  return [
    "Notch account recovery",
    "Sign to create or restore your private Aztec account. No transaction or payment.",
    "This signature controls your Notch account. Only sign in the Notch app; never share it.",
    scope(config, payer),
  ].join("\n\n");
}

function field(key: string, label: string, modulus = FR) {
  // Separate purposes and field moduli; no SDK/WASM is needed before L1 payment.
  const digest = computeHmac("sha256", key, toUtf8Bytes(label));
  const value = (BigInt(digest) % (modulus - 1n)) + 1n;
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function deriveAccountKeys(
  signature: string,
  config: NotchDeployment,
  payer: string
): AccountKeys {
  const message = accountRecoveryMessage(config, payer);
  if (verifyMessage(message, signature).toLowerCase() !== payer.toLowerCase())
    throw new Error("Recovery signature belongs to another Ethereum wallet");
  // Like the upstream signature-as-seed scheme, use r to avoid v encoding differences.
  const seed = Signature.from(signature).r;
  const domain = scope(config, payer);
  return {
    secretKey: field(seed, `${domain}\nPurpose: account secret`),
    salt: field(seed, `${domain}\nPurpose: account salt`),
    signingKey: field(seed, `${domain}\nPurpose: signing key`, FQ),
  };
}

export async function signAccountKeys(
  provider: InjectedProvider,
  config: NotchDeployment,
  payer: string
) {
  const signature = await waitForWalletApproval(
    provider.request({
      method: "personal_sign",
      params: [
        hexlify(toUtf8Bytes(accountRecoveryMessage(config, payer))),
        payer,
      ],
    }),
    "account recovery signature"
  );
  if (typeof signature !== "string")
    throw new Error("Invalid recovery signature");
  return deriveAccountKeys(signature, config, payer);
}

export function deriveDepositSecret(
  keys: AccountKeys,
  config: NotchDeployment,
  payer: string,
  nonce: number,
  amount: string
) {
  if (!Number.isSafeInteger(nonce) || nonce < 0 || BigInt(amount) <= 0n)
    throw new Error("Invalid deposit recovery parameters");
  // Derive each claim secret from the recoverable account, avoiding another signature prompt.
  const secret = field(
    keys.secretKey,
    `${scope(config, payer)}\nPurpose: deposit claim\nNonce: ${nonce}\nAmount: ${BigInt(amount)}`
  );
  return { secret, secretHash: hashDepositSecret(BigInt(secret)) };
}
