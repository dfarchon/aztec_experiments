import { Hint } from "./Hint";
import { emptyL1View, type L1Stage } from "./l1";
import type { ViewProps } from "./types";

const labels: Record<L1Stage, string> = {
  "waiting-proof": "Waiting for proof",
  ready: "Ready for L1",
  signing: "Awaiting MetaMask approval",
  confirming: "Confirming on L1",
  published: "Published on L1",
};
export function L1Panel({ view, controller }: ViewProps) {
  const l1 = view.l1 || emptyL1View;
  if (!l1.available && !l1.error) return null;
  return (
    <section className="card l1-panel" id="l1Panel">
      <h2>
        Ethereum copy{" "}
        <Hint label="About L1 publishing">
          L2 posting remains anonymous with FPC-sponsored fees. MetaMask pays L1
          gas and the submitting address is public. Do not repost while waiting
          for a proof. Local tools are for Anvil testing only.
        </Hint>
      </h2>
      <div className="l1-toolbar">
        <button
          id="connectL1"
          disabled={l1.busy || !l1.available}
          onClick={controller.connectL1}
        >
          {l1.address ? "Reconnect MetaMask" : "Connect MetaMask"}
        </button>
        <button
          id="refreshL1"
          disabled={l1.busy || !l1.available}
          onClick={controller.refreshL1}
        >
          Check status
        </button>
      </div>
      <details className="local-tools">
        <summary>Local development tools</summary>
        <div className="l1-toolbar">
          <button
            id="fundL1"
            disabled={l1.busy || !l1.address}
            onClick={controller.fundL1}
          >
            Get local test ETH
          </button>
          <button
            id="proveL1"
            disabled={
              l1.busy || !l1.jobs.some((job) => job.stage === "waiting-proof")
            }
            onClick={controller.proveL1}
          >
            Generate local proof
          </button>
        </div>
      </details>
      {l1.address && (
        <p className="small l1-address">
          L1 payer: <span id="l1Payer">{l1.address}</span> · Anvil 31337
        </p>
      )}
      {l1.error && (
        <p className="l1-error" role="alert">
          {l1.error}
        </p>
      )}
      {!l1.jobs.length && (
        <div className="empty-state">
          <h2>No cross-chain posts yet</h2>
          <p>
            Enable an Ethereum copy under Publishing options, then return here
            to submit it.
          </p>
        </div>
      )}
      <div className="l1-jobs">
        {l1.jobs.map((job) => (
          <article
            className="l1-job"
            key={job.l2Tx}
            data-l2-tx={job.l2Tx}
            data-stage={job.stage}
          >
            <div className="l1-job-header">
              <span>
                Post {job.postId === undefined ? "pending" : `#${job.postId}`}
              </span>
              <strong role="status">{labels[job.stage]}</strong>
            </div>
            <p className="l1-body">{job.text}</p>
            <div className="small l1-hash">L2: {job.l2Tx}</div>
            {job.l1Tx && <div className="small l1-hash">L1: {job.l1Tx}</div>}
            {job.gas && job.stage === "ready" && (
              <p className="small">
                Estimated {job.gas} gas · Fee cap approx. {job.fee} local ETH
              </p>
            )}
            {job.error && (
              <details className="l1-error">
                <summary>View details</summary>
                <p>{job.error}</p>
              </details>
            )}
            {job.stage === "ready" && (
              <button
                className="publish-l1"
                disabled={l1.busy || !l1.address}
                onClick={() => controller.publishL1(job.l2Tx)}
              >
                Publish to L1 with MetaMask
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
