import { useEffect, useState } from "react";

import type { BillboardController, BillboardView } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";
import { type EthereumWallet, listEthereumWallets } from "./l1.ts";

interface ConnectViewProps {
  view: BillboardView;
  controller: BillboardController;
}

export function ConnectView({ view, controller }: ConnectViewProps) {
  const [wallets, setWallets] = useState<EthereumWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selectedWallet, setSelectedWallet] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listEthereumWallets()
      .then((found) => {
        if (active) setWallets(found);
      })
      .catch(() => {
        if (active) setWallets([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  return (
    <div className="notch-wallet-body">
      {loading ? (
        <p>Finding wallets…</p>
      ) : wallets.length ? (
        <div
          className="notch-wallet-choices"
          role="group"
          aria-label="Ethereum wallets"
        >
          {wallets.map((wallet) => (
            <button
              type="button"
              key={wallet.id}
              className="notch-wallet-choice"
              disabled={view.busy || !view.stake.available}
              onClick={() => {
                setSelectedWallet(wallet.id);
                void controller.connect(wallet.provider);
              }}
            >
              {view.connecting && selectedWallet === wallet.id ? (
                <LoadingIcon />
              ) : (
                <Icon name="wallet" />
              )}
              <span>{wallet.name}</span>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
      ) : (
        <p>No Ethereum wallet found.</p>
      )}
      {!view.stake.available && (
        <p>
          {view.actionError?.label === "Load Notch"
            ? "Network unavailable."
            : "Waiting for the network…"}
        </p>
      )}
      {!loading && wallets.length === 0 && (
        <button
          type="button"
          className="notch-wallet-switch"
          disabled={view.busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh wallets
        </button>
      )}
    </div>
  );
}
