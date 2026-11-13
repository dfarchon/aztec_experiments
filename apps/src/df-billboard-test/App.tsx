import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";

import { AsciiClouds } from "./AsciiClouds";
import { BoardGuide } from "./BoardGuide";
import { Brand } from "./Brand";
import { Feed } from "./Feed";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { LoadingIcon } from "./LoadingIcon";
import { NotificationToasts } from "./NotificationToasts";
import { ReadingSettings } from "./ReadingSettings";
import type { BillboardController, BillboardView } from "./types";
import { WalletPanel } from "./WalletPanel";

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
              {entry.type === "working" && <LoadingIcon />}[{entry.time}]{" "}
              {entry.message}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function App({
  controller,
  development = false,
}: {
  controller: BillboardController;
  development?: boolean;
}) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [guideReplay, setGuideReplay] = useState(0);
  const [params, setParams] = useSearchParams();
  const selected = params.get("view");
  const section = selected === "settings" ? "settings" : "board";
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
  const pendingPost =
    view.walletMode === "metamask" && Boolean(view.request.pending);
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
              <button
                className={`header-action nav-item nav-settings${section === "settings" ? " active" : ""}`}
                aria-current={section === "settings" ? "page" : undefined}
                onClick={() => navigate("settings")}
              >
                <strong>Settings</strong>
              </button>
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
              <h1>Settings</h1>
              {section === "settings" && (
                <button
                  type="button"
                  className="guide-replay"
                  onClick={() => {
                    navigate("board");
                    setGuideReplay((value) => value + 1);
                  }}
                >
                  Show guide
                </button>
              )}
            </div>
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
              {development && <DebugPanel view={view} />}
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
              disabled={view.busy || pendingPost}
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
                aria-busy={view.posting}
                aria-label={
                  pendingPost
                    ? "Continue pending post in wallet"
                    : !view.busy && !view.connected
                      ? "Connect to post"
                      : undefined
                }
                disabled={
                  view.busy ||
                  (view.connected &&
                    !pendingPost &&
                    (!view.canPost || !bytes || bytes > 512))
                }
                onClick={() =>
                  pendingPost || !view.connected
                    ? controller.setWalletPanel(true)
                    : void controller.post()
                }
              >
                {view.posting ? (
                  "Posting…"
                ) : pendingPost ? (
                  "Continue post"
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
                {view.posting ? <LoadingIcon /> : <Icon name="arrow" />}
              </button>
            </div>
          </section>
        </main>
      </div>
      <footer className="site-footer">
        <a className="documentation-link" href="/billboard-readme.md">
          About ↗
        </a>
      </footer>
      <NotificationToasts view={view} />
      <BoardGuide active={section === "board"} replay={guideReplay} />
    </div>
  );
}
