import assert from "node:assert/strict";
import test from "node:test";

import {
  canFoldBasicRules,
  canFoldPromotion,
  classifyRulePosts,
  hasContactSignal,
  isPromotion,
  normalizeMessage,
} from "./moderation.ts";

test("repetition normalization preserves case, unicode forms and word boundaries", () => {
  assert.equal(
    normalizeMessage(" Ｈｅｌｌｏ\u200b  DF "),
    "Ｈｅｌｌｏ\u200b DF"
  );
  assert.equal(normalizeMessage("one\r\ntwo"), "one\ntwo");
  assert.equal(normalizeMessage(" Hello   DF "), "Hello DF");
});

test("repeated links are not labeled as advertisements", () => {
  const posts = [1, 2, 3].map((id) => ({
    id,
    text: "\u52a0\u5165 https://example.com \u770b\u770b",
  }));
  const classified = classifyRulePosts(posts);
  assert.ok(classified.every((post) => post.adReasons.length === 0));
});

test("repeated game chatter and unique links stay visible", () => {
  const posts = [
    ...[1, 2, 3].map((id) => ({
      id,
      text: "\u51c6\u5907\u653b\u51fb\u53f3\u4e0a\u89d2\u7684\u661f\u7403",
    })),
    { id: 4, text: "\u9879\u76ee\u6587\u6863\u5728 https://example.com" },
  ];
  assert.ok(
    classifyRulePosts(posts).every((post) => post.adReasons.length === 0)
  );
});

test("contact signal handles email and Chinese contact hints", () => {
  assert.equal(hasContactSignal("help@example.com"), true);
  assert.equal(hasContactSignal("\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9"), true);
  assert.equal(hasContactSignal("\u6211\u53bb\u5360\u9886\u661f\u7403"), false);
});

test("malformed and empty messages do not break classification", () => {
  const posts = [
    { id: 0, decodeError: true },
    { id: 1, text: "" },
    { id: 2, text: "  " },
  ];
  assert.ok(
    classifyRulePosts(posts).every((post) => post.adReasons.length === 0)
  );
  assert.deepEqual(posts[0], { id: 0, decodeError: true });
});

test("neutral variants stay visible without changing the original text", () => {
  const posts = [
    { id: 0, text: "\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9 DF" },
    { id: 1, text: "\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9 df" },
    { id: 2, text: "\u52a0\u5fae\u200b\u4fe1\u4e00\u8d77\u73a9 ＤＦ" },
  ];
  const classified = classifyRulePosts(posts);
  assert.ok(classified.every((post) => !post.adReasons.length));
  assert.equal(classified[2].text, posts[2].text);
  assert.equal(posts[2].adReasons, undefined);
});

test("promotional wording AND contact are required, including full-width and homophone variants", () => {
  const ads = [
    "\u514d\u8d39\u4ee3\u7ec3\u9650\u65f6\u4f18\u60e0\uff0c\u52a0\u5fae\u4fe1 df_demo\uff1ahttps://example.invalid/promo",
    "\u514d \u8d39 \u4ee3 \u7ec3 \u9650 \u65f6 \u4f18 \u60e0\uff0c\u52a0 \u5fae \u4fe1 ｄｆ＿ｄｅｍｏ\uff1ahttps://example.invalid/promo",
    "\u514d\u8d39\u4ee3\u7ec3\u9650\u65f6\u4f18\u60e0\uff0c\u52a0\u5fae\u200b\u4fe1 df_demo\uff1ahttps://example.invalid/promo",
    "\u4f4e\u4ef7\u4ee3\u7ec3\u4eca\u5929\u7279\u60e0\uff0c\u5fae\u4fe1 df_demo\uff0c\u8be6\u60c5 https://example.invalid/promo",
    "\u5305\u8d62\u4ee3\u7ec3\uff0c\u8587\u4fe1\u641c df_demo\uff0c\u79c1\u804a\u9886\u4f18\u60e0\u3002",
    "Buy cheap boosting now! Contact promo_demo at https://example.invalid/deal",
  ];
  assert.ok(
    classifyRulePosts(ads.map((text, id) => ({ id, text }))).every(
      canFoldPromotion
    )
  );
  const safe = [
    "\u65b0\u4eba\u653b\u7565 https://example.invalid/guide \uff0c\u8fd9\u662f\u6211\u6574\u7406\u7684\u514d\u8d39\u6e38\u620f\u6559\u7a0b\u3002",
    "\u9700\u8981\u51fa\u751f\u70b9\u653b\u7565\u53ef\u4ee5\u770b https://example.invalid/help \uff0c\u4e0d\u662f\u5e7f\u544a\u3002",
    "\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9",
    "\u653b\u7565 https://example.invalid/promo",
    "Contact sale@example.invalid",
    "https://example.invalid/\u4ee3\u7ec3",
  ];
  assert.ok(
    classifyRulePosts(safe.map((text, id) => ({ id, text }))).every(
      (post) => !post.adReasons.length
    )
  );
});

test("additional examples separate game purchasing and neutral contacts from sales pitches", () => {
  const examples = [
    ["Where can I buy a ship? Guide: https://example.invalid/ships", false],
    ["The sale mechanic is explained at https://example.invalid/rules", false],
    [
      "\u4e00\u8d77\u63a2\u7d22\u5730\u56fe\uff0c\u8587\u4fe1 df_friends",
      false,
    ],
    ["Discount coaching, email lessons@example.com", true],
    ["Ships for sale! https://example.invalid/shop", true],
    ["\u4f4e\u4ef7\u4ee3\u7ec3 vx demo", true],
  ];
  for (const [text, expected] of examples) {
    assert.equal(
      isPromotion(classifyRulePosts([{ id: 1, text }])[0]),
      expected,
      text
    );
  }
});
test("similar-looking messages retain their text and stay visible", () => {
  for (const [a, b] of [
    ["Meet now here", "Meet nowhere"],
    ["Please re sign this", "Please resign this"],
    ["https://example.org/MapA", "https://example.org/mapa"],
    ["Send code AbC9", "Send code abc9"],
  ]) {
    const posts = classifyRulePosts([
      { id: 0, text: a },
      { id: 1, text: b },
    ]);
    assert.deepEqual(
      posts.map((post) => post.text),
      [a, b]
    );
    assert.ok(posts.every((post) => !post.adReasons.length));
  }
});

test("context, policy, weak evidence and strong offers have distinct folding eligibility", () => {
  const cases = [
    [
      "\u6211\u4eec\u53cd\u5bf9\u4ee3\u7ec3\uff0c\u5177\u4f53\u89c4\u5219\u770b https://example.org/rules \u3002",
      "context",
    ],
    [
      "Do not buy cheap boosting from https://example.org/scam . It is a scam warning.",
      "context",
    ],
    [
      "Ships for sale for in-game silver only: https://example.org/trade .",
      "policy",
    ],
    [
      "\u6765\u6211\u4eec\u8054\u76df\u5427\uff01QQ\u7fa4 forest_team\uff0c\u4eca\u665a\u4e00\u8d77\u73a9\u3002",
      "policy",
    ],
    ["\u4ee3\u7ec3\u9650\u65f6\u4f18\u60e0", "possible"],
    ["Boosting packages available. Details are in my bio.", "likely"],
    [
      "\u4e0d\u662f\u5e7f\u544a\uff0c\u4f4e\u4ef7\u4ee3\u7ec3\u63a5\u5355\uff0c\u52a0\u5fae\u4fe1 demo",
      "likely",
    ],
    ["Not an ad! Buy cheap boosting at https://example.org/deal", "likely"],
    [
      "Avoid scams, buy our coaching for $20: https://example.org/deal",
      "possible",
    ],
  ];
  for (const [text, tier] of cases) {
    const post = classifyRulePosts([{ id: 1, text }])[0];
    assert.equal(post.adTier, tier, text);
    assert.equal(canFoldPromotion(post), tier === "likely", text);
  }
});

test("explicit offer plus external contact folds even when the product noun is absent", () => {
  const ads = [
    "\u9650\u65f6\u4f18\u60e0\u53ea\u5269\u4eca\u5929\uff0c\u8be6\u60c5 https://example.invalid/shop",
    "\u4f4e\u4ef7\u51fa\u552e\u5347\u7ea7\u670d\u52a1\uff0c\u8054\u7cfb sales@example.invalid",
    "\u5341\u5143\u5305\u6708\u66ff\u4f60\u73a9\uff0c\u79c1\u804a\u6211\uff0c\u5148\u5230\u5148\u5f97",
    "\u4ee3\u7ec3\u53ea\u8981\u5341\u5143\uff0c\u4e3b\u9875\u6709\u8054\u7cfb\u65b9\u5f0f",
    "Limited promotion! Contact us on Telegram: forest_deals",
    "Flash deal on gaming chairs! Email chairs@example.invalid",
    "Hot deals on laptops. Link in bio",
    "Boosting packages available. Details are in my bio",
    "Need someone to play for you? DM for rates",
  ];
  for (const [id, text] of ads.entries()) {
    const post = classifyRulePosts([{ id, text }])[0];
    assert.equal(post.adTier, "likely", text);
    assert.equal(canFoldBasicRules(post), true, text);
  }
  const safe = [
    "\u4eca\u5929\u6709\u9650\u65f6\u6d3b\u52a8\u5417\uff1f\u653b\u7565\u5728 https://example.invalid/guide",
    "The discount mechanic is explained at https://example.invalid/rules",
    "Contact us about the community tournament at https://example.invalid/event",
    "\u9700\u8981\u5347\u7ea7\u653b\u7565\u8bf7\u770b https://example.invalid/guide",
    "\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9 DF",
  ];
  for (const [id, text] of safe.entries()) {
    assert.equal(
      canFoldBasicRules(classifyRulePosts([{ id, text }])[0]),
      false,
      text
    );
  }
});

test("in-game trades stay visible, while explicit off-site storefront offers fold", () => {
  const cases = [
    ["Ships for sale, visit https://example.invalid/store", "likely"],
    [
      "\u51fa\u552e\u8230\u8239\uff0c\u8d2d\u4e70\u5165\u53e3 https://example.invalid/shop",
      "likely",
    ],
    ["Ships for sale at https://example.invalid/trade", "policy"],
    [
      "Ships for sale for in-game silver only: https://example.invalid/store",
      "policy",
    ],
    [
      "\u51fa\u552e\u8230\u8239\uff0c\u53ea\u6536\u6e38\u620f\u5185\u94f6\u5e01\uff0c\u8be6\u60c5 https://example.invalid/shop",
      "policy",
    ],
    [
      "\u6765\u6211\u4eec\u8054\u76df\u5427\uff01QQ\u7fa4 forest_team\uff0c\u4eca\u665a\u4e00\u8d77\u73a9",
      "policy",
    ],
  ];
  for (const [id, [text, tier]] of cases.entries()) {
    const post = classifyRulePosts([{ id, text }])[0];
    assert.equal(post.adTier, tier, text);
    assert.equal(canFoldBasicRules(post), tier === "likely", text);
  }
});

test("basic rules cover clear solicitation without treating a match as an illegality verdict", () => {
  const cases = [
    [
      "\u514d\u8d39\u4ee3\u7ec3\u9650\u65f6\u4f18\u60e0\uff0c\u52a0\u5fae\u4fe1 demo",
      "promotion",
    ],
    [
      "\u8f93\u5165\u4f60\u7684\u52a9\u8bb0\u8bcd\u9886\u53d6\u5956\u52b1",
      "credential-request",
    ],
    [
      "\u8f93 \u5165 \u52a9 \u8bb0 \u8bcd\uff0c\u9886\u53d6\u5956\u52b1",
      "credential-request",
    ],
    ["Submit your private key to verify your wallet", "credential-request"],
    [
      "\u9886\u53d6\u7a7a\u6295\u4ee3\u5e01\uff1ahttps://example.invalid/claim",
      "token-claim-link",
    ],
    [
      "Claim your free token airdrop: https://example.invalid/claim",
      "token-claim-link",
    ],
    [
      "\u6210\u4eba\u966a\u804a\uff0c\u79c1\u804a\u4e86\u89e3",
      "adult-solicitation",
    ],
    ["Paid adult chat, DM for details", "adult-solicitation"],
  ];
  for (const [text, category] of cases) {
    const post = classifyRulePosts([{ id: 1, text }])[0];
    assert.ok(post.ruleMatches.includes(category), text);
    assert.equal(canFoldBasicRules(post), true, text);
  }
});

test("basic rules preserve warnings, neutral discussion, gameplay and incomplete signals", () => {
  const safe = [
    "\u4e0d\u8981\u8f93\u5165\u52a9\u8bb0\u8bcd\uff0c\u4efb\u4f55\u7d22\u53d6\u79c1\u94a5\u7684\u94fe\u63a5\u90fd\u662f\u9a97\u5c40\u3002",
    "Never share your seed phrase; report the scam.",
    "\u6211\u4eec\u8ba8\u8bba\u4e00\u4e0b\u7a7a\u6295\u4ee3\u5e01\u9886\u53d6\u673a\u5236\u3002",
    "\u6210\u4eba\u5185\u5bb9\u8fc7\u6ee4\u89c4\u5219\u662f\u5426\u4f1a\u8bef\u5224\uff1f",
    "Ships for sale for in-game silver: https://example.invalid/trade",
    "\u52a0\u5fae\u4fe1\u4e00\u8d77\u73a9 DF",
    "Claim your free token airdrop",
  ];
  for (const [id, text] of safe.entries()) {
    const post = classifyRulePosts([{ id, text }])[0];
    assert.deepEqual(post.ruleMatches, [], text);
  }
});

test("repeated solicitation requires four identical messages plus an external contact and CTA", () => {
  const spam =
    "\u70b9\u6b64\u52a0\u5165\u9891\u9053\u9886\u53d6\u514d\u8d39\u793c\u7269\uff1ahttps://example.invalid/gift";
  const posts = [1, 2, 3, 4].map((id) => ({ id, text: spam }));
  const classified = classifyRulePosts(posts);
  assert.ok(
    classified.every((post) =>
      post.ruleMatches.includes("repeated-solicitation")
    )
  );
  assert.ok(
    classifyRulePosts(posts.slice(0, 3)).every(
      (post) => !post.ruleMatches.includes("repeated-solicitation")
    )
  );
  const chatter = classifyRulePosts(
    [1, 2, 3, 4].map((id) => ({
      id,
      text: "\u51c6\u5907\u653b\u51fb\u53f3\u4e0a\u89d2\u7684\u661f\u7403",
    }))
  );
  assert.ok(chatter.every((post) => !canFoldBasicRules(post)));
  assert.ok(
    classifyRulePosts(
      [1, 2, 3, 4].map((id) => ({
        id,
        text: "\u52a0\u5165 https://example.invalid \u770b\u770b",
      }))
    ).every((post) => !canFoldBasicRules(post))
  );
});
