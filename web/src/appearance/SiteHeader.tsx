import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../ui/Icon";
import { Brand } from "./Brand";

export function SiteHeader({
  children,
  settings,
}: {
  children?: ReactNode;
  settings?: ReactNode;
}) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <div className="header-actions">
          <Link
            to="/about"
            className="header-control info-link"
            aria-label="About Notch"
            title="About Notch"
          >
            <Icon name="info" />
          </Link>
          {settings}
          {children}
        </div>
      </div>
    </header>
  );
}
