import assert from 'node:assert/strict';
import test from 'node:test';
import { canFoldPromotion, classifyRulePosts, groupDuplicatePosts, hasContactSignal, isPromotion, normalizeMessage } from './moderation.ts';

test('grouping normalization preserves case, unicode forms and word boundaries', () => {
  assert.equal(normalizeMessage(' Ｈｅｌｌｏ\u200b  DF '), 'Ｈｅｌｌｏ\u200b DF');
  assert.equal(normalizeMessage('one\r\ntwo'), 'one\ntwo');
});

test('repeated links are grouped without labeling them as advertisements', () => {
  const posts = [1, 2, 3].map(id => ({ id, text: '加入 https://example.com 看看' }));
  const classified = classifyRulePosts(posts);
  assert.ok(classified.every(post => post.adReasons.length === 0));
  assert.deepEqual(groupDuplicatePosts(classified).map(group => group.map(post => post.id)), [[1, 2, 3]]);
  assert.equal(groupDuplicatePosts(classified, false).length, 3);
});

test('repeated game chatter and unique links stay visible', () => {
  const posts = [
    ...[1, 2, 3].map(id => ({ id, text: '准备攻击右上角的星球' })),
    { id: 4, text: '项目文档在 https://example.com' },
  ];
  assert.ok(classifyRulePosts(posts).every(post => post.adReasons.length === 0));
});

test('contact signal handles email and Chinese contact hints', () => {
  assert.equal(hasContactSignal('help@example.com'), true);
  assert.equal(hasContactSignal('加微信一起玩'), true);
  assert.equal(hasContactSignal('我去占领星球'), false);
});

test('malformed and empty messages do not break classification', () => {
  const posts = [{ id: 0, decodeError: true }, { id: 1, text: '' }, { id: 2, text: '  ' }];
  assert.ok(classifyRulePosts(posts).every(post => post.adReasons.length === 0));
  assert.equal(groupDuplicatePosts(posts).length, 3);
  assert.deepEqual(posts[0], { id: 0, decodeError: true });
});

test('normalized repetitions are counted without changing the original text', () => {
  const posts = [
    { id: 0, text: '加微信一起玩 DF' },
    { id: 1, text: '加微信一起玩 df' },
    { id: 2, text: '加微\u200b信一起玩 ＤＦ' },
  ];
  const classified = classifyRulePosts(posts);
  assert.deepEqual(groupDuplicatePosts(classified).map(group => group.map(post => post.id)), [[0], [1], [2]]);
  assert.deepEqual(classified.map(post => post.similarTo), [null, 0, 0]);
  assert.ok(classified.every(post => !post.adReasons.length));
  assert.equal(classified[2].text, posts[2].text);
  assert.equal(posts[2].adReasons, undefined);
});

test('promotional wording AND contact are required, including full-width and homophone variants', () => {
  const ads = ['免费代练限时优惠，加微信 df_demo：https://example.invalid/promo',
    '免 费 代 练 限 时 优 惠，加 微 信 ｄｆ＿ｄｅｍｏ：https://example.invalid/promo',
    '免费代练限时优惠，加微\u200b信 df_demo：https://example.invalid/promo',
    '低价代练今天特惠，微信 df_demo，详情 https://example.invalid/promo',
    '包赢代练，薇信搜 df_demo，私聊领优惠。',
    'Buy cheap boosting now! Contact promo_demo at https://example.invalid/deal'];
  assert.ok(classifyRulePosts(ads.map((text, id) => ({ id, text }))).every(canFoldPromotion));
  const safe = ['新人攻略 https://example.invalid/guide ，这是我整理的免费游戏教程。',
    '需要出生点攻略可以看 https://example.invalid/help ，不是广告。',
    '加微信一起玩', '攻略 https://example.invalid/promo',
    'Contact sale@example.invalid', 'https://example.invalid/代练'];
  assert.ok(classifyRulePosts(safe.map((text, id) => ({ id, text }))).every(post => !post.adReasons.length));
});

test('grouping preserves originals and labels and never merges similar but different messages', () => {
  const posts = [{ id: 1, text: 'Hello DF', aiLabels: ['insult'] },
    { id: 2, text: 'hello\u200b ＤＦ' }, { id: 3, text: 'Hello DF!' },
    { id: 4, text: 'Hello DF', decodeError: true }];
  assert.deepEqual(groupDuplicatePosts(posts).map(group => group.map(post => post.id)), [[1], [2], [3], [4]]);
  assert.equal(groupDuplicatePosts(posts)[0][0], posts[0]);
  assert.deepEqual(posts[0].aiLabels, ['insult']);
});

test('additional examples separate game purchasing and neutral contacts from sales pitches', () => {
  const examples = [
    ['Where can I buy a ship? Guide: https://example.invalid/ships', false],
    ['The sale mechanic is explained at https://example.invalid/rules', false],
    ['一起探索地图，薇信 df_friends', false],
    ['Discount coaching, email lessons@example.com', true],
    ['Ships for sale! https://example.invalid/shop', false],
    ['低价代练 vx demo', true],
  ];
  for (const [text, expected] of examples) {
    assert.equal(isPromotion(classifyRulePosts([{ id: 1, text }])[0]), expected, text);
  }
});
test('known semantic collisions never merge but can receive a possible-duplicate hint', () => {
  for (const [a, b] of [['Meet now here', 'Meet nowhere'], ['Please re sign this', 'Please resign this'],
    ['https://example.org/MapA', 'https://example.org/mapa'], ['Send code AbC9', 'Send code abc9']]) {
    const posts = classifyRulePosts([{ id: 0, text: a }, { id: 1, text: b }]);
    assert.equal(groupDuplicatePosts(posts).length, 2);
    assert.equal(posts[1].similarTo, 0);
  }
  const posts = [{ id: 0, text: 'Hello   DF' }, { id: 1, text: ' Hello DF ' }];
  assert.equal(groupDuplicatePosts(posts).length, 1);
});

test('context, policy, weak evidence and strong offers have distinct folding eligibility', () => {
  const cases = [
    ['我们反对代练，具体规则看 https://example.org/rules 。', 'context'],
    ['Do not buy cheap boosting from https://example.org/scam . It is a scam warning.', 'context'],
    ['Ships for sale for in-game silver only: https://example.org/trade .', 'policy'],
    ['来我们联盟吧！QQ群 forest_team，今晚一起玩。', 'policy'],
    ['代练限时优惠', 'possible'],
    ['Boosting packages available. Details are in my bio.', 'possible'],
    ['不是广告，低价代练接单，加微信 demo', 'likely'],
    ['Not an ad! Buy cheap boosting at https://example.org/deal', 'likely'],
    ['Avoid scams, buy our coaching for $20: https://example.org/deal', 'possible'],
  ];
  for (const [text, tier] of cases) {
    const post = classifyRulePosts([{ id: 1, text }])[0];
    assert.equal(post.adTier, tier, text);
    assert.equal(canFoldPromotion(post), tier === 'likely', text);
  }
});
