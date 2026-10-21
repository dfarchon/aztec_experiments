import { createBillboardController } from "./controller.ts";
import { loadAztecRuntime } from "./runtime-assets";

// Kept outside route components: navigation must not discard an active wallet,
// an in-flight transaction, or the user's message draft.
export const controller = createBillboardController();
export async function initializeRuntime(): Promise<void> {
  await loadAztecRuntime();
  window.log = controller.log;
  await controller.initialize();
}
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) controller.dispose();
});
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());
