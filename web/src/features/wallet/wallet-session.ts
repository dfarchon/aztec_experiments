import type {
  NotchDeployment,
  WalletSessionPreference,
} from "./wallet-types.ts";

export function walletSessionKey(deployment: NotchDeployment) {
  return `notch-wallet-session/${deployment.board}`;
}

export function readWalletSession(
  storage: Pick<Storage, "getItem">,
  deployment: NotchDeployment
): WalletSessionPreference | null {
  try {
    const value = JSON.parse(
      storage.getItem(walletSessionKey(deployment)) || "null"
    ) as Partial<WalletSessionPreference> | null;
    if (
      !value ||
      typeof value.payer !== "string" ||
      typeof value.walletName !== "string" ||
      typeof value.walletId !== "string"
    )
      return null;
    return {
      walletId: value.walletId,
      walletName: value.walletName,
      payer: value.payer,
    };
  } catch {
    return null;
  }
}

export function writeWalletSession(
  storage: Pick<Storage, "setItem">,
  deployment: NotchDeployment,
  session: WalletSessionPreference
) {
  storage.setItem(walletSessionKey(deployment), JSON.stringify(session));
}

export function clearWalletSession(
  storage: Pick<Storage, "removeItem">,
  deployment: NotchDeployment
) {
  storage.removeItem(walletSessionKey(deployment));
}
