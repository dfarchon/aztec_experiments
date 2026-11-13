import { useState } from "react";

import type { ViewProps } from "./types";

export function RequestRecovery({ view, controller }: ViewProps) {
  const [hash, setHash] = useState("");
  const pending = view.request.pending;
  if (view.walletMode !== "metamask" || !pending || view.posting) return null;
  const unknownL2 = pending.l2Attempted && !pending.l2Tx;
  const needsHash = unknownL2 || !pending.l1Tx;
  return (
    <div className="request-recovery">
      <strong>Continue post</strong>
      <p className="small">{pending.text}</p>
      {needsHash && (
        <>
          <label htmlFor="recoveryHash">
            Existing {unknownL2 ? "L2" : "L1"} transaction hash
          </label>
          <input
            id="recoveryHash"
            aria-label={`${unknownL2 ? "L2" : "L1"} transaction hash`}
            value={hash}
            onChange={(event) => setHash(event.target.value)}
            disabled={view.busy}
            placeholder="0x…"
          />
        </>
      )}
      <button
        disabled={
          view.busy ||
          !view.connected ||
          (needsHash && !/^0x[0-9a-fA-F]{64}$/.test(hash))
        }
        onClick={() =>
          void controller.resumeRequest(needsHash ? hash : undefined)
        }
      >
        {needsHash
          ? "Check existing transaction"
          : "Continue without paying again"}
      </button>
    </div>
  );
}
