import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";

import { createReadingReport, reportEffect } from "./report-data.ts";

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

test("all switch combinations fold on any active rule and count each post once", () => {
  const report = createReadingReport(fixture());
  for (const keyword of [false, true])
    for (const rules of [false, true])
      for (const ai of [false, true]) {
        const options = { keyword, rules, ai };
        const result = reportEffect(report.rows[2], options);
        assert.equal(result.folded, keyword || rules);
        assert.equal(reportEffect(report.rows[3], options).folded, ai);
        assert.equal(reportEffect(report.rows[3], options).aiFolded, ai);
      }
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

const compiled = await build({
  stdin: {
    contents: "export { ReportContent } from './ReportPage.tsx';",
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  loader: { ".css": "empty" },
  external: ["react", "react/jsx-runtime", "react-router-dom"],
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports
);
test("report covers standalone sponsored posting, test results and escaped samples without wallet controls", () => {
  const html = renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: "/reports" },
      createElement(module.exports.ReportContent, {
        report: createReadingReport(fixture()),
      })
    )
  );
  for (const id of [
    "overview",
    "flow",
    "contract",
    "reading",
    "results",
    "samples",
    "limits",
    "evidence",
  ])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|id="walletMenu"|id="connect"/);
  assert.match(html, /6 条人工编写中英文样本/);
  assert.doesNotMatch(html, /basic-reading-v2/);
  assert.doesNotMatch(html, /Core\.initialize_player|PlayerStorage/);
  assert.match(html, /无需 DF 入局、无需存款/);
  assert.match(html, /post\(text, length\)/);
  assert.match(html, /滚动 86,400 秒内最多 10 条/);
  assert.match(html, /Sponsored FPC/);
  assert.match(html, /get_post_count/);
  assert.match(html, /客户端要求 1–512 字节有效 UTF-8/);
  assert.match(html, /中文广告 · 基础规则折叠/);
  assert.match(html, /英文广告 · 基础规则折叠/);
  assert.match(html, /正常聊天＋边界 · 误折叠/);
  assert.match(html, /2\/2<\/strong><span>全部广告/);
  assert.match(html, /1\/1<\/strong><span>英文广告/);
  assert.match(html, /0\/3<\/strong><span>正常聊天＋边界/);
  assert.match(html, /df-test-report.json/);
  assert.match(html, /本页读取历史 AI 结果，不会重新推理/);
});

test("contract design remains readable when the sample report is unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: "/reports" },
      createElement(module.exports.ReportContent, { error: "样本不可用" })
    )
  );
  assert.match(html, /合约设计/);
  assert.match(html, /Sponsored FPC/);
  assert.match(html, /样本不可用/);
  assert.doesNotMatch(html, /全部广告 · 基础规则折叠/);
});
