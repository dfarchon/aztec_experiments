// Injected Ethereum wallet discovery and authorization helpers.
import type { Eip1193Provider } from "ethers";

import {
  type Environment,
  networkPolicy,
  validateRpc,
} from "../../app/network.ts";

export type InjectedProvider = Eip1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isPhantom?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: InjectedProvider[];
  on?(event: string, callback: () => void): void;
  removeListener?(event: string, callback: () => void): void;
};
export interface EthereumWallet {
  id: string;
  name: string;
  provider: InjectedProvider;
}

function walletName(value: string) {
  const name = value.trim().slice(0, 50);
  if (/^rabby(?: wallet)?$/i.test(name)) return "Rabby";
  if (/^metamask$/i.test(name)) return "MetaMask";
  if (/^phantom(?: wallet)?$/i.test(name)) return "Phantom";
  return name;
}

export const WALLET_APPROVAL_TIMEOUT_MS = 60_000;

export async function waitForWalletApproval<T>(
  request: Promise<T>,
  action: string,
  timeoutMs = WALLET_APPROVAL_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Wallet ${action} timed out. Approve or reject the pending request in your wallet before retrying.`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    if ((error as { code?: number }).code === -32002)
      throw new Error(
        "A wallet request is already pending. Approve or reject it in your wallet before retrying."
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestEthereumAccounts(
  provider: InjectedProvider,
  timeoutMs = WALLET_APPROVAL_TIMEOUT_MS
): Promise<string[]> {
  let method = "eth_accounts";
  try {
    await waitForWalletApproval(
      provider.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      }),
      "account selection",
      timeoutMs
    );
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== -32601 && code !== 4200) throw error;
    method = "eth_requestAccounts";
  }
  return waitForWalletApproval<string[]>(
    provider.request({ method }),
    "connection",
    timeoutMs
  );
}

export async function listEthereumWallets(): Promise<EthereumWallet[]> {
  return new Promise((resolve) => {
    const found: EthereumWallet[] = [];
    const seen = new Set<InjectedProvider>();
    const add = (id: string, name: string, provider?: InjectedProvider) => {
      name = walletName(name);
      if (
        !provider ||
        typeof provider.request !== "function" ||
        seen.has(provider) ||
        found.some((wallet) => wallet.name === name)
      )
        return;
      seen.add(provider);
      found.push({ id, name, provider });
    };
    const announce = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          info: { rdns: string; name: string; uuid: string };
          provider: InjectedProvider;
        }>
      ).detail;
      if (detail?.info?.name)
        add(
          detail.info.rdns || detail.info.uuid,
          detail.info.name,
          detail.provider
        );
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", announce);
      const injected = (window as Window & { ethereum?: InjectedProvider })
        .ethereum;
      for (const [index, provider] of [
        ...(injected?.providers || []),
        injected,
      ].entries()) {
        const name = provider?.isRabby
          ? "Rabby"
          : provider?.isPhantom
            ? "Phantom"
            : provider?.isCoinbaseWallet
              ? "Coinbase Wallet"
              : provider?.isMetaMask
                ? "MetaMask"
                : "Browser wallet";
        add(
          `injected-${index}`,
          name === "Browser wallet" ? `${name} ${index + 1}` : name,
          provider
        );
      }
      resolve(found);
    }, 200);
  });
}

export async function switchEthereumChain(
  provider: InjectedProvider,
  chainId: string,
  rpcUrl: string,
  env: Environment = "local",
  approvalTimeoutMs = WALLET_APPROVAL_TIMEOUT_MS
) {
  validateRpc(rpcUrl, env);
  const policy = networkPolicy(env);
  if (BigInt(chainId) !== BigInt(policy.chainId))
    throw new Error("Unexpected wallet chain");
  if ((await provider.request({ method: "eth_chainId" })) === chainId) return;
  const switchChain = () =>
    waitForWalletApproval(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId }],
      }),
      "network switch",
      approvalTimeoutMs
    );
  try {
    await switchChain();
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await waitForWalletApproval(
      provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: policy.chainName,
            rpcUrls: [rpcUrl],
            nativeCurrency: {
              name: policy.currency,
              symbol: "ETH",
              decimals: 18,
            },
          },
        ],
      }),
      "network setup",
      approvalTimeoutMs
    );
    await switchChain();
  }
}
