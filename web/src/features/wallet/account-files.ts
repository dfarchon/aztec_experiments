import type { AztecRuntime } from "../../../../runtime/wallet-runtime.mjs";
import { hasAccountKeys } from "./account-keys.ts";
import { hashDepositSecret } from "./deposit-secret.ts";
import { postQuota, STAKE_UNIT } from "./stake-policy.ts";
import type {
  AccountBackup,
  DepositRecord,
  ExitRecord,
  ImportedAccount,
  NotchDeployment,
  WalletAccountRecord,
} from "./wallet-types.ts";

const MAX_ACCOUNT_FILE_BYTES = 64 * 1024;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseDeposit(value: unknown): DepositRecord | null {
  if (value == null) return null;
  const deposit = asObject(value);
  if (
    !deposit ||
    typeof deposit.amount !== "string" ||
    typeof deposit.secret !== "string" ||
    typeof deposit.secretHash !== "string"
  )
    throw new Error("Backup deposit secret does not match its hash");
  try {
    if (
      hashDepositSecret(BigInt(deposit.secret)).toLowerCase() !==
      deposit.secretHash.toLowerCase()
    )
      throw new Error("Backup deposit secret does not match its hash");
  } catch {
    throw new Error("Backup deposit secret does not match its hash");
  }
  return deposit as unknown as DepositRecord;
}

function parseExit(value: unknown): ExitRecord | null {
  if (value == null) return null;
  const exit = asObject(value);
  if (!exit || typeof exit.amount !== "string")
    throw new Error("Backup withdrawal data is invalid");
  return exit as unknown as ExitRecord;
}

function validateNetwork(network: unknown, config: NotchDeployment): void {
  if (!network) return;
  const value = asObject(network);
  if (
    !value ||
    value.environment !== (config.environment || "local") ||
    String(value.l1ChainId) !== String(config.l1Stake.chainId) ||
    typeof value.rollupAddress !== "string" ||
    value.rollupAddress.toLowerCase() !== config.rollupAddress?.toLowerCase() ||
    String(value.rollupVersion) !== String(config.rollupVersion) ||
    typeof value.portal !== "string" ||
    value.portal.toLowerCase() !== config.l1Stake.portal.toLowerCase()
  )
    throw new Error("Backup belongs to another network");
}

export async function readAccountFile(
  file: File,
  config: NotchDeployment,
  payer: string,
  runtime: AztecRuntime
): Promise<ImportedAccount> {
  if (file.size > MAX_ACCOUNT_FILE_BYTES)
    throw new Error("Backup file is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Backup is not valid JSON");
  }
  const backup = asObject(parsed);
  if (!backup) throw new Error("Backup has an invalid format");
  if (
    (backup.version !== undefined && Number(backup.version) !== 1) ||
    (backup.kind !== undefined && backup.kind !== "notch-account")
  )
    throw new Error("Backup version is not supported");
  if (
    backup.board !== config.board ||
    typeof backup.payer !== "string" ||
    backup.payer.toLowerCase() !== payer.toLowerCase()
  )
    throw new Error("Backup does not match this board and L1 wallet");
  if (backup.address !== undefined && typeof backup.address !== "string")
    throw new Error("Backup Aztec address is invalid");
  validateNetwork(backup.network, config);

  const hasKeys = hasAccountKeys(backup);
  const deposit = parseDeposit(backup.deposit);
  const exit = parseExit(backup.exit);
  if (!hasKeys && !deposit?.secret)
    throw new Error("Backup has no account or pending stake");

  let address: string | undefined;
  if (hasKeys) {
    const derived = await runtime.deriveAccountAddress(
      backup.secretKey,
      BigInt(backup.salt),
      runtime.sdk.Fq.fromString(backup.signingKey)
    );
    address = derived.address.toString();
    if (
      typeof backup.address === "string" &&
      address.toLowerCase() !== backup.address.toLowerCase()
    )
      throw new Error("Backup keys do not match the Aztec address");
  }

  let amountHint = "0";
  if (backup.amount !== undefined) {
    if (!["string", "number"].includes(typeof backup.amount))
      throw new Error("Backup amount is invalid");
    try {
      amountHint = BigInt(backup.amount as string | number).toString();
    } catch {
      throw new Error("Backup amount is invalid");
    }
  }

  return {
    keys: hasKeys
      ? {
          secretKey: backup.secretKey,
          salt: backup.salt,
          signingKey: backup.signingKey,
        }
      : undefined,
    address,
    amountHint,
    deposit,
    exit,
  };
}

export function writeAccountFile(
  record: WalletAccountRecord,
  owner: string,
  config: NotchDeployment
): AccountBackup | null {
  if (!hasAccountKeys(record)) return null;
  return {
    filename: `notch-account-${record.payer.slice(0, 10)}.json`,
    contents: JSON.stringify(
      {
        kind: "notch-account",
        version: 1,
        secretKey: record.secretKey,
        salt: record.salt,
        signingKey: record.signingKey,
        address: owner || record.address,
        payer: record.payer,
        board: config.board,
        network: {
          environment: config.environment || "local",
          l1ChainId: config.l1Stake.chainId,
          rollupAddress: config.rollupAddress,
          rollupVersion: config.rollupVersion,
          portal: config.l1Stake.portal,
        },
        amount: record.amount,
        quota: record.amount ? postQuota(BigInt(record.amount)) : 0,
        remaining: record.remaining ?? null,
        lastPost: record.lastPost || "0",
        deposit: record.deposit,
        exit: record.exit,
      },
      null,
      2
    ),
  };
}

export function importedAccountRecord(
  payer: string,
  imported: ImportedAccount
): WalletAccountRecord {
  return {
    payer,
    secretKey: imported.keys?.secretKey || "",
    salt: imported.keys?.salt || "",
    signingKey: imported.keys?.signingKey || "",
    address: imported.address,
    amount: "0",
    stakeChoice: STAKE_UNIT.toString(),
    importedAmountHint: imported.keys ? imported.amountHint : null,
    deposit: imported.deposit,
    exit: imported.exit,
  };
}
