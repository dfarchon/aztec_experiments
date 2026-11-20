import { useRef } from "react";

import type { BillboardController, BillboardView } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import {
  formatEth,
  STAKE_AMOUNTS,
  type WalletViewModel,
} from "./wallet-view.ts";

interface SetupViewProps {
  view: BillboardView;
  controller: BillboardController;
  model: WalletViewModel;
}

export function SetupView({ view, controller, model }: SetupViewProps) {
  const importFile = useRef<HTMLInputElement>(null);

  const chooseStake = (value: bigint) =>
    controller.selectStakeAmount(value.toString());
  const primaryStakeAction = () => {
    if (view.stake.pendingDeposit) {
      if (view.stake.depositPrepared) {
        void controller.stake(model.stakeChoice.toString());
        return;
      }
      void controller.resumeRequest(undefined, "l1");
      return;
    }
    void controller.stake(model.stakeChoice.toString());
  };
  const stakeLabel = view.stake.pendingDeposit
    ? view.stake.depositPrepared
      ? `Stake ${formatEth(model.stakeChoice)} ETH`
      : view.stake.depositL1Confirmed
        ? "Continue setup"
        : "Check L1 status"
    : `Stake ${formatEth(model.stakeChoice)} ETH`;

  return (
    <div className="notch-wallet-body">
      <p className="notch-wallet-connected">
        Connected · {view.stake.payer.slice(0, 8)}…{view.stake.payer.slice(-6)}
      </p>
      {!view.restoring && (
        <p className="notch-wallet-warning" role="status">
          {view.stake.claimNeedsHash && !view.busy
            ? "Claim status is uncertain. Do not stake again. Keep this browser’s data and contact support to check the claim."
            : "Setup may take 1–2 minutes or longer. Keep this tab open until setup finishes. If interrupted, return in this browser to continue without staking again."}
        </p>
      )}
      {(model.ready || view.stake.pendingDeposit) && model.funded && (
        <div className="notch-wallet-balance">
          <span>Staked</span>
          <strong>{formatEth(model.amount)} ETH</strong>
          <span>
            {view.stake.remaining === null
              ? `${model.quota} posts / 24h`
              : `${view.stake.remaining} / ${model.quota} posts left`}
          </span>
        </div>
      )}
      {!view.stake.pendingDeposit && !model.funded && (
        <>
          <input
            ref={importFile}
            className="sr-only"
            type="file"
            accept=".json,application/json"
            aria-label="Import Aztec account"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void controller.importStakeBackup(file);
              event.target.value = "";
            }}
          />
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
                onClick={() => chooseStake(value)}
              >
                {formatEth(value)} ETH
              </button>
            ))}
          </div>
          <button
            type="button"
            className="notch-wallet-import"
            disabled={view.busy}
            onClick={() => importFile.current?.click()}
          >
            Already have an account? Import it
          </button>
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
              onClick={primaryStakeAction}
            >
              {view.busy ? (
                <>
                  <LoadingIcon /> {view.progress?.label || "Preparing stake…"}
                </>
              ) : (
                <>
                  {stakeLabel} <Icon name="arrow" />
                </>
              )}
            </button>
          </div>
        </>
      )}
      {view.stake.pendingDeposit && (
        <>
          <div
            className="notch-stake-options"
            role="group"
            aria-label={
              view.stake.depositPrepared
                ? "Stake amount"
                : "Selected stake amount"
            }
          >
            {STAKE_AMOUNTS.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={
                  (view.stake.depositPrepared
                    ? model.stakeChoice
                    : model.pendingAmount) === value
                }
                disabled={view.busy || model.pendingLocked}
                onClick={() => chooseStake(value)}
              >
                {formatEth(value)} ETH
              </button>
            ))}
          </div>
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
              disabled={view.busy || view.stake.claimNeedsHash}
              onClick={primaryStakeAction}
            >
              {view.busy ? (
                <>
                  <LoadingIcon /> {view.progress?.label || "Processing stake…"}
                </>
              ) : (
                <>
                  {stakeLabel} <Icon name="arrow" />
                </>
              )}
            </button>
          </div>
        </>
      )}
      {!view.stake.pendingDeposit && model.funded && !view.stake.aztecReady && (
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
            onClick={() => void controller.initializeAztec()}
          >
            {view.busy ? (
              <>
                <LoadingIcon /> {view.progress?.label || "Setting up Aztec…"}
              </>
            ) : (
              <>
                Continue setup <Icon name="arrow" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
