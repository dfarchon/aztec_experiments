import { useSyncExternalStore } from "react";

import { AsciiClouds } from "../appearance/AsciiClouds";
import { BoardGuide } from "../appearance/BoardGuide";
import { Brand } from "../appearance/Brand";
import { useTheme } from "../appearance/theme";
import { ThemeToggle } from "../appearance/ThemeToggle";
import { Composer } from "../features/feed/Composer.tsx";
import { Feed } from "../features/feed/Feed";
import { WalletPanel } from "../features/wallet/WalletPanel";
import { NotificationToasts } from "../ui/NotificationToasts";
import type { BillboardController } from "./types";

export function App({ controller }: { controller: BillboardController }) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const theme = useTheme();
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
          <Composer view={view} controller={controller} />
        </main>
      </div>
      <NotificationToasts view={view} />
      <BoardGuide />
    </div>
  );
}
