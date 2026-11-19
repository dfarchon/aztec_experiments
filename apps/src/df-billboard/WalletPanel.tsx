import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { type EthereumWallet, listEthereumWallets } from "./l1";
import { LoadingIcon } from "./LoadingIcon";
import { MAX_STAKE, postQuota, STAKE_UNIT } from "./stake-policy";
import type { ViewProps } from "./types";

function downloadBackup({ controller }: Pick<ViewProps, "controller">) {
  const backup = controller.accountBackup();
  if (!backup) return;
  const url = URL.createObjectURL(
    new Blob([backup.contents], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = backup.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WalletPanel({ view, controller }: ViewProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [wallets, setWallets] = useState<EthereumWallet[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(true);
  const [walletRefresh, setWalletRefresh] = useState(0);
  const [selectedWallet, setSelectedWallet] = useState("");
  const amount = BigInt(view.stake.amount);
  const quota = postQuota(amount);
  const connected = Boolean(view.stake.payer && view.stake.owner);
  const funded = amount > 0n;
  const step = !connected ? 1 : !funded ? 2 : 3;
  const title = !connected
    ? "Connect your wallet"
    : funded
      ? "Ready to post"
      : "Stake to post";
  const unlockAt = Number(view.stake.lastPost) * 1000 + 86_400_000;
  const withdrawLocked =
    Number(view.stake.lastPost) > 0 && Date.now() < unlockAt;

  useEffect(() => {
    if (view.walletOpen) close.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = view.walletOpen;
  }, [view.walletOpen]);
  useEffect(() => {
    if (!view.walletOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !view.busy)
        controller.setWalletPanel(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [view.walletOpen, view.busy, controller]);
  useEffect(() => {
    if (!view.walletOpen || connected) return;
    let active = true;
    setWalletsLoading(true);
    void listEthereumWallets()
      .then((found) => {
        if (active) setWallets(found);
      })
      .catch(() => {
        if (active) setWallets([]);
      })
      .finally(() => {
        if (active) setWalletsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view.walletOpen, connected, walletRefresh]);

  return (
    <div className="wallet-anchor">
      <button
        id="walletMenu"
        ref={trigger}
        type="button"
        className={`header-control header-action${connected ? " connected" : ""}`}
        disabled={view.busy}
        aria-busy={view.connecting}
        aria-expanded={view.walletOpen}
        aria-controls="walletPanel"
        onClick={() => controller.setWalletPanel(!view.walletOpen)}
      >
        {view.connecting ? <LoadingIcon /> : <Icon name="wallet" />}
        <span id="walletMenuText">
          {connected
            ? `${view.stake.payer.slice(0, 8)}…${view.stake.payer.slice(-6)}`
            : "Connect wallet"}
        </span>
      </button>
      {view.walletOpen && (
        <div
          className="notch-wallet-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !view.busy)
              controller.setWalletPanel(false);
          }}
        >
          <section
            id="walletPanel"
            className="notch-wallet-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="notch-wallet-head">
              <h2>{title}</h2>
              <button
                ref={close}
                type="button"
                aria-label="Close wallet panel"
                disabled={view.busy}
                onClick={() => controller.setWalletPanel(false)}
              >
                ×
              </button>
            </div>
            <ol className="notch-wallet-steps" aria-label="Posting steps">
              {["Connect", "Stake", "Post"].map((label, index) => (
                <li
                  key={label}
                  className={
                    step === index + 1
                      ? "active"
                      : step > index + 1
                        ? "done"
                        : ""
                  }
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {label}
                </li>
              ))}
            </ol>
            {!connected ? (
              <div className="notch-wallet-body">
                {walletsLoading ? (
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
                      ? "Testnet unavailable."
                      : "Waiting for the testnet…"}
                  </p>
                )}
                {!walletsLoading && wallets.length === 0 && (
                  <button
                    type="button"
                    className="notch-wallet-switch"
                    disabled={view.busy}
                    onClick={() => setWalletRefresh((value) => value + 1)}
                  >
                    Refresh wallets
                  </button>
                )}
              </div>
            ) : (
              <div className="notch-wallet-body">
                <p className="notch-wallet-connected">
                  Connected · {view.stake.payer.slice(0, 8)}…
                  {view.stake.payer.slice(-6)}
                </p>
                <div className="notch-wallet-balance">
                  <span>Staked</span>
                  <strong>{(Number(amount) / 1e18).toFixed(4)} ETH</strong>
                  <span>{quota} posts / 24h</span>
                </div>
                {!funded && !view.stake.pendingDeposit && (
                  <>
                    <input
                      ref={restore}
                      className="sr-only"
                      type="file"
                      accept=".json,application/json"
                      aria-label="Restore private account backup"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void controller.importStakeBackup(file);
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="notch-wallet-switch"
                      disabled={view.busy}
                      onClick={() => restore.current?.click()}
                    >
                      Restore backup
                    </button>
                  </>
                )}
                {view.stake.pendingDeposit ? (
                  <>
                    {view.stake.depositPrepared && (
                      <p>Confirm the stake in your L1 wallet.</p>
                    )}
                    {(view.stake.depositNeedsHash ||
                      view.stake.claimNeedsHash) && (
                      <input
                        aria-label={
                          view.stake.claimNeedsHash
                            ? "Existing Aztec claim transaction hash"
                            : "Existing L1 deposit transaction hash"
                        }
                        placeholder={
                          view.stake.claimNeedsHash
                            ? "Aztec claim transaction hash"
                            : "L1 deposit transaction hash"
                        }
                        value={recoveryHash}
                        onChange={(event) =>
                          setRecoveryHash(event.target.value)
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="notch-wallet-primary"
                      disabled={
                        view.busy ||
                        ((view.stake.depositNeedsHash ||
                          view.stake.claimNeedsHash) &&
                          !/^0x[\da-f]{64}$/i.test(recoveryHash))
                      }
                      onClick={() => {
                        void controller.resumeRequest(
                          view.stake.depositNeedsHash ||
                            view.stake.claimNeedsHash
                            ? recoveryHash
                            : undefined,
                          view.stake.claimNeedsHash ? "l2" : "l1"
                        );
                      }}
                    >
                      {view.stake.depositPrepared
                        ? "Confirm stake"
                        : "Continue deposit"}{" "}
                      <Icon name="arrow" />
                    </button>
                  </>
                ) : view.stake.pendingExit ? (
                  <>
                    {view.stake.exitNeedsHash && (
                      <input
                        aria-label="Existing Aztec withdrawal transaction hash"
                        placeholder="Aztec withdrawal transaction hash"
                        value={recoveryHash}
                        onChange={(event) =>
                          setRecoveryHash(event.target.value)
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="notch-wallet-primary"
                      disabled={
                        view.busy ||
                        (view.stake.exitNeedsHash &&
                          !/^0x[\da-f]{64}$/i.test(recoveryHash))
                      }
                      onClick={() =>
                        void controller.resumeWithdrawal(
                          view.stake.exitNeedsHash ? recoveryHash : undefined
                        )
                      }
                    >
                      Complete withdrawal <Icon name="arrow" />
                    </button>
                  </>
                ) : (
                  <>
                    {amount < MAX_STAKE && (
                      <div
                        className="notch-stake-options"
                        aria-label="Add stake"
                      >
                        {[1n, 2n, 4n]
                          .map((units) => units * STAKE_UNIT)
                          .filter((value) => amount + value <= MAX_STAKE)
                          .map((value) => (
                            <button
                              type="button"
                              key={value}
                              disabled={view.busy}
                              onClick={() =>
                                void controller.deposit(value.toString())
                              }
                            >
                              +{(Number(value) / 1e18).toString()} ETH
                            </button>
                          ))}
                      </div>
                    )}
                    {funded && (
                      <>
                        <p className="notch-wallet-ready">
                          Ready to post. Close this panel and write below.
                        </p>
                        <button
                          type="button"
                          className="notch-wallet-secondary"
                          disabled={view.busy || withdrawLocked}
                          onClick={() => void controller.withdrawStake()}
                        >
                          {withdrawLocked
                            ? "Withdraw 24h after your last post"
                            : "Withdraw stake"}
                        </button>
                      </>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="notch-wallet-switch"
                  disabled={view.busy}
                  onClick={() => downloadBackup({ controller })}
                >
                  Download backup (optional)
                </button>
                <button
                  type="button"
                  className="notch-wallet-switch"
                  disabled={view.busy}
                  onClick={() => void controller.disconnect()}
                >
                  Switch wallet
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
