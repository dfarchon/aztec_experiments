import { useEffect, useRef, useState } from "react";

import type { ViewProps } from "../../app/types.ts";
import { setTheme, useTheme } from "../../appearance/theme.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import type { NotchDeployment } from "../wallet/wallet-types.ts";
import { testNodeConnection } from "./node-connection.ts";
import {
  applyL1RpcPreference,
  defaultL1RpcPreference,
  defaultNodePreference,
  type L1RpcPreference,
  type NodePreference,
  readL1RpcPreference,
  readNodePreference,
  saveL1RpcPreference,
  saveNodePreference,
} from "./node-preferences.ts";

export function SettingsPanel({ view }: ViewProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [deployment, setDeployment] = useState<NotchDeployment | null>(null);
  const [preference, setPreference] = useState<NodePreference>(
    defaultNodePreference
  );
  const [l1Preference, setL1Preference] = useState<L1RpcPreference>(
    defaultL1RpcPreference
  );
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [l1Checking, setL1Checking] = useState(false);
  const [testedUrl, setTestedUrl] = useState<string | null>(null);
  const [testedL1Url, setTestedL1Url] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [loading, setLoading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | null>(null);
  const locked = view.busy || view.connecting || view.restoring || view.posting;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const nodeVerified =
    testedUrl !== null && testedUrl === preference.url.trim();
  const l1Verified =
    testedL1Url !== null && testedL1Url === l1Preference.url.trim();
  const controlsDisabled =
    locked || checking || l1Checking || applying || loading || !deployment;

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    closeButton.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    operation.current = abort;
    const modal = dialog.current;
    setTestedUrl(null);
    setTestedL1Url(null);
    setApplying(false);
    setError("");
    void fetch("/df-local.json", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Unable to load network configuration. Close settings and try again."
          );
        const base: NotchDeployment = await response.json();
        if (abort.signal.aborted) return;
        if (base.kind !== "notch-stake" || !base.rollupAddress || !base.l1Stake)
          throw new Error("Network configuration is unavailable.");
        setDeployment(base);
        let store: Storage | undefined;
        try {
          store = window.localStorage;
        } catch {
          /* Storage can be disabled. */
        }
        setPreference(readNodePreference(store, base));
        setL1Preference(readL1RpcPreference(store, base));
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load settings."
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      operation.current?.abort();
      modal?.close();
    };
  }, [open]);

  function close() {
    operation.current?.abort();
    setChecking(false);
    setL1Checking(false);
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  async function testNode() {
    if (!deployment || lockedRef.current || checking || l1Checking || applying)
      return;
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    setChecking(true);
    setTestedUrl(null);
    setError("");
    try {
      const endpoint = await testNodeConnection(
        deployment,
        preference.url,
        abort.signal
      );
      if (!abort.signal.aborted) setTestedUrl(endpoint);
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Unable to test this node."
        );
    } finally {
      if (!abort.signal.aborted) setChecking(false);
    }
  }
  async function testL1() {
    if (!deployment || lockedRef.current || checking || l1Checking || applying)
      return;
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    setL1Checking(true);
    setTestedL1Url(null);
    setError("");
    try {
      const { testL1RpcConnection } = await import("./l1-connection.ts");
      const endpoint = await testL1RpcConnection(
        applyL1RpcPreference(deployment, { ...l1Preference, enabled: true }),
        l1Preference.url,
        abort.signal
      );
      if (!abort.signal.aborted) setTestedL1Url(endpoint);
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to test this L1 RPC."
        );
    } finally {
      if (!abort.signal.aborted) setL1Checking(false);
    }
  }
  function apply() {
    if (!deployment || lockedRef.current || checking || l1Checking || applying)
      return;
    setError("");
    if (preference.enabled && !nodeVerified) {
      setError("Test this node before applying it.");
      return;
    }
    if (l1Preference.enabled && !l1Verified) {
      setError("Test this L1 RPC before applying it.");
      return;
    }
    try {
      saveNodePreference(window.localStorage, deployment, {
        ...preference,
        url: preference.enabled ? testedUrl! : preference.url,
      });
      saveL1RpcPreference(window.localStorage, deployment, {
        ...l1Preference,
        url: l1Preference.enabled ? testedL1Url! : l1Preference.url,
      });
      setApplying(true);
      window.location.reload();
    } catch {
      setError(
        "Your browser could not save this setting. Check site storage permissions."
      );
    }
  }

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="header-control settings-toggle"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={view.walletOpen}
        onClick={() => {
          setLoading(true);
          setOpen(true);
        }}
      >
        <Icon name="settings" />
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="notch-settings-dialog"
          aria-labelledby="settings-title"
          aria-busy={loading || checking || l1Checking || applying}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              close();
          }}
        >
          <div className="settings-head">
            <div className="settings-heading">
              <h2 id="settings-title">Settings</h2>
              <span className="settings-info">
                <button
                  type="button"
                  className="settings-info-button"
                  aria-label="RPC settings help"
                  aria-describedby="settings-rpc-help"
                >
                  <Icon name="info" />
                </button>
                <span
                  id="settings-rpc-help"
                  className="settings-info-tooltip"
                  role="tooltip"
                >
                  Aztec custom URLs may use localhost. L1 RPCs must serve the
                  selected network and archive logs for recovery. Choices stay
                  in this browser; Apply reloads the page.
                </span>
              </span>
            </div>
            <button
              ref={closeButton}
              type="button"
              className="settings-close"
              aria-label="Close settings"
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </div>
          <section
            className="settings-section"
            aria-labelledby="settings-theme"
          >
            <h3 id="settings-theme">Appearance</h3>
            <div
              className="settings-theme-options"
              role="group"
              aria-label="Theme"
            >
              {(["dark", "light"] as const).map((choice) => (
                <button
                  type="button"
                  key={choice}
                  aria-pressed={theme === choice}
                  onClick={() => setTheme(choice)}
                >
                  <Icon name={choice === "dark" ? "moon" : "sun"} />
                  {choice === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
          </section>
          <div className="settings-rpc-grid">
            <section
              className="settings-section"
              aria-labelledby="settings-node"
            >
              <div className="settings-node-head">
                <h3 id="settings-node">Aztec node</h3>
                <span className="settings-network">
                  {deployment?.environment === "mainnet"
                    ? "Mainnet"
                    : deployment?.environment === "testnet"
                      ? "Testnet"
                      : deployment
                        ? "Local"
                        : ""}
                </span>
              </div>
              <label className="settings-switch-label">
                <span>Connect to your own node</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={preference.enabled}
                  disabled={
                    locked ||
                    checking ||
                    l1Checking ||
                    applying ||
                    loading ||
                    !deployment
                  }
                  onChange={(event) => {
                    setPreference({
                      ...preference,
                      enabled: event.target.checked,
                    });
                    setError("");
                    setTestedUrl(null);
                  }}
                />
              </label>
              {preference.enabled ? (
                <div className="settings-node-input">
                  <label htmlFor="settings-node-url">Node URL</label>
                  <div className="settings-node-row">
                    <input
                      id="settings-node-url"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="http://localhost:8080"
                      value={preference.url}
                      disabled={locked || checking || l1Checking || applying}
                      aria-describedby="settings-node-result"
                      onChange={(event) => {
                        setPreference({
                          ...preference,
                          url: event.target.value,
                        });
                        setTestedUrl(null);
                        setError("");
                      }}
                    />
                    <button
                      type="button"
                      className="settings-test"
                      aria-busy={checking}
                      disabled={
                        !deployment ||
                        loading ||
                        locked ||
                        checking ||
                        l1Checking ||
                        applying ||
                        !preference.url.trim()
                      }
                      onClick={() => void testNode()}
                    >
                      {checking ? "Testing…" : "Test"}
                    </button>
                  </div>
                  <p
                    id="settings-node-result"
                    className={
                      nodeVerified ? "settings-node-success" : "settings-help"
                    }
                    role="status"
                  >
                    {checking
                      ? "Checking node…"
                      : nodeVerified
                        ? "Verified. Apply to use this node."
                        : "Test before Apply."}
                  </p>
                </div>
              ) : (
                <p className="settings-help">Using default Aztec node.</p>
              )}
            </section>
            <section className="settings-section" aria-labelledby="settings-l1">
              <div className="settings-node-head">
                <h3 id="settings-l1">Ethereum L1 RPC</h3>
                <span className="settings-network">
                  {deployment?.environment === "mainnet"
                    ? "Ethereum"
                    : deployment?.environment === "testnet"
                      ? "Sepolia"
                      : deployment
                        ? "Local"
                        : ""}
                </span>
              </div>
              <label className="settings-switch-label">
                <span>Use my own L1 RPC</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={l1Preference.enabled}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    setL1Preference({
                      ...l1Preference,
                      enabled: event.target.checked,
                    });
                    setTestedL1Url(null);
                    setError("");
                  }}
                />
              </label>
              {l1Preference.enabled ? (
                <div className="settings-node-input">
                  <label htmlFor="settings-l1-url">RPC URL</label>
                  <div className="settings-node-row">
                    <input
                      id="settings-l1-url"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="https://your-ethereum-rpc.example"
                      value={l1Preference.url}
                      disabled={locked || checking || l1Checking || applying}
                      aria-describedby="settings-l1-result"
                      onChange={(event) => {
                        setL1Preference({
                          ...l1Preference,
                          url: event.target.value,
                        });
                        setTestedL1Url(null);
                        setError("");
                      }}
                    />
                    <button
                      type="button"
                      className="settings-test"
                      aria-busy={l1Checking}
                      disabled={controlsDisabled || !l1Preference.url.trim()}
                      onClick={() => void testL1()}
                    >
                      {l1Checking ? "Testing…" : "Test"}
                    </button>
                  </div>
                  <p
                    id="settings-l1-result"
                    className={
                      l1Verified ? "settings-node-success" : "settings-help"
                    }
                    role="status"
                  >
                    {l1Checking
                      ? "Checking L1 RPC…"
                      : l1Verified
                        ? "Verified. Apply to use this L1 RPC."
                        : "Test before Apply."}
                  </p>
                </div>
              ) : (
                <p className="settings-help">Using default Ethereum RPC.</p>
              )}
            </section>
          </div>
          {locked && (
            <p className="settings-notice" role="status">
              Finish the current wallet operation before switching RPCs.
            </p>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="settings-default"
              disabled={
                !deployment ||
                loading ||
                locked ||
                checking ||
                l1Checking ||
                applying
              }
              onClick={() => {
                setPreference({ ...preference, enabled: false });
                setL1Preference({ ...l1Preference, enabled: false });
                setTestedUrl(null);
                setTestedL1Url(null);
                setError("");
              }}
            >
              Use defaults
            </button>
            <button
              type="button"
              className="settings-apply"
              disabled={
                !deployment ||
                loading ||
                locked ||
                checking ||
                l1Checking ||
                applying ||
                (preference.enabled && !nodeVerified) ||
                (l1Preference.enabled && !l1Verified)
              }
              onClick={apply}
            >
              {applying && <LoadingIcon />}
              <span>{applying ? "Applying…" : "Apply"}</span>
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
