import assert from "node:assert/strict";
import test from "node:test";

import { createReadingReport } from "./report-data.ts";

function fixture() {
  const original = {
    normal_zh: [
      "\u6211\u4eec\u53cd\u5bf9\u4ee3\u7ec3\u3002",
      "<img src=x onerror=alert(1)>",
    ],
    advertising_zh: [
      "\u4e13\u4e1a\u4ee3\u7ec3\u63a5\u5355\uff0c\u52a0\u5fae\u4fe1 demo \u54a8\u8be2\u4ef7\u683c\u3002",
    ],
    toxic_zh: ["\u98ce\u9669\u6d4b\u8bd5\u6587\u672c"],
    policy_zh: ["\u8054\u76df\u62db\u52df"],
    advertising_en: ["Ships for sale, visit https://example.invalid/store"],
    duplicatePairs: [],
  };
  const rows = Object.entries(original)
    .filter(([key]) => key !== "duplicatePairs")
    .flatMap(([group, texts]) =>
      texts.map((text, i) => ({
        id: `${group}-${i + 1}`,
        text,
        group,
        language: group.endsWith("_en") ? "en" : "zh",
        dataset: "original96",
        flagged: group === "toxic_zh",
        labels: group === "toxic_zh" ? ["harassment"] : [],
      }))
    );
  return {
    original,
    holdout: { samples: [], duplicatePairs: [] },
    browser: {
      done: true,
      rows,
      startedAt: "2026-10-14T04:03:01Z",
      elapsedMs: 8981,
    },
    metadata: {
      repo: "test-model",
      revision: "fixed",
      decision: "unsafe >= 0.5",
    },
  };
}

test("report derives category counts and separates promotion from discussion labels", () => {
  const report = createReadingReport(fixture());
  assert.equal(report.rows.length, 6);
  assert.deepEqual(
    report.summary.find((row) => row.category === "normal"),
    {
      category: "normal",
      total: 2,
      keyword: 1,
      promotion: 0,
      adFold: 0,
      ruleFold: 0,
      aiRisk: 0,
    }
  );
  assert.equal(report.rows[0].adTier, "context");
  assert.equal(
    report.summary.find((row) => row.category === "advertising").ruleFold,
    2
  );
});

test("incomplete, duplicated or changed evidence fails closed instead of reporting zero errors", () => {
  const input = fixture();
  input.browser.done = false;
  assert.throws(() => createReadingReport(input), /incomplete/);
  input.browser.done = true;
  input.browser.rows[0].text = "changed";
  assert.throws(() => createReadingReport(input), /do not match/);
  const duplicate = fixture();
  duplicate.browser.rows[1] = duplicate.browser.rows[0];
  assert.throws(() => createReadingReport(duplicate), /do not match/);
});
