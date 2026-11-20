import { useState } from "react";

import type { BillboardController, BillboardView } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import { MAX_STAKE } from "./stake-policy.ts";
import {
  formatEth,
  STAKE_AMOUNTS,
  type WalletViewModel,
} from "./wallet-view.ts";

interface ReadyViewProps {
  view: BillboardView;
  controller: BillboardController;
  model: WalletViewModel;
}

function downloadBackup(controller: BillboardController) {
  const backup = controller.accountBackup();
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

  return (
    <div className="notch-wallet-body">
      <p className="notch-wallet-connected">
        Connected · {view.stake.payer.slice(0, 8)}…{view.stake.payer.slice(-6)}
      </p>
      {model.funded && (
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
                {view.progress?.label || "Completing withdrawal…"}
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
            {model.amount < MAX_STAKE && (
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
            {model.withdrawLocked && (
              <p className="notch-wallet-lock-note">
                Withdrawal available 24h after your last post.
              </p>
            )}
            <div className="notch-wallet-ready-actions">
              <button
                type="button"
                className="notch-wallet-disconnect"
                disabled={view.busy}
                onClick={() => void controller.disconnect()}
              >
                Disconnect
              </button>
              <button
                type="button"
                className="notch-wallet-secondary"
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
              <button
                type="button"
                className="notch-wallet-primary"
                disabled={view.busy}
                onClick={() => downloadBackup(controller)}
              >
                Export account
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
}
