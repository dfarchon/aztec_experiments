// Private account material. A public L1 address alone is never a recovery secret.
type RequestSDK = typeof import("../../../../runtime/sdk-entry.mjs");

export interface AccountKeys {
  secretKey: string;
  salt: string;
  signingKey: string;
}
export function hasAccountKeys(value: unknown): value is AccountKeys {
  if (!value || typeof value !== "object") return false;
  const keys = value as Record<string, unknown>;
  return ["secretKey", "salt", "signingKey"].every(
    (key) => typeof keys[key] === "string" && Boolean(keys[key])
  );
}
// Callers keep separate storage keys and PXE namespaces for each account.
export function accountSetupOptions(
  sdk: Pick<RequestSDK, "Fq">,
  keys: AccountKeys,
  dataDirPrefix: string,
  proverEnabled: boolean
) {
  if (!hasAccountKeys(keys))
    throw new Error(
      "Invalid saved account keys. Preserve browser data for recovery."
    );
  const signingKey = keys.signingKey.replace(/^0x/i, "");
  return {
    secretKey: keys.secretKey,
    salt: keys.salt,
    signingKey: sdk.Fq.fromString(`0x${signingKey}`),
    dataDirPrefix,
    proverEnabled,
    blockMonitor: false,
  };
}
export function readStored<T>(
  storage: Pick<Storage, "getItem">,
  key: string
): T | null {
  const value = storage.getItem(key);
  if (value === null) return null;
  const parsed = JSON.parse(value) as T;
  if (parsed === null)
    throw new Error("Invalid saved account data. Preserve it for recovery.");
  return parsed;
}
export function writeStored(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: unknown
) {
  // Propagate failures: do not start paid operations without durable recovery data.
  storage.setItem(key, JSON.stringify(value));
}
