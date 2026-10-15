import { createBillboardController } from "./controller.ts";

// Kept outside route components: navigation must not discard an active wallet,
// an in-flight transaction, or the user's message draft.
export const controller = createBillboardController();
let ready: Promise<void> | undefined;
const loaded = new Set<string>();
function loadScript(src: string): Promise<void> {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      loaded.add(src);
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`无法加载 ${src}，请检查站点构建和服务。`));
    };
    document.head.append(script);
  });
}
export function initializeRuntime(): Promise<void> {
  return (ready ??= (async () => {
    // The report route never imports this module or downloads the Aztec SDK.
    for (const src of [
      "/aztec_bundle.js",
      "/df-hash.js",
      "/df-helpers.js",
      "/df-aztec-lib.js",
    ])
      await loadScript(src);
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
