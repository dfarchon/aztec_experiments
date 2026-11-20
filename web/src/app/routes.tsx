import { lazy, Suspense, useEffect } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { controller } from "./runtime";
import { SiteLayout } from "./SiteLayout";

const BoardRoute = lazy(() => import("./BoardRoute.tsx"));
const AboutRoute = lazy(() => import("./AboutRoute.tsx"));

export function SiteRoutes() {
  const location = useLocation();
  useEffect(() => {
    document.title = location.pathname === "/about" ? "About — Notch" : "Notch";
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  return (
    <SiteLayout controller={controller}>
      <Suspense
        fallback={
          <main id="main-content" className="product-main" tabIndex={-1}>
            <p role="status">Loading page…</p>
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<BoardRoute />} />
          <Route path="/about" element={<AboutRoute />} />
          <Route path="/reports" element={<Navigate to="/" replace />} />
          <Route path="/fee-lab" element={<Navigate to="/" replace />} />
          <Route path="/l1-post-lab" element={<Navigate to="/" replace />} />
          <Route
            path="/df-billboard-test.html"
            element={<Navigate to="/" replace />}
          />
          <Route
            path="/df-billboard-report.html"
            element={<Navigate to="/" replace />}
          />
          <Route
            path="*"
            element={
              <main id="main-content" className="about-page" tabIndex={-1}>
                <h1>Page not found</h1>
                <Link to="/">Back to Notch</Link>
              </main>
            }
          />
        </Routes>
      </Suspense>
    </SiteLayout>
  );
}
