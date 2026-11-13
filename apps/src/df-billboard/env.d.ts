/// <reference types="vite/client" />
import type { BillboardController } from "./types";
declare global {
  interface Window {
    log: BillboardController["log"];
  }
  const __DF_TOXICITY_WORKER_HASH__: string;
}
