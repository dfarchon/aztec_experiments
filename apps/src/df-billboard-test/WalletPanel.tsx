import { useEffect, useRef } from "react";

import { Select } from "./Select";
import type { BillboardController, ViewProps, WalletMode } from "./types";

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

export function WalletPanel({ view, controller }: ViewProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const locked = view.busy || view.connected || view.pendingConnection;
  const mode = view.walletMode;
  const browserWallet = !["extension", "metamask"].includes(mode);
  const connectLabel =
    mode === "metamask"
      ? "Connect MetaMask"
      : mode === "extension"
        ? `Connect ${view.providers[Number(view.provider)]?.name || "Azguard"}`
        : mode === "create"
          ? "Create & connect Aztec account"
          : mode === "import"
            ? "Import & connect Aztec account"
            : "Connect browser wallet";

  useEffect(() => {
    if (view.walletOpen) close.current?.focus();
    else if (wasOpen.current) menu.current?.focus();
    wasOpen.current = view.walletOpen;
  }, [view.walletOpen]);
  useEffect(() => {
    if (!view.walletOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !view.busy
      )
        controller.setWalletPanel(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !view.busy)
        controller.setWalletPanel(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [view.walletOpen, view.busy, controller]);

  return (
    <div className="wallet-anchor" ref={anchor}>
      <button
        id="walletMenu"
        ref={menu}
        type="button"
        disabled={view.busy}
        className={`header-action${view.connected ? " connected" : ""}`}
        aria-expanded={view.walletOpen}
        aria-controls="walletPanel"
        onClick={() => controller.setWalletPanel(!view.walletOpen)}
      >
        <span className="wallet-icon" aria-hidden="true">
          ◈
        </span>
        <span id="walletMenuText">
          {view.address
            ? `${view.address.slice(0, 8)}…${view.address.slice(-6)}`
            : "Connect wallet"}
        </span>
      </button>
      <section
        id="walletPanel"
        className="wallet-popover"
        aria-label={view.connected ? "My wallet" : "Connect a wallet"}
        hidden={!view.walletOpen}
      >
        <div className="popover-head">
          <h2>{view.connected ? "My wallet" : "Connect a wallet"}</h2>
          <button
            id="walletClose"
            ref={close}
            type="button"
            aria-label="Close wallet panel"
            disabled={view.busy}
            onClick={() => controller.setWalletPanel(false)}
          >
            ×
          </button>
        </div>
        <div hidden={view.connected}>
          <label htmlFor="walletMode">Connection method</label>
          <Select
            id="walletMode"
            value={browserWallet ? "browser" : mode}
            disabled={locked}
            onChange={(value) =>
              controller.setField(
                "walletMode",
                value === "browser"
                  ? view.savedAccounts.length
                    ? "local"
                    : "create"
                  : (value as WalletMode)
              )
            }
            options={[
              {
                value: "metamask",
                label: "MetaMask · Pay L1 gas",
                disabled: !view.request.available,
              },
              { value: "extension", label: "Azguard · L2 fees sponsored" },
              { value: "browser", label: "Browser wallet" },
            ]}
          />
          <div hidden={mode !== "metamask"} className="small">
            Each post requires a zero-value Ethereum transaction. You pay L1
            gas; Sponsored FPC pays L2 fees. An Aztec account is prepared in
            this browser automatically. Your L1 payer address is public.
          </div>
          {!view.request.available && (
            <p className="small">
              MetaMask requires a board deployed with an L1 entry.
            </p>
          )}
          <div id="localOptions" hidden={!browserWallet}>
            <label htmlFor="browserAccountAction">Browser account</label>
            <Select
              id="browserAccountAction"
              hidden={!browserWallet}
              value={mode}
              disabled={locked}
              onChange={(value) =>
                controller.setField("walletMode", value as WalletMode)
              }
              options={[
                {
                  value: "local",
                  label: "Use saved account",
                  disabled: !view.savedAccounts.length,
                },
                { value: "create", label: "Create account" },
                { value: "import", label: "Import backup" },
              ]}
            />
            <div id="savedOptions" hidden={mode !== "local"}>
              <label htmlFor="savedAccount">Saved accounts</label>
              <Select
                id="savedAccount"
                hidden={mode !== "local"}
                value={view.savedAccount}
                disabled={locked}
                onChange={(value) => controller.setField("savedAccount", value)}
                options={
                  view.savedAccounts.length
                    ? view.savedAccounts.map((account) => ({
                        value: account.address,
                        label: `${account.label || "Aztec account"} · ${account.address.slice(0, 10)}…${account.address.slice(-6)}`,
                      }))
                    : [
                        {
                          value: "",
                          label: "No saved accounts",
                          disabled: true,
                        },
                      ]
                }
              />
            </div>
            <div id="createOptions" hidden={mode !== "create"}>
              <label htmlFor="accountLabel">Account name (optional)</label>
              <input
                id="accountLabel"
                type="text"
                maxLength={32}
                placeholder="e.g. My browser account"
                disabled={locked}
                value={view.accountLabel}
                onChange={(event) =>
                  controller.setField("accountLabel", event.target.value)
                }
              />
              <p className="small">
                Creates a Schnorr account in this browser. Keys are stored
                locally without encryption. Download a backup after creation and
                do not use a shared computer.
              </p>
            </div>
            <div id="importOptions" hidden={mode !== "import"}>
              <label htmlFor="accountFile">Aztec account JSON backup</label>
              <input
                key={view.fileVersion}
                id="accountFile"
                type="file"
                accept=".json,application/json"
                disabled={locked}
                onChange={(event) =>
                  controller.setField(
                    "accountFile",
                    event.target.files?.[0] || null
                  )
                }
              />
              <p className="small">
                The file is read locally and never uploaded. Connect your
                account to post; no DF game account is required.
              </p>
            </div>
          </div>
          <div id="extensionOptions" hidden={mode !== "extension"}>
            <p className="small">
              Open in Chrome with Azguard installed and switch the extension to{" "}
              <code>{view.deployment?.nodeUrl || "http://127.0.0.1:5180"}</code>
              .
            </p>
            <div className="row">
              <button
                id="scan"
                className="secondary"
                type="button"
                disabled={locked || !view.deployment}
                onClick={controller.scan}
              >
                Scan again
              </button>
              <Select
                id="provider"
                aria-label="Aztec extension wallet"
                hidden={view.providers.length < 2}
                disabled={locked}
                value={view.provider}
                onChange={(value) => controller.setField("provider", value)}
                options={view.providers.map((provider, index) => ({
                  value: String(index),
                  label: provider.name,
                }))}
              />
            </div>
            <div id="extensionStatus" className="small" role="status">
              {view.extensionStatus}
            </div>
            <div id="verification" hidden={!view.verification}>
              <p>Check that these emojis match those shown in your wallet:</p>
              <div id="emoji">{view.emoji}</div>
              <div className="row">
                <button
                  id="confirmWallet"
                  type="button"
                  disabled={view.busy || !view.pendingConnection}
                  onClick={controller.confirmWallet}
                >
                  Emojis match · Continue
                </button>
                <button
                  id="cancelWallet"
                  type="button"
                  disabled={view.busy || !view.pendingConnection}
                  onClick={controller.cancelWallet}
                >
                  Cancel
                </button>
              </div>
            </div>
            <div
              id="grantedAccountOptions"
              hidden={view.grantedAccounts.length < 2}
            >
              <label htmlFor="grantedAccount">Authorized accounts</label>
              <Select
                id="grantedAccount"
                value={view.grantedAccount}
                disabled={view.busy}
                onChange={(value) =>
                  void controller.selectGrantedAccount(value)
                }
                options={view.grantedAccounts}
              />
            </div>
          </div>
          <button
            id="connect"
            type="button"
            disabled={
              locked ||
              !view.deployment ||
              (mode === "local" && !view.savedAccounts.length) ||
              (mode === "metamask" && !view.request.available)
            }
            onClick={controller.connect}
          >
            {connectLabel}
          </button>
        </div>
        {view.connected && (
          <div className="wallet-account-actions">
            {mode === "metamask" && (
              <p className="small">
                Local prototype · Browser keys are stored unencrypted. Keep this
                browser&apos;s site data until pending posts finish.
              </p>
            )}
            <button
              id="copyAddress"
              disabled={view.busy || !view.address}
              onClick={controller.copyAddress}
            >
              {view.copied ? "Copied" : "Copy address"}
            </button>
            {view.hasLocalAccount && (
              <>
                <button
                  id="backupAccount"
                  disabled={view.busy}
                  onClick={() => downloadBackup(controller)}
                >
                  Download backup
                </button>
                <p className="small">
                  Back up this browser account before clearing site data. Keep
                  the backup private.
                </p>
              </>
            )}
            <button
              disabled={view.busy}
              onClick={() => void controller.disconnect()}
            >
              Switch wallet
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
