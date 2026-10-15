import assert from "node:assert/strict";
import test from "node:test";

import { AI_CATEGORY_THRESHOLDS, safetyResult } from "./ai-config.ts";
import { keywordMatches, parseKeywords } from "./keywords.ts";

test("keyword list is literal, deduplicated, case/width insensitive and bounded", () => {
  assert.deepEqual(parseKeywords(" 代练\nVPN\nｖｐｎ\r\n\n"), ["代练", "VPN"]);
  assert.deepEqual(parseKeywords(""), []);
  assert.throws(() => parseKeywords("x".repeat(81)), /80/);
  assert.throws(
    () =>
      parseKeywords(
        Array.from({ length: 201 }, (_, i) => String(i)).join("\n")
      ),
    /200/
  );
  assert.deepEqual(keywordMatches("请不要买代练！ＶＰＮ", ["代练", "vpn"]), [
    "代练",
    "vpn",
  ]);
  assert.deepEqual(keywordMatches("anything", [".*", "(a+)+$"]), []);
  assert.deepEqual(keywordMatches("offer (a+)+$", ["(a+)+$"]), ["(a+)+$"]);
  assert.deepEqual(keywordMatches(undefined, ["abc"]), []);
});

test("whole word mode prevents substring collisions, retains Chinese containment", () => {
  assert.deepEqual(keywordMatches("trade badger", ["ad"], "contains"), ["ad"]);
  assert.deepEqual(keywordMatches("trade badger", ["ad"], "word"), []);
  assert.deepEqual(keywordMatches("An AD!", ["ad"], "word"), ["ad"]);
  assert.deepEqual(keywordMatches("éad ad界", ["ad"], "word"), []);
  assert.deepEqual(keywordMatches("请不要相信代练广告", ["代练"], "word"), [
    "代练",
  ]);
  assert.deepEqual(keywordMatches("代\u200b练", ["代练"]), []);
  assert.deepEqual(keywordMatches("buycheap", ["buy cheap"]), []);
});

test("AI uses independent sigmoid scores and default thresholds, never malformed safety results", () => {
  const rows = Object.keys(AI_CATEGORY_THRESHOLDS).map((label) => ({
    label,
    score: 0.1,
  }));
  assert.deepEqual(
    safetyResult([...rows, { label: "unsafe", score: 0.1 }]).labels,
    []
  );
  assert.deepEqual(
    safetyResult([
      ...rows,
      { label: "unsafe", score: 0.9 },
      { label: "harassment", score: 0.3 },
    ]).labels,
    ["harassment", "other"]
  );
  assert.throws(
    () => safetyResult([{ label: "unsafe", score: 0.5 }]),
    /不完整/
  );
  assert.throws(
    () => safetyResult([...rows, { label: "unsafe", score: NaN }]),
    /不完整/
  );
});
