import type { BillboardView } from "../../app/types.ts";
import { postQuota, STAKE_UNIT } from "./stake-policy.ts";

export const STAKE_AMOUNTS = [1n, 2n, 4n].map((units) => units * STAKE_UNIT);

export interface WalletViewModel {
  amount: bigint;
  connected: boolean;
  funded: boolean;
  panelLocked: boolean;
  quota: number;
  ready: boolean;
  setupInProgress: boolean;
  stakeChoice: bigint;
  step: 1 | 2 | 3;
  title: string;
  walletLoading: boolean;
  walletStatus: string;
  withdrawLocked: boolean;
}

export function formatEth(value: bigint) {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function walletViewModel(view: BillboardView): WalletViewModel {
  const amount = BigInt(view.stake.amount);
  const connected = Boolean(view.stake.payer);
  const funded = amount > 0n;
  const ready = funded && view.stake.aztecReady && !view.stake.pendingDeposit;
  const panelLocked = view.busy && !view.restoring;
  const setupInProgress =
    connected &&
    view.busy &&
    !view.restoring &&
    (view.stake.pendingDeposit || !ready) &&
    !view.stake.pendingExit;
  const walletLoading = view.connecting || view.restoring || setupInProgress;
  const title = !connected
    ? "Connect your wallet"
    : view.stake.pendingExit
      ? "Complete withdrawal"
      : view.restoring
        ? "Restoring account"
        : ready
          ? "Ready to post"
          : "Stake & set up";
  const unlockAt = Number(view.stake.lastPost) * 1000 + 86_400_000;
  return {
    amount,
    connected,
    funded,
    panelLocked,
    quota: postQuota(amount),
    ready,
    setupInProgress,
    stakeChoice: BigInt(view.stake.stakeChoice),
    step: !connected ? 1 : ready ? 3 : 2,
    title,
    walletLoading,
    walletStatus: walletLoading
      ? "Updating account"
      : ready && !view.stake.pendingExit
        ? "Account ready"
        : connected
          ? "Setup required"
          : "Connect wallet",
    withdrawLocked: Number(view.stake.lastPost) > 0 && Date.now() < unlockAt,
  };
}

// Keep verbose runtime diagnostics out of fixed-size action buttons.
export function walletProgressLabel(message = "") {
  const text = message.toLowerCase();
  if (/signing key|capsule/.test(text)) return "Preparing keys…";
  if (/sign to|signature/.test(text)) return "Confirm signature…";
  if (/confirm.*stake.*wallet/.test(text)) return "Confirm stake…";
  if (/waiting.*l1|l1 confirmation/.test(text)) return "Confirming stake…";
  if (/waiting|deposit on aztec/.test(text)) return "Syncing stake…";
  if (/checking.*l1|existing l1/.test(text)) return "Checking stake…";
  if (/checking.*wallet|wallet account/.test(text)) return "Checking wallet…";
  if (/proof|proving/.test(text)) return "Preparing proof…";
  if (/claim/.test(text)) return "Claiming stake…";
  if (/withdraw/.test(text)) return "Withdrawing…";
  if (/sync|register|pxe/.test(text)) return "Syncing account…";
  return "Setting up…";
}
