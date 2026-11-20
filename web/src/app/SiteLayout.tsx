import { type ReactNode, useSyncExternalStore } from "react";

import { AsciiClouds } from "../appearance/AsciiClouds";
import { SiteHeader } from "../appearance/SiteHeader";
import { useTheme } from "../appearance/theme";
import { WalletPanel } from "../features/wallet/WalletPanel";
import { NotificationToasts } from "../ui/NotificationToasts";
import type { BillboardController } from "./types";

export function SiteLayout({
  controller,
  children,
}: {
  controller: BillboardController;
  children: ReactNode;
}) {
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
      <SiteHeader>
        <WalletPanel view={view} controller={controller} />
      </SiteHeader>
      <div className="product-layout">{children}</div>
      <NotificationToasts view={view} />
    </div>
  );
}
