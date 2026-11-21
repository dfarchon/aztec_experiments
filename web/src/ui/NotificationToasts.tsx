import { useEffect, useRef, useState } from "react";

import type { BillboardView } from "../app/types";
import { Icon } from "./Icon";

type Notification =
  | { error: NonNullable<BillboardView["actionError"]>; progress?: never }
  | { error?: never; progress: NonNullable<BillboardView["progress"]> };

const DISPLAY_MS = 3000;
const EXIT_MS = 180;

export function NotificationToasts({ view }: { view: BillboardView }) {
  const viewport = useRef<HTMLDivElement>(null);
  const incomingError = view.actionError;
  const feedUpdated =
    view.progress?.label === "Refresh posts completed" ||
    view.progress?.label === "Load older posts completed";
  const incomingProgress =
    view.progress?.completed &&
    !feedUpdated &&
    !(incomingError && view.progress.failed)
      ? view.progress
      : null;
  const [toast, setToast] = useState<Notification | null>(() =>
    incomingError
      ? { error: incomingError }
      : incomingProgress
        ? { progress: incomingProgress }
        : null
  );
  const [leaving, setLeaving] = useState(false);
  const sequence = useRef(0);
  const seen = useRef({ error: incomingError, progress: incomingProgress });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { error: incomingError, progress: incomingProgress };
    const next =
      incomingError && incomingError !== previous.error
        ? { error: incomingError }
        : incomingProgress && incomingProgress !== previous.progress
          ? { progress: incomingProgress }
          : null;
    if (next) {
      sequence.current++;
      setLeaving(false);
      setToast(next);
    }
  }, [incomingError, incomingProgress]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setLeaving(true), DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!toast || !leaving) return;
    const timer = setTimeout(() => setToast(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [toast, leaving]);
  const [copyResult, setCopyResult] = useState<{
    error: BillboardView["actionError"];
    success: boolean;
  } | null>(null);
  const error = toast?.error;
  const progress = toast?.progress;
  const failed = Boolean(error || progress?.failed);
  const copyLabel =
    copyResult && copyResult.error === error
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
      <div
        id="operationProgress"
        className={`operation-progress${failed ? " failed" : ""}`}
        hidden={!toast}
      >
        {toast && (
          <div
            key={sequence.current}
            className={`toast${failed ? " toast-error" : ""}${leaving ? " is-leaving" : ""}`}
            role={failed ? "alert" : "status"}
            aria-live={failed ? "assertive" : "polite"}
            aria-atomic="true"
          >
            {error ? (
              <>
                <div className="toast-heading">
                  <span className="toast-title">
                    <Icon name="warning" />
                    {error.label} failed
                  </span>
                  <button
                    className="toast-icon"
                    aria-label="Dismiss notification"
                    onClick={() => setLeaving(true)}
                  >
                    <Icon name="close" />
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
              </>
            ) : (
              <div className="operation-progress-text">
                <span id="operationLabel">{progress?.label}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
