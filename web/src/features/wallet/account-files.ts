import { hasAccountKeys } from "./account-keys.ts";
import type {
  AccountExport,
  NotchDeployment,
  WalletAccountRecord,
} from "./wallet-types.ts";

// This is an account key package, not a Notch transaction checkpoint backup.
export function writeAccountFile(
  record: WalletAccountRecord,
  owner: string,
  config: NotchDeployment
): AccountExport | null {
  const address = owner || record.address;
  if (
    !hasAccountKeys(record) ||
    !address ||
    !record.accountClassId ||
    !record.accountVersion
  )
    return null;
  return {
    filename: `aztec-account-${address.slice(0, 12)}.json`,
    contents: JSON.stringify(
      {
        kind: "notch-account",
        version: 2,
        address,
        keys: {
          secretKey: record.secretKey,
          signingKey: record.signingKey,
          salt: record.salt,
        },
        accountContract: {
          type: "schnorr-initializerless",
          version: record.accountVersion,
          classId: record.accountClassId,
        },
        network: {
          environment: config.environment || "local",
          l1ChainId: config.l1Stake.chainId,
          rollupAddress: config.rollupAddress,
          rollupVersion: config.rollupVersion,
        },
      },
      null,
      2
    ),
  };
}
