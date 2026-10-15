import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { App } from './App';
import { controller, initializeRuntime } from './runtime';

export default function BoardRoute() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    initializeRuntime().then(() => { if (active) setReady(true); })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [attempt]);
  if (!ready) return <main className="shell"><h1>Dark Forest Billboard</h1>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : <p role="status">正在加载本地 Aztec 环境…</p>}
    <Link to="/reports">查看留言板设计与测试</Link></main>;
  return <App controller={controller} />;
}
