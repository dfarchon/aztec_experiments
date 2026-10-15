import { lazy, Suspense, useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';

const BoardRoute = lazy(() => import('./BoardRoute'));
const ReportPage = lazy(() => import('./ReportPage').then(module => ({ default: module.ReportPage })));

export function SiteRoutes() {
  const location = useLocation();
  useEffect(() => {
    document.title = location.pathname.startsWith('/reports') ? '留言板设计与测试 · Dark Forest Billboard' : 'Dark Forest Billboard';
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname]);
  return <Suspense fallback={<main className="shell"><p role="status">正在加载页面…</p></main>}>
    <Routes>
      <Route path="/" element={<BoardRoute />} />
      <Route path="/reports" element={<ReportPage />} />
      <Route path="/df-billboard-test.html" element={<Navigate to="/" replace />} />
      <Route path="/df-billboard-report.html" element={<Navigate to="/reports" replace />} />
      <Route path="*" element={<main className="shell"><h1>页面不存在</h1><Link to="/">返回留言板</Link></main>} />
    </Routes>
  </Suspense>;
}
