import type { ReactNode } from "react";

import type { BillboardView, ViewProps } from "../../app/types.ts";
import { Icon } from "../../ui/Icon.tsx";
import { LoadingIcon } from "../../ui/LoadingIcon.tsx";

interface ComposerAction {
  disabled: boolean;
  label: ReactNode;
  loading: boolean;
  pendingStake: boolean;
  ariaLabel?: string;
}

function composerAction(view: BillboardView): ComposerAction {
  const pendingStake = view.stake.pendingDeposit || view.stake.pendingExit;
  const bytes = new TextEncoder().encode(view.message).length;
  if (view.restoring)
    return {
      disabled: view.busy,
      label: "Restoring account…",
      loading: false,
      pendingStake,
    };
  if (view.posting)
    return {
      disabled: true,
      label: (
        <span className="post-status">
          <span>Posting…</span>
          <small>May take 1–2 min</small>
        </span>
      ),
      loading: true,
      pendingStake,
    };
  if (pendingStake)
    return {
      ariaLabel: "Complete the pending wallet action",
      disabled: view.busy,
      label: view.stake.depositL1Confirmed
        ? view.stake.aztecReady
          ? "Continue Aztec claim"
          : "Initialize Aztec"
        : "Check L1 stake",
      loading: false,
      pendingStake,
    };
  if (view.connected && !view.canPost)
    return {
      disabled: view.busy,
      label:
        BigInt(view.stake.amount) > 0n ? "Initialize Aztec" : "Stake to post",
      loading: false,
      pendingStake,
    };
  if (view.connected)
    return {
      disabled: view.busy || (view.canPost && (!bytes || bytes > 512)),
      label: "Post",
      loading: false,
      pendingStake,
    };
  return {
    disabled: view.busy,
    ariaLabel: !view.busy ? "Connect to post" : undefined,
    label: (
      <>
        <span className="post-connect-label">Connect to post</span>
        <span className="post-connect-label-mobile" aria-hidden="true">
          Connect
        </span>
      </>
    ),
    loading: false,
    pendingStake,
  };
}

export function Composer({ view, controller }: ViewProps) {
  const bytes = new TextEncoder().encode(view.message).length;
  const action = composerAction(view);
  return (
    <section className="card compose-card" aria-label="Write a post">
      <label htmlFor="message" className="sr-only">
        Message
      </label>
      <textarea
        id="message"
        rows={2}
        placeholder="Leave a message…"
        value={view.message}
        disabled={view.busy || action.pendingStake}
        onChange={(event) => controller.setField("message", event.target.value)}
      />
      <div className="compose-footer">
        <span
          id="bytes"
          className={bytes > 512 ? "over-limit" : ""}
          role="status"
        >
          {bytes} / 512 bytes
        </span>
        <button
          id="post"
          type="button"
          aria-busy={view.posting}
          aria-label={action.ariaLabel}
          disabled={action.disabled}
          onClick={() =>
            action.pendingStake || !view.connected || !view.canPost
              ? controller.setWalletPanel(true)
              : void controller.post()
          }
        >
          {action.label}{" "}
          {action.loading ? <LoadingIcon /> : <Icon name="arrow" />}
        </button>
      </div>
    </section>
  );
}
