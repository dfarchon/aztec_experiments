import assert from "node:assert/strict";
import test from "node:test";

import { AI_CATEGORY_THRESHOLDS, safetyResult } from "./ai-config.ts";
import { keywordMatches, parseKeywords } from "./keywords.ts";

test("keyword list is literal, deduplicated, case/width insensitive and bounded", () => {
  assert.deepEqual(parseKeywords(" \u4ee3\u7ec3\nVPN\nｖｐｎ\r\n\n"), [
    "\u4ee3\u7ec3",
    "VPN",
  ]);
  assert.deepEqual(parseKeywords(""), []);
  assert.throws(() => parseKeywords("x".repeat(81)), /80/);
  assert.throws(
    () =>
      parseKeywords(
        Array.from({ length: 201 }, (_, i) => String(i)).join("\n")
      ),
    /200/
  );
  assert.deepEqual(
    keywordMatches("\u8bf7\u4e0d\u8981\u4e70\u4ee3\u7ec3\uff01ＶＰＮ", [
      "\u4ee3\u7ec3",
      "vpn",
    ]),
    ["\u4ee3\u7ec3", "vpn"]
  );
  assert.deepEqual(keywordMatches("anything", [".*", "(a+)+$"]), []);
  assert.deepEqual(keywordMatches("offer (a+)+$", ["(a+)+$"]), ["(a+)+$"]);
  assert.deepEqual(keywordMatches(undefined, ["abc"]), []);
});

test("whole word mode prevents substring collisions, retains Chinese containment", () => {
  assert.deepEqual(keywordMatches("trade badger", ["ad"], "contains"), ["ad"]);
  assert.deepEqual(keywordMatches("trade badger", ["ad"], "word"), []);
  assert.deepEqual(keywordMatches("An AD!", ["ad"], "word"), ["ad"]);
  assert.deepEqual(keywordMatches("éad ad\u754c", ["ad"], "word"), []);
  assert.deepEqual(
    keywordMatches(
      "\u8bf7\u4e0d\u8981\u76f8\u4fe1\u4ee3\u7ec3\u5e7f\u544a",
      ["\u4ee3\u7ec3"],
      "word"
    ),
    ["\u4ee3\u7ec3"]
  );
  assert.deepEqual(keywordMatches("\u4ee3\u200b\u7ec3", ["\u4ee3\u7ec3"]), []);
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
    /Incomplete/
  );
  assert.throws(
    () => safetyResult([...rows, { label: "unsafe", score: NaN }]),
    /Incomplete/
  );
});
