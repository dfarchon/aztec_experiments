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
  const [recoveryHash, setRecoveryHash] = useState("");
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
      {model.funded && (
        <section
          className="notch-wallet-balance"
          aria-label="Stake and allowance"
        >
          <div className="notch-wallet-summary">
            <div className="notch-wallet-stake">
              <span>Staked</span>
              <strong>{formatEth(model.amount)} ETH</strong>
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
            <div className="notch-wallet-allowance">
              <span>Posts left</span>
              <strong>
                {view.stake.remaining === null ? "—" : view.stake.remaining}
                <span> / {model.quota}</span>
              </strong>
              <span>Rolling 24h</span>
            </div>
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
          {view.stake.exitNeedsHash && (
            <input
              aria-label="Existing Aztec withdrawal transaction hash"
              placeholder="Aztec withdrawal transaction hash"
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value)}
            />
          )}
          <button
            type="button"
            className="notch-wallet-primary"
            disabled={
              view.busy ||
              (view.stake.exitNeedsHash &&
                !/^0x[\da-f]{64}$/i.test(recoveryHash))
            }
            onClick={() =>
              void controller.resumeWithdrawal(
                view.stake.exitNeedsHash ? recoveryHash : undefined
              )
            }
          >
            {view.busy ? (
              <>
                <LoadingIcon />{" "}
                <span className="notch-wallet-action-label">
                  {walletProgressLabel(view.progress?.label)}
                </span>
              </>
            ) : (
              <>
                Complete withdrawal <Icon name="arrow" />
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
