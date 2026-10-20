const loaded = new Set<string>();
let ready: Promise<void> | undefined;

export function loadAztecRuntime(): Promise<void> {
  return (ready ??= (async () => {
    for (const src of [
      "/aztec_bundle.js",
      "/df-helpers.js",
      "/df-aztec-lib.js",
    ]) {
      if (loaded.has(src)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => {
          loaded.add(src);
          resolve();
        };
        script.onerror = () => {
          script.remove();
          reject(new Error(`无法加载 ${src}`));
        };
        document.head.append(script);
      });
    }
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
