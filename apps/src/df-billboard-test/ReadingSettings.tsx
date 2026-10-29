import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { Hint } from "./Hint";
import { Select } from "./Select";
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
    <div className="reading-settings" aria-label="Local reading settings">
      <section className="reading-option">
        <div className="reading-title">
          <Toggle
            id="keywordEnabled"
            checked={view.keywordEnabled}
            onChange={(value) => controller.setField("keywordEnabled", value)}
          >
            Keyword filtering
          </Toggle>
          <Hint label="About keyword filtering">
            Filters posts that match your word list, including quotes and
            warnings. Matching ignores case and character-width differences; it
            is literal, not regex or phonetic. Turning this off keeps your word
            list.
          </Hint>
        </div>
        <label htmlFor="keywordList">
          One word or phrase per line · Up to 200
        </label>
        <textarea
          id="keywordList"
          rows={3}
          maxLength={20000}
          value={draft}
          placeholder={"giveaway\na topic you want to mute"}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <label htmlFor="keywordMode">Match mode</label>
        <Select
          id="keywordMode"
          value={view.keywordMode || "contains"}
          onChange={(value) =>
            controller.setField("keywordMode", value as KeywordMode)
          }
          options={[
            { value: "contains", label: "Contains keyword" },
            {
              value: "word",
              label: "Whole English words · Substring match for Chinese",
            },
          ]}
        />
        <div className="reading-actions">
          <button
            id="saveKeywords"
            onClick={() => setSaved(controller.saveKeywords(draft))}
          >
            Save keywords
          </button>
          <span role="status">
            {saved ? "Saved" : `${(view.keywords || []).length} keywords saved`}
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
            Basic rule filtering
          </Toggle>
          <Hint label="About basic rules">
            Filters clear promotions with external contact details, offsite
            game-asset shops, requests for wallet credentials, token-claim
            links, adult solicitation and repeated external solicitation. Rules
            aim to preserve in-game trading, community activities and
            discussion. Only your view changes. Mistakes are possible; originals
            remain available.
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
            AI content filtering
          </Toggle>
          <Hint label="About AI filtering">
            Content Safety Guard Small · English and Chinese. Runs locally and
            is off by default. Flagged posts move to Filtered; unreviewed posts
            remain visible. Requires about 268 MB of weights, a 34 MB tokenizer
            and runtime files. Posts are not sent to a moderation service.
            Results can be wrong.
          </Hint>
        </div>
        {view.aiConsentOpen && (
          <div className="ai-consent" role="group" aria-label="Enable local AI">
            <p>
              Downloads about 268 MB of weights, a 34 MB tokenizer and runtime
              files. Analysis may use significant memory. Flagged posts are
              hidden from the main list, not deleted; results can be wrong.
              Analysis runs on this device without uploading posts to a
              moderation service. Your choice is remembered in this browser.
            </p>
            <div className="reading-actions">
              <button id="confirmAi" onClick={controller.confirmAiHints}>
                Download & enable
              </button>
              <button
                id="cancelAi"
                onClick={() => controller.setAiHints(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div id="aiStatus" role="status" aria-live="polite">
          {view.aiStatus}
        </div>
        {view.aiProgress && (
          <progress
            aria-label="Current model file download progress"
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
              Retry analysis
            </button>
          )}
          <button
            id="clearAiCache"
            disabled={view.aiClearing || view.busy}
            onClick={controller.clearAiCache}
          >
            {view.aiClearing ? "Clearing…" : "Disable & clear model cache"}
          </button>
        </div>
      </section>
    </div>
  );
}
