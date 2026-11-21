// Shared browser/CLI policy. Network selection must never follow the connected wallet implicitly.
export const PUBLIC_NETWORKS = {
  testnet: {
    chainId: 11155111,
    realProofs: true,
    chainName: "Sepolia",
    currency: "Sepolia ETH",
  },
  mainnet: {
    chainId: 1,
    realProofs: true,
    chainName: "Ethereum Mainnet",
    currency: "Ether",
  },
};

export function publicNetwork(environment = "testnet") {
  if (environment !== "testnet" && environment !== "mainnet")
    throw new Error("Unsupported public deployment environment");
  return PUBLIC_NETWORKS[environment];
}
