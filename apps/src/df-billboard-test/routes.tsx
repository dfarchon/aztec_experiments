import { lazy, Suspense, useEffect } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

const BoardRoute = lazy(() => import("./BoardRoute"));
const L1PostLabPage = lazy(() => import("./L1PostLabPage"));

export function SiteRoutes() {
  const location = useLocation();
  useEffect(() => {
    document.title = "Billboard · DFArchon";
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  return (
    <Suspense
      fallback={
        <main className="shell">
          <p role="status">Loading page…</p>
        </main>
      }
    >
      <Routes>
        <Route path="/" element={<BoardRoute />} />
        <Route path="/reports" element={<Navigate to="/" replace />} />
        <Route
          path="/fee-lab"
          element={<Navigate to="/l1-post-lab" replace />}
        />
        <Route path="/l1-post-lab" element={<L1PostLabPage />} />
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
            <main className="shell">
              <h1>Page not found</h1>
              <Link to="/">Back to Billboard</Link>
            </main>
          }
        />
      </Routes>
    </Suspense>
  );
}
