import { readStored, writeStored } from "./account-keys.ts";
import type { NotchDeployment, WalletAccountRecord } from "./wallet-types.ts";

const ACCOUNT_VERSION = "6.0.0";

export function accountStorageKey(deployment: NotchDeployment, payer: string) {
  return `notch-stake/${ACCOUNT_VERSION}/${deployment.board}/${payer.toLowerCase()}`;
}

export function readAccountRecord(
  storage: Pick<Storage, "getItem">,
  key: string
): WalletAccountRecord | null {
  const record = readStored<WalletAccountRecord>(storage, key);
  if (record === null) return null;
  if (
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record.payer !== "string" ||
    !record.payer
  )
    throw new Error("Invalid saved account data. Preserve it for recovery.");
  return record;
}

export function writeAccountRecord(
  storage: Pick<Storage, "setItem">,
  key: string,
  record: WalletAccountRecord
) {
  writeStored(storage, key, record);
}

export function newAccountRecord(payer: string): WalletAccountRecord {
  return {
    payer,
    amount: "0",
    stakeChoice: "500000000000000",
    deposit: null,
    exit: null,
  };
}
