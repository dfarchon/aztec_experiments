import assert from "node:assert/strict";
import test from "node:test";

import { createReadingReport } from "./report-data.ts";

function fixture() {
  const original = {
    normal_zh: ["我们反对代练。", "<img src=x onerror=alert(1)>"],
    advertising_zh: ["专业代练接单，加微信 demo 咨询价格。"],
    toxic_zh: ["风险测试文本"],
    policy_zh: ["联盟招募"],
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
  assert.throws(() => createReadingReport(input), /未完成/);
  input.browser.done = true;
  input.browser.rows[0].text = "changed";
  assert.throws(() => createReadingReport(input), /不一致/);
  const duplicate = fixture();
  duplicate.browser.rows[1] = duplicate.browser.rows[0];
  assert.throws(() => createReadingReport(duplicate), /不一致/);
});
