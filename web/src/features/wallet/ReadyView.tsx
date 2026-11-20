import { useState } from "react";

import type { BillboardController, BillboardView } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import { MAX_STAKE } from "./stake-policy.ts";
import {
  formatEth,
  STAKE_AMOUNTS,
  walletProgressLabel,
  type WalletViewModel,
} from "./wallet-view.ts";

interface ReadyViewProps {
  view: BillboardView;
  controller: BillboardController;
  model: WalletViewModel;
}

function downloadAccount(controller: BillboardController) {
  const backup = controller.exportAccount();
  if (!backup) return;
  const url = URL.createObjectURL(
    new Blob([backup.contents], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = backup.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReadyView({ view, controller, model }: ReadyViewProps) {
  const [confirmExport, setConfirmExport] = useState(false);

  return (
    <div className="notch-wallet-body">
      <div className="notch-wallet-account">
        <p className="notch-wallet-connected">
          <span>Connected · </span>
          {view.stake.payer.slice(0, 8)}…{view.stake.payer.slice(-6)}
        </p>
        <button
          type="button"
          className="notch-wallet-disconnect"
          disabled={view.busy}
          onClick={() => void controller.disconnect()}
        >
          Disconnect
        </button>
      </div>
      {(model.funded || view.stake.pendingExit) && (
        <section
          className="notch-wallet-balance"
          aria-label="Stake and allowance"
        >
          <div className="notch-wallet-summary">
            <div className="notch-wallet-stake">
              <span>{view.stake.pendingExit ? "Withdrawing" : "Staked"}</span>
              <strong>
                {formatEth(
                  view.stake.pendingExit
                    ? BigInt(view.stake.exitAmount || view.stake.amount)
                    : model.amount
                )}{" "}
                ETH
              </strong>
              {model.ready && !view.stake.pendingExit && (
                <button
                  type="button"
                  className="notch-wallet-withdraw"
                  aria-label="Withdraw stake"
                  title={
                    model.withdrawLocked
                      ? "Available 24h after your last post"
                      : "Withdraw stake"
                  }
                  disabled={view.busy || model.withdrawLocked}
                  onClick={() => void controller.withdrawStake()}
                >
                  Withdraw
                </button>
              )}
            </div>
            {!view.stake.pendingExit && (
              <div className="notch-wallet-allowance">
                <span>Posts left</span>
                <strong>
                  {view.stake.remaining === null ? "—" : view.stake.remaining}
                  <span> / {model.quota}</span>
                </strong>
                <span>Rolling 24h</span>
              </div>
            )}
          </div>
          {model.withdrawLocked && !view.stake.pendingExit && (
            <p className="notch-wallet-lock-note">
              Withdrawal available 24h after your last post.
            </p>
          )}
          {model.ready &&
            !view.stake.pendingExit &&
            model.amount < MAX_STAKE && (
              <div className="notch-wallet-topups">
                <span>Add stake</span>
                <div
                  className="notch-stake-options is-compact"
                  role="group"
                  aria-label="Add stake"
                >
                  {STAKE_AMOUNTS.filter(
                    (value) => model.amount + value <= MAX_STAKE
                  ).map((value) => (
                    <button
                      type="button"
                      key={value}
                      disabled={view.busy}
                      onClick={() => void controller.stake(value.toString())}
                    >
                      +{formatEth(value)} ETH
                    </button>
                  ))}
                </div>
              </div>
            )}
        </section>
      )}
      {view.stake.pendingExit ? (
        <>
          {view.stake.exitNeedsHash && !view.busy && (
            <p className="notch-wallet-warning" role="status">
              Withdrawal status is uncertain. Keep this browser’s data and
              contact support before retrying.
            </p>
          )}
          {!view.stake.exitNeedsHash && (
            <p className="notch-wallet-withdrawal-note" role="status">
              {view.stake.exitReady
                ? "Your ETH is ready to claim. Confirm the transaction in your L1 wallet."
                : view.stake.exitL1Submitted
                  ? "Waiting for your L1 transaction to confirm."
                  : "Claiming requires an Ethereum-verified proof and may take a while. You can close this panel and return later."}
            </p>
          )}
          {view.stake.exitCheckError && !view.busy && (
            <p className="notch-wallet-warning" role="status">
              {view.stake.exitCheckError}
            </p>
          )}
          <button
            type="button"
            className="notch-wallet-primary"
            disabled={
              view.busy || !view.stake.exitReady || view.stake.exitNeedsHash
            }
            aria-busy={
              view.busy || (!view.stake.exitReady && !view.stake.exitNeedsHash)
            }
            onClick={() => void controller.resumeWithdrawal()}
          >
            {view.busy ||
            (!view.stake.exitReady && !view.stake.exitNeedsHash) ? (
              <>
                <LoadingIcon />
                <span className="notch-wallet-action-label">
                  {view.busy
                    ? walletProgressLabel(view.progress?.label)
                    : view.stake.exitL1Submitted
                      ? "Confirming withdrawal…"
                      : "Waiting for proof…"}
                </span>
              </>
            ) : (
              <>
                <span className="notch-wallet-action-label">
                  {view.stake.exitNeedsHash
                    ? "Withdrawal needs attention"
                    : "Claim ETH"}
                </span>
                {!view.stake.exitNeedsHash && <Icon name="arrow" />}
              </>
            )}
          </button>
        </>
      ) : (
        model.ready && (
          <>
            {confirmExport && (
              <p className="notch-wallet-warning" role="status">
                Contains private keys. Anyone with this file can control your
                Aztec account.
              </p>
            )}
            <div className="notch-wallet-ready-actions">
              <button
                type="button"
                className="notch-wallet-secondary notch-wallet-export"
                disabled={view.busy}
                onClick={() => setConfirmExport(!confirmExport)}
              >
                {confirmExport ? "Cancel" : "Export account"}
              </button>
              <button
                type="button"
                className="notch-wallet-primary"
                disabled={view.busy}
                onClick={() => {
                  if (confirmExport) {
                    downloadAccount(controller);
                    setConfirmExport(false);
                  } else {
                    controller.setWalletPanel(false);
                    requestAnimationFrame(() =>
                      document.getElementById("message")?.focus()
                    );
                  }
                }}
              >
                <span className="notch-wallet-action-label">
                  {confirmExport ? "Download account" : "Ready to post"}
                </span>{" "}
                <Icon name="arrow" />
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
}
