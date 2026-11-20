import { useEffect } from "react";

import { App } from "./App.tsx";
import { controller, initializeRuntime } from "./runtime.ts";

export default function BoardRoute() {
  useEffect(() => {
    // Errors are shown inside the board, which stays usable while loading.
    void initializeRuntime().catch(() => {});
  }, []);
  return <App controller={controller} />;
}
