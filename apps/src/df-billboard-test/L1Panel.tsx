import { Hint } from "./Hint";
import { emptyL1View, type L1Stage } from "./l1";
import type { ViewProps } from "./types";

const labels: Record<L1Stage, string> = {
  "waiting-proof": "等待证明",
  ready: "可发布到 L1",
  signing: "等待 MetaMask 确认",
  confirming: "L1 确认中",
  published: "L1 发布成功",
};
export function L1Panel({ view, controller }: ViewProps) {
  const l1 = view.l1 || emptyL1View;
  if (!l1.available && !l1.error) return null;
  return (
    <section className="card l1-panel" id="l1Panel">
      <h2>
        Ethereum L1{" "}
        <Hint label="L1 发布说明">
          L2 发帖仍匿名且由 FPC 代付；L1 gas 由 MetaMask
          支付，提交地址公开。等待证明期间不必重新发帖。本地按钮只用于 Anvil
          测试。
        </Hint>
      </h2>
      <div className="l1-toolbar">
        <button
          id="connectL1"
          disabled={l1.busy || !l1.available}
          onClick={controller.connectL1}
        >
          {l1.address ? "重新连接 MetaMask" : "连接 MetaMask"}
        </button>
        <button
          id="fundL1"
          disabled={l1.busy || !l1.address}
          onClick={controller.fundL1}
        >
          领取本地 ETH
        </button>
        <button
          id="proveL1"
          disabled={
            l1.busy || !l1.jobs.some((job) => job.stage === "waiting-proof")
          }
          onClick={controller.proveL1}
        >
          生成本地证明
        </button>
        <button
          id="refreshL1"
          disabled={l1.busy || !l1.available}
          onClick={controller.refreshL1}
        >
          检查状态
        </button>
      </div>
      {l1.address && (
        <p className="small l1-address">
          L1 付款地址：<span id="l1Payer">{l1.address}</span> · Anvil 31337
        </p>
      )}
      {l1.error && (
        <p className="l1-error" role="alert">
          {l1.error}
        </p>
      )}
      {!l1.jobs.length && (
        <p className="small">发帖时选择“同时发布到 L1”，可在这里继续提交。</p>
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
                帖子 {job.postId === undefined ? "待识别" : `#${job.postId}`}
              </span>
              <strong role="status">{labels[job.stage]}</strong>
            </div>
            <p className="l1-body">{job.text}</p>
            <div className="small l1-hash">L2：{job.l2Tx}</div>
            {job.l1Tx && <div className="small l1-hash">L1：{job.l1Tx}</div>}
            {job.gas && job.stage === "ready" && (
              <p className="small">
                预估 {job.gas} gas · 费用上限约 {job.fee} 本地 ETH
              </p>
            )}
            {job.error && (
              <details className="l1-error">
                <summary>查看原因</summary>
                <p>{job.error}</p>
              </details>
            )}
            {job.stage === "ready" && (
              <button
                className="publish-l1"
                disabled={l1.busy || !l1.address}
                onClick={() => controller.publishL1(job.l2Tx)}
              >
                用 MetaMask 发布到 L1
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
