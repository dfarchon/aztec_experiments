import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Hint } from "./Hint";
import type { KeywordMode, ViewProps } from "./types";

function Toggle({
  id,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
  children: ReactNode;
}) {
  return (
    <label className="reading-toggle" htmlFor={id}>
      <span>{children}</span>
      <input
        id={id}
        role="switch"
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true" />
    </label>
  );
}

export function ReadingSettings({ view, controller }: ViewProps) {
  const [draft, setDraft] = useState((view.keywords || []).join("\n"));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft((view.keywords || []).join("\n"));
  }, [view.keywords]);
  return (
    <div className="reading-settings" aria-label="本地阅读设置">
      <section className="reading-option">
        <div className="reading-title">
          <Toggle
            id="keywordEnabled"
            checked={view.keywordEnabled}
            onChange={(value) => controller.setField("keywordEnabled", value)}
          >
            关键词屏蔽
          </Toggle>
          <Hint label="关键词屏蔽说明">
            只按你的词表折叠，不判断违规；关闭不删除词表。忽略英文大小写和全半角差异；按字面匹配，不支持正则或谐音。含关键词的劝阻、引用也会折叠。
          </Hint>
        </div>
        <label htmlFor="keywordList">每行一个词或短语 · 最多 200 个</label>
        <textarea
          id="keywordList"
          rows={3}
          maxLength={20000}
          value={draft}
          placeholder={"代练\n某个不想看的话题"}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <label htmlFor="keywordMode">匹配方式</label>
        <select
          id="keywordMode"
          value={view.keywordMode || "contains"}
          onChange={(event) =>
            controller.setField(
              "keywordMode",
              event.target.value as KeywordMode
            )
          }
        >
          <option value="contains">包含关键词</option>
          <option value="word">英文完整单词 · 中文仍按包含</option>
        </select>
        <div className="reading-actions">
          <button
            id="saveKeywords"
            onClick={() => setSaved(controller.saveKeywords(draft))}
          >
            保存词表
          </button>
          <span role="status">
            {saved ? "已保存" : `已保存 ${(view.keywords || []).length} 个词`}
          </span>
        </div>
        {view.keywordError && (
          <p role="alert" className="reading-error">
            {view.keywordError}
          </p>
        )}
      </section>
      <section className="reading-option">
        <div className="reading-title">
          <Toggle
            id="rulesEnabled"
            checked={view.rulesEnabled}
            onChange={(value) => controller.setField("rulesEnabled", value)}
          >
            基础规则过滤
          </Toggle>
          <Hint label="基础规则说明">
            折叠明确促销／服务招揽与外部联系入口、游戏资产站外商店引流、索取钱包凭证、代币领取链接、成人内容招揽及重复外部招揽。游戏内银币交易、社区活动和讨论提醒尽量保留。只改变本地展示；可能误判或漏判，原文可展开。
          </Hint>
        </div>
      </section>
      <section className="reading-option">
        <div className="reading-title">
          <Toggle
            id="aiHints"
            checked={view.aiHints}
            disabled={view.aiClearing || (view.busy && !view.aiHints)}
            onChange={(value) => controller.setAiHints(value)}
          >
            折叠 AI 判为风险的内容
          </Toggle>
          <Hint label="AI 折叠说明">
            Content Safety Guard Small ·
            中英文。本地运行，默认关闭；模型命中风险后折叠，未完成分析或模型不可用时保持可见。权重约
            268 MB，分词器约 34
            MB，另需运行库。帖子不上传审核服务，可能误判或漏判。
          </Hint>
        </div>
        {view.aiConsentOpen && (
          <div className="ai-consent" role="group" aria-label="首次启用本地 AI">
            <p>
              将下载约 268 MB 权重、34 MB
              分词器及运行库；有消息时开始分析，可能占用较多内存。模型判为风险的消息会折叠，可能误判或漏判；原文可展开。帖子不上传审核服务，开启后会记住此设备的选择。
            </p>
            <div className="reading-actions">
              <button id="confirmAi" onClick={controller.confirmAiHints}>
                确认下载并启用
              </button>
              <button
                id="cancelAi"
                onClick={() => controller.setAiHints(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}
        <div id="aiStatus" role="status" aria-live="polite">
          {view.aiStatus}
        </div>
        {view.aiProgress && (
          <progress
            aria-label="当前模型文件加载进度"
            max={100}
            value={view.aiProgress.percent}
          />
        )}
        <div className="reading-actions">
          {view.aiHints && (
            <button
              id="retryAi"
              disabled={view.busy || view.aiProgress != null}
              onClick={() => controller.setAiHints(true)}
            >
              重试分析
            </button>
          )}
          <button
            id="clearAiCache"
            disabled={view.aiClearing || view.busy}
            onClick={controller.clearAiCache}
          >
            {view.aiClearing ? "正在清除…" : "关闭并清除模型缓存"}
          </button>
        </div>
      </section>
    </div>
  );
}
