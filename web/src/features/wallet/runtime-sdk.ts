import type { AztecRuntimeSdk } from "../../../../runtime/wallet-runtime.mjs";

const SDK_URL = "/aztec_bundle.js";

export type AztecSdk = AztecRuntimeSdk;

let sdkPromise: Promise<AztecSdk> | undefined;

export function loadAztecSdk(): Promise<AztecSdk> {
  return (sdkPromise ??= new Promise<AztecSdk>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = (message: string) => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      script.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`Loading ${SDK_URL} timed out. Please retry.`),
      120_000
    );
    script.src = SDK_URL;
    script.onload = () => {
      clearTimeout(timer);
      const sdk = (window as Window & { __aztec?: AztecSdk }).__aztec;
      if (!sdk) {
        fail("The Aztec SDK loaded without its runtime exports.");
        return;
      }
      resolve(sdk);
    };
    script.onerror = () => fail(`Unable to load ${SDK_URL}`);
    document.head.append(script);
  }).catch((error) => {
    sdkPromise = undefined;
    throw error;
  }));
}
