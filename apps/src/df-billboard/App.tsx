import { useSyncExternalStore } from "react";

import { AsciiClouds } from "./AsciiClouds";
import { BoardGuide } from "./BoardGuide";
import { Brand } from "./Brand";
import { Feed } from "./Feed";
import { Hint } from "./Hint";
import { Icon } from "./Icon";
import { LoadingIcon } from "./LoadingIcon";
import { NotificationToasts } from "./NotificationToasts";
import { useTheme } from "./theme";
import { ThemeToggle } from "./ThemeToggle";
import type { BillboardController } from "./types";
import { WalletPanel } from "./WalletPanel";

export function App({ controller }: { controller: BillboardController }) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const bytes = new TextEncoder().encode(view.message).length;
  const theme = useTheme();
  const pendingPost =
    view.walletMode === "metamask" && Boolean(view.request.pending);
  return (
    <div className="billboard-app">
      <AsciiClouds theme={theme} />
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <div className="header-spacer" />
          <div className="header-actions">
            <ThemeToggle />
            <WalletPanel view={view} controller={controller} />
          </div>
        </div>
      </header>
      <div className="product-layout">
        <main id="main-content" className="product-main" tabIndex={-1}>
          <div className="board-content is-board">
            <div className="board-page">
              <Feed view={view} controller={controller} />
            </div>
          </div>
          <section className="card compose-card" aria-label="Write a post">
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
                  Posts are public and stored onchain. The author address is not
                  shown, but network metadata may allow correlation. Up to 512
                  UTF-8 bytes and 10 posts per rolling 24 hours. Posting
                  requires an available sponsor.
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
      <NotificationToasts view={view} />
      <BoardGuide />
    </div>
  );
}
