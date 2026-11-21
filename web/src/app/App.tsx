import { useSyncExternalStore } from "react";

import { BoardGuide } from "../appearance/BoardGuide";
import { Composer } from "../features/feed/Composer.tsx";
import { Feed } from "../features/feed/Feed";
import type { BillboardController } from "./types";

export function App({ controller }: { controller: BillboardController }) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  return (
    <>
      <main id="main-content" className="product-main" tabIndex={-1}>
        <div className="board-content is-board">
          <div className="board-page">
            <Feed view={view} controller={controller} />
          </div>
        </div>
        <Composer view={view} controller={controller} />
      </main>

      <BoardGuide />
    </>
  );
}
