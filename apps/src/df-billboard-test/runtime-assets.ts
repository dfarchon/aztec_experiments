const loaded = new Set<string>();
let ready: Promise<void> | undefined;

export function loadAztecRuntime(): Promise<void> {
  return (ready ??= (async () => {
    for (const src of ["/aztec_bundle.js", "/df-wallet-runtime.js"]) {
      if (loaded.has(src)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        const fail = (message: string) => {
          clearTimeout(timer);
          script.onload = script.onerror = null;
          script.remove();
          reject(new Error(message));
        };
        const timer = setTimeout(
          () => fail(`Loading ${src} timed out. Please retry.`),
          120_000
        );
        script.src = src;
        script.onload = () => {
          clearTimeout(timer);
          loaded.add(src);
          resolve();
        };
        script.onerror = () => fail(`Unable to load ${src}`);
        document.head.append(script);
      });
    }
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
