import { useEffect, useState } from "react";

import { App } from "./App";
import { controller, initializeRuntime } from "./runtime";

export default function BoardRoute() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    initializeRuntime()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (!ready)
    return (
      <main className="shell">
        <span className="eyebrow">DFARCHON / BILLBOARD</span>
        <h1>Opening the board</h1>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <p role="status">Getting the board ready…</p>
        )}
        <a href="/billboard-readme.md">README</a>
      </main>
    );
  return <App controller={controller} development={import.meta.env.DEV} />;
}
