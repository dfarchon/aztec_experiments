import { createBillboardController } from "./controller.ts";
import { loadAztecRuntime } from "./runtime-assets";

// Kept outside route components: navigation must not discard an active wallet,
// an in-flight transaction, or the user's message draft.
export const controller = createBillboardController();
let ready: Promise<void> | undefined;
export function initializeRuntime(): Promise<void> {
  return (ready ??= (async () => {
    // Share script loading with the isolated L1 posting route.
    await loadAztecRuntime();
    window.log = controller.log;
    await controller.initialize();
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) controller.dispose();
});
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());
