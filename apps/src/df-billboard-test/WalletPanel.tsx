import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";

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

function networkLabel(nodeUrl?: string) {
  if (!nodeUrl) return "Connecting";
  try {
    const host = new URL(nodeUrl).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(host)
      ? "Aztec · Local"
      : `Aztec · ${host}`;
  } catch {
    return "Aztec · Unverified network";
  }
}

export function WalletPanel({ view, controller }: ViewProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const locked = view.busy || view.connected || view.pendingConnection;
  const mode = view.walletMode;
  const change =
    (name: "savedAccount" | "account" | "accountLabel" | "provider") =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      controller.setField(name, event.target.value);
  const connectLabel =
    mode === "extension"
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
          <select
            id="walletMode"
            value={mode}
            disabled={locked}
            onChange={(event) =>
              controller.setField(
                "walletMode",
                event.target.value as WalletMode
              )
            }
          >
            <option value="local">Browser wallet · Saved account</option>
            <option value="create">Browser wallet · Create account</option>
            <option value="import">Browser wallet · Import backup</option>
            <option value="test">
              Browser wallet · Test account (testing only)
            </option>
            <option value="extension">Azguard · Extension wallet</option>
          </select>
          <div id="localOptions" hidden={mode === "extension"}>
            <div id="savedOptions" hidden={mode !== "local"}>
              <label htmlFor="savedAccount">Saved accounts</label>
              <select
                id="savedAccount"
                value={view.savedAccount}
                disabled={locked}
                onChange={change("savedAccount")}
              >
                {!view.savedAccounts.length && (
                  <option value="">
                    No accounts yet. Create or import one.
                  </option>
                )}
                {view.savedAccounts.map((account) => (
                  <option key={account.address} value={account.address}>
                    {account.label || "Aztec account"} ·{" "}
                    {account.address.slice(0, 10)}…{account.address.slice(-6)}
                  </option>
                ))}
              </select>
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
                onChange={change("accountLabel")}
              />
              <p className="small">
                Creates a Schnorr account in this browser. Keys are stored
                locally without encryption. Download a backup after creation and
                do not use a shared computer.
              </p>
            </div>
            <div id="testOptions" hidden={mode !== "test"}>
              <label htmlFor="account">Test account</label>
              <select
                id="account"
                value={view.account}
                disabled={locked}
                onChange={change("account")}
              >
                {view.accounts.map((account) => (
                  <option key={account.value} value={account.value}>
                    {account.label}
                  </option>
                ))}
              </select>
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
            <details className="local-tools">
              <summary>Advanced options</summary>
              <label className="check-label">
                <input
                  id="realProofs"
                  type="checkbox"
                  checked={view.realProofs}
                  disabled={locked}
                  onChange={(event) =>
                    controller.setField("realProofs", event.target.checked)
                  }
                />
                Generate real client proofs in the browser (slower)
              </label>
            </details>
            <div
              id="localStatus"
              className="small"
              role="status"
              aria-live="polite"
            >
              {view.localStatus}
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
              <select
                id="provider"
                aria-label="Aztec extension wallet"
                hidden={view.providers.length < 2}
                disabled={locked}
                value={view.provider}
                onChange={change("provider")}
              >
                {view.providers.map((provider, index) => (
                  <option key={provider.id} value={String(index)}>
                    {provider.name}
                  </option>
                ))}
              </select>
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
              <select
                id="grantedAccount"
                value={view.grantedAccount}
                disabled={view.busy}
                onChange={(event) =>
                  controller.selectGrantedAccount(event.target.value)
                }
              >
                {view.grantedAccounts.map((account) => (
                  <option key={account.value} value={account.value}>
                    {account.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            id="connect"
            type="button"
            disabled={
              locked ||
              !view.deployment ||
              (mode === "local" && !view.savedAccounts.length) ||
              (mode === "test" && !view.accounts.length)
            }
            onClick={controller.connect}
          >
            {connectLabel}
          </button>
        </div>
        <div className="panel-address">
          <span>{networkLabel(view.deployment?.nodeUrl)}</span>
          <span>Current Aztec address</span>
          <span id="address" className="mono">
            {view.address || "Not connected"}
          </span>
        </div>
        {view.connected && (
          <div className="wallet-account-actions">
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
          </div>
        )}
      </section>
    </div>
  );
}
