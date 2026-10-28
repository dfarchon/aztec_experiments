import { type ReactNode, useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import type { BillboardView } from "./types";

function Toast({
  error = false,
  children,
}: {
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`toast${error ? " toast-error" : ""}`}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {children}
    </div>
  );
}

export function NotificationToasts({ view }: { view: BillboardView }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] =
    useState<BillboardView["actionError"]>(null);
  const [copyResult, setCopyResult] = useState<{
    error: BillboardView["actionError"];
    success: boolean;
  } | null>(null);
  const error = view.actionError;
  const copyLabel =
    copyResult?.error === error
      ? copyResult.success
        ? "Copied"
        : "Copy failed — try again"
      : "Copy full error";
  const copyError = async () => {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error.message);
      setCopyResult({ error, success: true });
    } catch {
      setCopyResult({ error, success: false });
    }
  };
  // The error toast replaces the transient failed-progress notification.
  const progress = error && view.progress?.failed ? null : view.progress;
  useEffect(() => {
    const element = viewport.current;
    const composer = element
      ?.closest(".billboard-app")
      ?.querySelector(".compose-card");
    if (!element || !composer) return;
    const update = () => {
      element.style.setProperty(
        "--composer-clearance",
        `${Math.max(12, window.innerHeight - composer.getBoundingClientRect().top + 12)}px`
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div className="toast-viewport" ref={viewport}>
      {error && error !== dismissed && (
        <Toast error>
          <div className="toast-heading">
            <span className="toast-title">
              <span aria-hidden="true">⚠ </span>
              {error.label} failed
            </span>
            <button
              className="toast-icon"
              aria-label="Dismiss notification"
              onClick={() => setDismissed(error)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="toast-message-row">
            <p className="toast-message">{error.message}</p>
            <button
              className="toast-icon"
              aria-label={copyLabel}
              title={copyLabel}
              onClick={() => void copyError()}
            >
              <Icon
                name={
                  copyResult?.error === error && copyResult.success
                    ? "check"
                    : "copy"
                }
              />
            </button>
          </div>
        </Toast>
      )}
      <div
        id="operationProgress"
        className={`operation-progress${progress?.failed ? " failed" : ""}`}
        hidden={!progress}
      >
        <Toast>
          <div className="operation-progress-text">
            <span id="operationLabel">{progress?.label}</span>
            <span id="operationCount">{progress?.count}</span>
          </div>
          <progress
            id="operationBar"
            max={progress?.total || 1}
            value={progress?.value}
            aria-label="Current operation progress"
          />
        </Toast>
      </div>
    </div>
  );
}
