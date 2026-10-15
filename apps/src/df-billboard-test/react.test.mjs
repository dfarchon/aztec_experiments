import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { createBillboardController } from './controller.ts';
import { classifyRulePosts } from './moderation.ts';

const compiled = await build({
  stdin: { contents: "export { App } from './App.tsx'; export { Feed } from './Feed.tsx';",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-router-dom'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { App, Feed } = module.exports;
const renderToStaticMarkup = element => renderMarkup(createElement(StaticRouter, { location: '/' }, element));

test('React renders the wallet, composer and disconnected action guards', () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /id="walletMenu"/);
  assert.match(html, /id="walletPanel"[^>]*hidden/);
  assert.match(html, /id="join"[^>]*disabled/);
  assert.match(html, /id="post"[^>]*disabled/);
  assert.match(html, /id="refresh"[^>]*disabled/);
  assert.match(html, /0 \/ 512 字节/);
  controller.dispose();
});

test('React feed escapes chain text, groups originals, folds analyzed AI hits and preserves malformed entries', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, rulesEnabled: false, aiHints: true,
    posts: classifyRulePosts([
      ...[0, 1, 2].map(id => ({ id, text: 'come to https://example.com' })),
      { id: 3, text: '<img src=x onerror=alert(1)>', aiLabels: ['insult'], aiAnalyzed: true },
      { id: 4, decodeError: true },
    ]) };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.equal((html.match(/class="is-folded"/g) || []).length, 1);
  assert.match(html, /另有 2 条相同消息/);
  assert.doesNotMatch(html, /推广规则详情|AI 分析详情|关键词命中详情/);
  for (let id = 0; id < 5; id++) assert.match(html, new RegExp(`data-post-id="${id}"`));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /无法解码为 UTF-8/);
  const unfiltered = renderToStaticMarkup(createElement(Feed, { view: { ...view, mergeDuplicates: false, aiHints: false }, controller: {} }));
  assert.doesNotMatch(unfiltered, /<details/);
  assert.doesNotMatch(unfiltered, /class="is-folded"/);
});

test('basic rules switch folds strong promotion without any per-post warning', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, rulesEnabled: false, aiHints: false,
    posts: classifyRulePosts([{ id: 0, text: '低价代练加微信 demo' }]) };
  const render = rulesEnabled => renderToStaticMarkup(createElement(Feed, { view: { ...view, rulesEnabled }, controller: {} }));
  assert.doesNotMatch(render(false), /class="is-folded"|<details/);
  assert.match(render(true), /class="is-folded"/);
  assert.match(render(true), /已折叠 · 查看原文/);
  assert.doesNotMatch(render(true), /推广规则详情|⚑/);
  for (const enabled of [false, true]) assert.match(render(enabled), /低价代练加微信 demo/);
});

test('basic rules fold solicitation independently of keywords and AI', () => {
  const posts = classifyRulePosts([
    { id: 0, text: '输入你的助记词领取奖励' },
    { id: 1, text: '不要输入助记词，警惕骗局' },
  ]);
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: false,
    rulesEnabled: true, keywordEnabled: false, aiHints: false, posts };
  const render = rulesEnabled => renderToStaticMarkup(createElement(Feed, { view: { ...view, rulesEnabled }, controller: {} }));
  assert.equal((render(true).match(/class="is-folded"/g) || []).length, 1);
  assert.match(render(true), /2 条消息 · 1 条折叠/);
  assert.doesNotMatch(render(false), /class="is-folded"/);
});

test('fold setting never hides context, policy, weak evidence or similar variants', () => {
  const posts = classifyRulePosts([
    { id: 0, text: '我们反对代练，具体规则看 https://example.org/rules 。' },
    { id: 1, text: 'Ships for sale for in-game silver: https://example.org/trade' },
    { id: 2, text: '代练限时优惠' },
    { id: 3, text: 'Meet now here' }, { id: 4, text: 'Meet nowhere' },
  ]);
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, rulesEnabled: true, aiHints: false, posts };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.doesNotMatch(html, /<details|class="is-folded"/);
  assert.doesNotMatch(html, /data-tier=|推广规则详情|相似消息详情/);
  assert.equal((html.match(/data-post-id=/g) || []).length, 5);
});

test('three independent folding switches default to off', () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(Feed, { view: controller.getSnapshot(), controller }));
  assert.doesNotMatch(html, /id="rulesEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="keywordEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="aiHints"[^>]*checked/);
  assert.match(html, /Content Safety Guard Small/);
  assert.match(html, /268 MB/);
  controller.dispose();
});

test('keyword folding is independent, literal, reversible, and escapes user words', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: false, rulesEnabled: false,
    keywordEnabled: true, keywordMode: 'contains', keywords: ['代练', '<script>'], aiHints: false,
    posts: classifyRulePosts([{ id: 0, text: '请不要相信代练' }, { id: 1, text: '<script>not executable</script>' }, { id: 2, text: '普通消息' }]) };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.equal((html.match(/class="is-folded"/g) || []).length, 2);
  assert.doesNotMatch(html, /命中你的屏蔽词|关键词命中详情/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /请不要相信代练/);
  assert.match(html, /3 条消息 · 2 条折叠/);
  const disabled = renderToStaticMarkup(createElement(Feed, { view: {...view,keywordEnabled:false}, controller: {} }));
  assert.doesNotMatch(disabled, /class="is-folded"|aria-label="推广规则详情"/);
  assert.match(disabled, /普通消息/);
});

test('AI folds only analyzed risk hits while pending and clean posts remain visible', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: false, rulesEnabled: false,
    aiHints: true, keywordEnabled: false, posts: [
      {id:0,text:'classified',aiLabels:['harassment'],aiAnalyzed:true},
      {id:1,text:'pending'}, {id:2,text:'checked',aiLabels:[],aiAnalyzed:true},
    ] };
  const html = renderToStaticMarkup(createElement(Feed, {view,controller:{}}));
  assert.equal((html.match(/class="is-folded"/g) || []).length, 1);
  assert.match(html, /data-post-id="1" class=""/);
  assert.match(html, /data-post-id="2" class=""/);
  assert.doesNotMatch(html, /AI 分析详情|AI 尚未检测|⚠|◇|◷/);
  const disabled = renderToStaticMarkup(createElement(Feed, {view:{...view,aiHints:false},controller:{}}));
  assert.doesNotMatch(disabled, /class="is-folded"/);
});

test('action failure is retained in an expandable alert and escapes raw error details', () => {
  const base = createBillboardController();
  const view = {...base.getSnapshot(), actionError: {label:'DF 入局', message:'Timestamp too old <script>',guidance:'检查链时间'}};
  const controller = {...base, getSnapshot:()=>view};
  const html = renderToStaticMarkup(createElement(App,{controller}));
  assert.match(html,/role="alert"/);
  assert.match(html,/DF 入局失败/);
  assert.match(html,/查看原因/);
  assert.match(html,/Timestamp too old &lt;script&gt;/);
  base.dispose();
});
