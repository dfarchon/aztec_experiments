import { useEffect } from "react";

import { App } from "./App";
import { controller, initializeRuntime } from "./runtime";

export default function BoardRoute() {
  useEffect(() => {
    // Errors are shown inside the board, which stays usable while loading.
    void initializeRuntime().catch(() => {});
  }, []);
  return <App controller={controller} development={import.meta.env.DEV} />;
}
