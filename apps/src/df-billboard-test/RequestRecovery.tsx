import { useState } from "react";

import type { ViewProps } from "./types";

export function RequestRecovery({ view, controller }: ViewProps) {
  const [hash, setHash] = useState("");
  const pending = view.request.jobs.find((job) => job.postId === undefined);
  if (view.walletMode !== "metamask" || !pending) return null;
  const unknownL2 = pending.l2Attempted && !pending.l2Tx;
  const needsHash = unknownL2 || !pending.l1Tx;
  return (
    <div className="request-recovery">
      <span className="small">
        {needsHash
          ? `${unknownL2 ? "L2" : "L1"} submission unknown. Enter the transaction hash; do not pay again.`
          : "Pending post · Resume without another L1 payment."}
      </span>
      {needsHash && (
        <input
          aria-label={`${unknownL2 ? "L2" : "L1"} transaction hash`}
          value={hash}
          onChange={(event) => setHash(event.target.value)}
          disabled={view.busy}
          placeholder="0x…"
        />
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
        {needsHash ? "Recover post" : "Resume post"}
      </button>
    </div>
  );
}
