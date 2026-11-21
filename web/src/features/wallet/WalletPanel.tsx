import { useEffect, useRef } from "react";

import type { ViewProps } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import { StepIndicator } from "../../ui/StepIndicator.tsx";
import { ConnectView } from "./ConnectView.tsx";
import { ReadyView } from "./ReadyView.tsx";
import { SetupView } from "./SetupView.tsx";
import { walletViewModel } from "./wallet-view.ts";

export function WalletPanel({ view, controller }: ViewProps) {
  const model = walletViewModel(view);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (view.walletOpen) close.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = view.walletOpen;
  }, [view.walletOpen]);

  useEffect(() => {
    if (!view.walletOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !model.panelLocked)
        controller.setWalletPanel(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [view.walletOpen, model.panelLocked, controller]);

  return (
    <div className="wallet-anchor">
      <button
        id="walletMenu"
        ref={trigger}
        type="button"
        className={`header-control header-action${model.connected ? " connected" : ""}`}
        disabled={model.panelLocked}
        aria-busy={model.walletLoading}
        aria-label={
          model.connected
            ? `${model.walletStatus}: ${view.stake.payer}`
            : model.walletStatus
        }
        title={model.walletStatus}
        aria-expanded={view.walletOpen}
        aria-controls="walletPanel"
        onClick={() => controller.setWalletPanel(!view.walletOpen)}
      >
        <span className="wallet-status-icon" aria-hidden="true">
          {model.walletLoading ? (
            <LoadingIcon />
          ) : (
            <Icon
              name={
                (model.ready && !view.stake.pendingExit) || view.stake.exitReady
                  ? "check"
                  : model.connected
                    ? "warning"
                    : "wallet"
              }
            />
          )}
        </span>
        <span id="walletMenuText">
          {model.connected
            ? `${view.stake.payer.slice(0, 8)}…${view.stake.payer.slice(-6)}`
            : "Connect wallet"}
        </span>
      </button>
      {view.walletOpen && (
        <div
          className="notch-wallet-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !model.panelLocked)
              controller.setWalletPanel(false);
          }}
        >
          <section
            id="walletPanel"
            className="notch-wallet-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={model.title}
          >
            <div className="notch-wallet-head">
              <StepIndicator
                steps={["Connect", "Set up", "Ready"]}
                currentStep={model.step}
                label="Posting steps"
              />
              <button
                ref={close}
                type="button"
                aria-label="Close wallet panel"
                disabled={model.panelLocked}
                onClick={() => controller.setWalletPanel(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            {!model.connected ? (
              <ConnectView view={view} controller={controller} />
            ) : view.stake.pendingExit || model.ready ? (
              <ReadyView view={view} controller={controller} model={model} />
            ) : (
              <SetupView view={view} controller={controller} model={model} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
