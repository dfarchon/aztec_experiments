import { useEffect, useRef, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";

import { Feed } from "./Feed";
import { Hint } from "./Hint";
import { L1Panel } from "./L1Panel";
import type {
  BillboardController,
  BillboardView,
  Progress as ProgressData,
} from "./types";
import { WalletPanel } from "./WalletPanel";

function Progress({ progress }: { progress: ProgressData | null }) {
  return (
    <div
      id="operationProgress"
      className={`operation-progress${progress?.failed ? " failed" : ""}`}
      role="status"
      aria-live="polite"
      hidden={!progress}
    >
      <div className="operation-progress-inner">
        <div className="operation-progress-text">
          <span id="operationLabel">{progress?.label}</span>
          <span id="operationCount">{progress?.count}</span>
        </div>
        <progress
          id="operationBar"
          max={progress?.total || 1}
          value={progress?.value}
          aria-label="当前操作进度"
        />
      </div>
    </div>
  );
}

function DebugPanel({ view }: { view: BillboardView }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [view.logs]);
  return (
    <details className="card debug-card">
      <summary>本地链与运行记录</summary>
      <div className="debug-inner">
        <dl className="debug-grid">
          {[
            ["RPC", "rpcAddress", "nodeUrl"],
            ["Billboard", "boardAddress", "board"],
            ["Sponsored FPC", "sponsorAddress", "sponsoredFpc"],
          ].map(([label, id, key]) => (
            <div className="debug-pair" key={key}>
              <dt>{label}</dt>
              <dd id={id}>
                {String(
                  view.deployment?.[
                    key as keyof NonNullable<BillboardView["deployment"]>
                  ] || "加载中…"
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div
          id="log"
          ref={logRef}
          className="status-container"
          aria-live="polite"
        >
          {view.logs.map((entry) => (
            <div key={entry.id} className={`status ${entry.type}`}>
              {entry.type === "working" && <span className="spinner" />}[
              {entry.time}] {entry.message}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function downloadBackup(controller: BillboardController) {
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

export function App({ controller }: { controller: BillboardController }) {
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const bytes = new TextEncoder().encode(view.message).length;
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◈
            </span>
            <span>
              DFArchon <span className="brand-sub">/ Billboard</span>
            </span>
          </div>
          <div className="header-spacer" />
          <Link className="report-link" to="/reports">
            设计与测试 →
          </Link>
          <span id="network" className="network-pill">
            {view.deployment ? "Aztec Localnet · 31337" : "加载本地部署信息"}
          </span>
          <WalletPanel view={view} controller={controller} />
        </div>
      </header>
      <Progress progress={view.progress} />
      <main className="shell">
        <section className="hero">
          <h1>
            留言板{" "}
            <Hint label="留言板说明">
              任何 Aztec 账号都可匿名发帖，无需入局或存款。每个账号在滚动 24
              小时内最多发 10 条，L2 gas 由 Sponsored FPC 代付。
            </Hint>
          </h1>
          <span className="eyebrow">LOCALNET / AZTEC</span>
        </section>
        {view.actionError && (
          <section className="action-error" role="alert">
            <span>⚠ {view.actionError.label}失败</span>
            <details>
              <summary>查看原因</summary>
              <p>{view.actionError.guidance}</p>
              <pre>{view.actionError.message}</pre>
            </details>
          </section>
        )}
        <section
          id="accountBar"
          className="account-strip"
          aria-label="已连接钱包"
          hidden={!view.connected}
        >
          <span className="account-strip-label">已连接地址</span>
          <span id="accountAddress" className="account-strip-address">
            {view.address}
          </span>
          <button
            id="copyAddress"
            type="button"
            disabled={view.busy || !view.address}
            onClick={controller.copyAddress}
          >
            {view.copied ? "已复制" : "复制地址"}
          </button>
          <button
            id="backupAccount"
            type="button"
            hidden={!view.hasLocalAccount}
            disabled={view.busy}
            onClick={() => downloadBackup(controller)}
          >
            下载账号备份
          </button>
        </section>
        <div className="dashboard">
          <section className="card">
            <h2>
              匿名发帖{" "}
              <Hint label="发帖说明">
                公开文本上链；作者地址不会随消息展示。最多 512 UTF-8 字节，滚动
                24 小时内最多 10 条。
              </Hint>
            </h2>
            <label htmlFor="message" className="small">
              消息内容
            </label>
            <textarea
              id="message"
              placeholder="写下你想留在黑暗森林中的话…"
              value={view.message}
              disabled={view.busy}
              onChange={(event) =>
                controller.setField("message", event.target.value)
              }
            />
            <div className="compose-footer">
              <span id="bytes">{bytes} / 512 字节</span>
              <button
                id="post"
                type="button"
                disabled={view.busy || !view.canPost || !bytes || bytes > 512}
                onClick={controller.post}
              >
                发布消息
              </button>
            </div>
            <label className="l1-choice" htmlFor="publishToL1">
              <input
                id="publishToL1"
                type="checkbox"
                checked={view.publishToL1 || false}
                disabled={view.busy || !view.l1?.available}
                onChange={(event) =>
                  controller.setField("publishToL1", event.target.checked)
                }
              />
              同时发布到 L1
              <Hint label="跨链费用">
                先发到 L2，再等待证明。L1 提交由 MetaMask 支付
                gas；付款地址公开。
              </Hint>
            </label>
          </section>
        </div>
        <L1Panel view={view} controller={controller} />
        <Feed view={view} controller={controller} />
        <DebugPanel view={view} />
      </main>
    </>
  );
}
