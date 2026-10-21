import { useEffect, useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";

import { AsciiClouds } from "./AsciiClouds";
import { Brand } from "./Brand";
import { Feed } from "./Feed";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { ReadingSettings } from "./ReadingSettings";
import { RequestRecovery } from "./RequestRecovery";
import type {
  BillboardController,
  BillboardView,
  Progress as ProgressData,
} from "./types";
import { WalletPanel } from "./WalletPanel";

function Progress({ progress }: { progress: ProgressData | null }) {
  const toastRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toast = toastRef.current;
    const composer = toast
      ?.closest(".billboard-app")
      ?.querySelector(".compose-card");
    if (!toast || !composer) return;
    // On small screens, keep the toast above the composer, including fee notices.
    const update = () => {
      toast.style.setProperty(
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
    <div
      id="operationProgress"
      ref={toastRef}
      className={`operation-progress${progress?.failed ? " failed" : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      hidden={!progress}
    >
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
    </div>
  );
}

function DebugPanel({ view }: { view: BillboardView }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [view.logs]);
  return (
    <details className="card debug-card">
      <summary>Connection details & activity log</summary>
      <div className="debug-inner">
        <dl className="debug-grid">
          {[
            ["RPC", "rpcAddress", "nodeUrl"],
            ["Billboard", "boardAddress", "board"],
            ["Sponsored FPC", "sponsorAddress", "sponsoredFpc"],
          ].map(([label, id, key]) => (
            <div className="debug-pair" key={key}>
              <dt>{label}</dt>
              <dd id={id}>
                {String(
                  view.deployment?.[
                    key as keyof NonNullable<BillboardView["deployment"]>
                  ] || "Loading…"
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div
          id="log"
          ref={logRef}
          className="status-container"
          aria-live="polite"
        >
          {view.logs.map((entry) => (
            <div key={entry.id} className={`status ${entry.type}`}>
              {entry.type === "working" && <span className="spinner" />}[
              {entry.time}] {entry.message}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function App({ controller }: { controller: BillboardController }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [params, setParams] = useSearchParams();
  const selected = params.get("view");
  const section =
    selected === "settings" || selected === "activity" ? selected : "board";
  const navigate = (value: string) => {
    setParams(value === "board" ? {} : { view: value });
  };
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [section]);
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const bytes = new TextEncoder().encode(view.message).length;
  const pending = view.request.jobs.filter(
    (job) => job.postId === undefined
  ).length;
  const title = {
    board: "Public board",
    settings: "Settings",
    activity: "Activity",
  }[section];
  return (
    <div className="billboard-app">
      <AsciiClouds paused={view.busy} />
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <div className="header-spacer" />
          <div className="header-actions">
            <nav
              className="product-navigation"
              aria-label="Billboard navigation"
            >
              {(
                [
                  ["settings", "Settings"],
                  ["activity", "Activity"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  hidden={
                    key === "activity" && !pending && section !== "activity"
                  }
                  className={`header-action nav-item nav-${key}${section === key ? " active" : ""}`}
                  aria-current={section === key ? "page" : undefined}
                  onClick={() => navigate(key)}
                >
                  <strong>{label}</strong>
                  {key === "activity" && pending > 0 && (
                    <span className="nav-count">{pending}</span>
                  )}
                </button>
              ))}
            </nav>
            <WalletPanel view={view} controller={controller} />
          </div>
        </div>
      </header>
      <div className="product-layout">
        <main id="main-content" className="product-main" tabIndex={-1}>
          <div
            className={`board-content${section === "board" ? " is-board" : ""}`}
            ref={mainRef}
          >
            <div className="page-heading" hidden={section === "board"}>
              {section !== "board" && (
                <button
                  className="back-button"
                  aria-label="Back to board"
                  onClick={() => navigate("board")}
                >
                  <span aria-hidden="true">←</span> Back
                </button>
              )}
              <h1>{title}</h1>
            </div>
            {view.actionError && (
              <section className="action-error" role="alert">
                <span>⚠ {view.actionError.label} failed</span>
                <details>
                  <summary>View details</summary>
                  <p>{view.actionError.guidance}</p>
                  <pre>{view.actionError.message}</pre>
                </details>
              </section>
            )}
            <div className="board-page" hidden={section !== "board"}>
              <Feed view={view} controller={controller} />
            </div>
            <section
              hidden={section !== "settings"}
              className="preferences-page"
              aria-label="Settings"
            >
              <p className="section-description">
                Filters only change your view. Originals remain available.
              </p>
              <ReadingSettings view={view} controller={controller} />
              <details className="advanced-settings">
                <summary>Advanced</summary>
                <DebugPanel view={view} />
              </details>
            </section>
            <section
              hidden={section !== "activity"}
              className="activity-page"
              aria-label="Publishing activity"
            >
              {view.request.jobs.length > 0 && (
                <section aria-label="MetaMask posts">
                  <h2>MetaMask posts</h2>
                  {view.request.jobs.map((job) => (
                    <details key={job.commitment}>
                      <summary>
                        {job.postId === undefined
                          ? "Pending post"
                          : `Post #${job.postId}`}
                      </summary>
                      <p>{job.text}</p>
                      <p className="mono">L1: {job.l1Tx || "Unknown"}</p>
                      <p className="mono">L2: {job.l2Tx || "Pending"}</p>
                    </details>
                  ))}
                </section>
              )}
              {!view.request.jobs.length && (
                <div className="empty-state">
                  <Icon name="activity" />
                  <h2>No MetaMask posts yet</h2>
                  <p>Your MetaMask posting requests will appear here.</p>
                  <button onClick={() => navigate("board")}>
                    Go to public board
                  </button>
                </div>
              )}
            </section>
          </div>
          <section
            className="card compose-card"
            aria-label="Write a post"
            hidden={section !== "board"}
          >
            <label htmlFor="message" className="sr-only">
              Message
            </label>
            <textarea
              id="message"
              rows={2}
              placeholder="Leave a message…"
              value={view.message}
              disabled={
                view.busy ||
                (view.walletMode === "metamask" &&
                  view.request.jobs.some((job) => job.postId === undefined))
              }
              onChange={(event) =>
                controller.setField("message", event.target.value)
              }
            />
            <div className="compose-footer">
              <div className="compose-cost">
                <span className="sponsored-label">
                  {view.walletMode === "metamask"
                    ? "You pay L1 gas · L2 sponsored"
                    : "L2 fees sponsored"}
                </span>
                <Hint label="About posting">
                  Posts are public and stored onchain; filtering does not delete
                  them. The author address is not shown, but network metadata
                  may allow correlation. Up to 512 UTF-8 bytes and 10 posts per
                  rolling 24 hours. Posting requires an available sponsor.
                </Hint>
                <span
                  id="bytes"
                  className={bytes > 512 ? "over-limit" : ""}
                  role="status"
                >
                  {bytes} / 512 bytes
                </span>
              </div>
              <button
                id="post"
                type="button"
                aria-label={
                  !view.busy && !view.connected ? "Connect to post" : undefined
                }
                disabled={
                  view.busy ||
                  (view.connected && (!view.canPost || !bytes || bytes > 512))
                }
                onClick={() =>
                  view.connected
                    ? void controller.post()
                    : controller.setWalletPanel(true)
                }
              >
                {view.busy ? (
                  "Processing…"
                ) : view.connected ? (
                  "Post"
                ) : (
                  <>
                    <span className="post-connect-label">Connect to post</span>
                    <span
                      className="post-connect-label-mobile"
                      aria-hidden="true"
                    >
                      Connect
                    </span>
                  </>
                )}{" "}
                <Icon name="arrow" />
              </button>
            </div>
            <RequestRecovery view={view} controller={controller} />
          </section>
        </main>
      </div>
      <footer className="site-footer">
        <a className="documentation-link" href="/billboard-readme.md">
          About ↗
        </a>
      </footer>
      <Progress progress={view.progress} />
    </div>
  );
}
