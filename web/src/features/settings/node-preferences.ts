import type { NotchDeployment } from "../wallet/wallet-types.ts";

type DeploymentIdentity = Pick<
  NotchDeployment,
  "environment" | "rollupAddress" | "nodeUrl"
>;
type ReadStorage = Pick<Storage, "getItem">;
export interface NodePreference {
  enabled: boolean;
  url: string;
}
export type L1RpcPreference = NodePreference;
export const defaultNodePreference = (): NodePreference => ({
  enabled: false,
  url: "",
});
export const defaultL1RpcPreference = defaultNodePreference;

export function nodePreferenceKey(deployment: DeploymentIdentity) {
  return `notch/node/v1/${deployment.environment ?? "local"}/${deployment.rollupAddress.toLowerCase()}`;
}
export function l1RpcPreferenceKey(
  deployment: Pick<NotchDeployment, "environment" | "l1Stake">
) {
  return `notch/l1-rpc/v1/${deployment.environment ?? "local"}/${deployment.l1Stake.chainId}/${deployment.l1Stake.portal.toLowerCase()}`;
}
export function readNodePreference(
  storage: ReadStorage | undefined,
  deployment: DeploymentIdentity
): NodePreference {
  try {
    const raw = storage?.getItem(nodePreferenceKey(deployment));
    if (!raw) return defaultNodePreference();
    const value = JSON.parse(raw);
    if (typeof value?.enabled !== "boolean" || typeof value?.url !== "string")
      return defaultNodePreference();
    return { enabled: value.enabled, url: value.url };
  } catch {
    return defaultNodePreference();
  }
}
export function saveNodePreference(
  storage: Pick<Storage, "setItem">,
  deployment: DeploymentIdentity,
  preference: NodePreference
) {
  storage.setItem(nodePreferenceKey(deployment), JSON.stringify(preference));
}
export function readL1RpcPreference(
  storage: ReadStorage | undefined,
  deployment: Pick<NotchDeployment, "environment" | "l1Stake">
): L1RpcPreference {
  try {
    const raw = storage?.getItem(l1RpcPreferenceKey(deployment));
    if (!raw) return defaultL1RpcPreference();
    const value = JSON.parse(raw);
    if (typeof value?.enabled !== "boolean" || typeof value?.url !== "string")
      return defaultL1RpcPreference();
    return { enabled: value.enabled, url: value.url };
  } catch {
    return defaultL1RpcPreference();
  }
}
export function saveL1RpcPreference(
  storage: Pick<Storage, "setItem">,
  deployment: Pick<NotchDeployment, "environment" | "l1Stake">,
  preference: L1RpcPreference
) {
  storage.setItem(l1RpcPreferenceKey(deployment), JSON.stringify(preference));
}
export function applyNodePreference<T extends DeploymentIdentity>(
  deployment: T,
  preference: NodePreference
) {
  return {
    ...deployment,
    nodeUrl: preference.enabled ? preference.url : deployment.nodeUrl,
    customNode: preference.enabled,
  };
}
export function applyL1RpcPreference<
  T extends Pick<NotchDeployment, "l1Stake">,
>(deployment: T, preference: L1RpcPreference) {
  return {
    ...deployment,
    walletL1RpcUrl: deployment.l1Stake.rpcUrl,
    l1Stake: {
      ...deployment.l1Stake,
      rpcUrl: preference.enabled ? preference.url : deployment.l1Stake.rpcUrl,
    },
    customL1Rpc: preference.enabled,
  };
}
