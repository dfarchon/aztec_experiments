import type { Eip1193Provider } from "ethers";

type Injected = Eip1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  providers?: Injected[];
  on?(event: string, callback: () => void): void;
  removeListener?(event: string, callback: () => void): void;
};
export async function findMetaMask(): Promise<Injected> {
  const provider = await new Promise<Injected | undefined>((resolve) => {
    const found: Injected[] = [];
    const announce = (event: Event) => {
      const detail = (
        event as CustomEvent<{ info: { rdns: string }; provider: Injected }>
      ).detail;
      if (detail?.info.rdns === "io.metamask") found.push(detail.provider);
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", announce);
      const injected = (window as Window & { ethereum?: Injected }).ethereum;
      resolve(
        found[0] ||
          (injected?.providers || [injected]).find(
            (item) => item?.isMetaMask && !item.isRabby
          )
      );
    }, 200);
  });
  if (!provider)
    throw new Error(
      "MetaMask was not found. Open this site in a browser with the extension installed."
    );
  return provider;
}

export async function switchLocalEthereumChain(
  provider: Awaited<ReturnType<typeof findMetaMask>>,
  chainId: string,
  rpcUrl: string
) {
  if ((await provider.request({ method: "eth_chainId" })) === chainId) return;
  const switchChain = () =>
    provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  try {
    await switchChain();
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Billboard Local Anvil",
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: "Local ETH", symbol: "ETH", decimals: 18 },
        },
      ],
    });
    await switchChain();
  }
}
