import type { BillboardController, BillboardView } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import {
  formatEth,
  STAKE_AMOUNTS,
  walletProgressLabel,
  type WalletViewModel,
} from "./wallet-view.ts";

interface SetupViewProps {
  view: BillboardView;
  controller: BillboardController;
  model: WalletViewModel;
}

export function SetupView({ view, controller, model }: SetupViewProps) {
  const chooseAmount =
    view.stake.l1Amount === "0" &&
    !model.funded &&
    (!view.stake.pendingDeposit || view.stake.depositPrepared);
  const label = chooseAmount
    ? `Stake ${formatEth(model.stakeChoice)} ETH`
    : "Continue setup";
  return (
    <div className="notch-wallet-body">
      <p className="notch-wallet-connected">
        Connected · {view.stake.payer.slice(0, 8)}…{view.stake.payer.slice(-6)}
      </p>
      {!view.restoring && (
        <p className="notch-wallet-warning" role="status">
          {view.stake.claimNeedsHash && !view.busy
            ? "Claim status is uncertain. Do not stake again. Continue setup to check the claim."
            : "Setup may take 1–2 minutes or longer. Keep this tab open until setup finishes. If interrupted, continue setup without staking again."}
        </p>
      )}
      {chooseAmount && (
        <div
          className="notch-stake-options"
          role="group"
          aria-label="Stake amount"
        >
          {STAKE_AMOUNTS.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={model.stakeChoice === value}
              disabled={view.busy}
              onClick={() => controller.selectStakeAmount(value.toString())}
            >
              {formatEth(value)} ETH
            </button>
          ))}
        </div>
      )}
      <div className="notch-wallet-footer-actions">
        <button
          type="button"
          className="notch-wallet-switch"
          disabled={view.busy}
          onClick={() => void controller.disconnect()}
        >
          Disconnect
        </button>
        <button
          type="button"
          className="notch-wallet-primary"
          disabled={view.busy}
          aria-busy={view.busy}
          aria-label={view.busy ? view.progress?.label : undefined}
          onClick={() =>
            chooseAmount
              ? void controller.stake(model.stakeChoice.toString())
              : void controller.continueSetup()
          }
        >
          {view.busy && <LoadingIcon />}
          <span className="notch-wallet-action-label">
            {view.busy ? walletProgressLabel(view.progress?.label) : label}
          </span>
          {!view.busy && <Icon name="arrow" />}
        </button>
      </div>
    </div>
  );
}
