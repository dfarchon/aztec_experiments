export type Environment = "local" | "testnet";
export const SDK_VERSION = "6.0.0";
export function environment(value: unknown): Environment {
  if (value === undefined || value === "local") return "local";
  if (value === "testnet") return value;
  throw new Error("Unsupported deployment environment");
}
export function networkPolicy(env: Environment) {
  return env === "local"
    ? {
        chainId: 31337,
        realProofs: false,
        chainName: "Billboard Local Anvil",
        currency: "Local ETH",
      }
    : {
        chainId: 11155111,
        realProofs: true,
        chainName: "Sepolia",
        currency: "Sepolia ETH",
      };
}
export function validateRpc(url: string, env: Environment) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    (env === "local"
      ? !local || parsed.protocol !== "http:"
      : local || parsed.protocol !== "https:")
  )
    throw new Error(`Invalid ${env} RPC URL`);
}
export function validateChain(
  env: Environment,
  config: { rollupAddress: string; rollupVersion?: string | number },
  info: {
    l1ChainId: number;
    nodeVersion: string;
    realProofs: boolean;
    rollupVersion: string | number;
  },
  rollup: string
) {
  const policy = networkPolicy(env);
  if (
    (env === "testnet" && !config.rollupVersion) ||
    Number(info.l1ChainId) !== policy.chainId ||
    info.nodeVersion !== SDK_VERSION ||
    info.realProofs !== policy.realProofs ||
    rollup.toLowerCase() !== config.rollupAddress.toLowerCase() ||
    (config.rollupVersion !== undefined &&
      String(info.rollupVersion) !== String(config.rollupVersion))
  )
    throw new Error(
      "Deployment does not match the selected chain. Check version, rollup and proof mode."
    );
}
// Local time travel is available only after the caller verifies the local chain.
// Public networks are read-only while waiting; timeout preserves the paid request.
export async function waitForInbox(
  env: Environment,
  ready: () => Promise<boolean>,
  advanceLocal: () => Promise<unknown>,
  progress: (text: string) => void,
  cancelled: () => boolean,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
) {
  const attempts = env === "local" ? 20 : 3;
  for (let i = 0; i < attempts; i++) {
    if (cancelled())
      throw new Error(
        "Posting session closed. Resume the saved request later."
      );
    if (await ready()) return;
    progress("Waiting for the request to reach Aztec…");
    if (env === "local") await advanceLocal();
    await sleep(env === "local" ? 1000 : 5000);
  }
  if (cancelled() || !(await ready()))
    throw new Error(
      "Request is not ready on Aztec. Resume later without paying again."
    );
}
