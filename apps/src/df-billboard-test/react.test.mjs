import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { createBillboardController } from './controller.mjs';
import { classifyRulePosts } from './moderation.mjs';

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

test('React feed escapes chain text, groups originals and preserves AI labels and malformed entries', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, adMode: 'hint', aiHints: true,
    posts: classifyRulePosts([
      ...[0, 1, 2].map(id => ({ id, text: 'come to https://example.com' })),
      { id: 3, text: '<img src=x onerror=alert(1)>', aiLabels: ['insult'] },
      { id: 4, decodeError: true },
    ]) };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.match(html, /另有 2 条相同消息/);
  assert.doesNotMatch(html, /aria-label="推广规则详情"/);
  for (let id = 0; id < 5; id++) assert.match(html, new RegExp(`data-post-id="${id}"`));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /实验性 AI 提示：辱骂/);
  assert.match(html, /无法解码为 UTF-8/);
  const unfiltered = renderToStaticMarkup(createElement(Feed, { view: { ...view, mergeDuplicates: false, aiHints: false }, controller: {} }));
  assert.doesNotMatch(unfiltered, /<details/);
  assert.doesNotMatch(unfiltered, /实验性 AI 提示：辱骂/);
});

test('advertising modes show, hint, or fold without discarding original text', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, aiHints: false,
    posts: classifyRulePosts([{ id: 0, text: '低价代练加微信 demo' }]) };
  const render = adMode => renderToStaticMarkup(createElement(Feed, { view: { ...view, adMode }, controller: {} }));
  assert.doesNotMatch(render('show'), /aria-label="推广规则详情"|<details/);
  assert.match(render('hint'), /aria-label="推广规则详情"/);
  assert.match(render('hint'), />⚑<\/button>/);
  assert.doesNotMatch(render('hint'), /<details/);
  assert.match(render('fold'), /<details/);
  for (const mode of ['show', 'hint', 'fold']) assert.match(render(mode), /低价代练加微信 demo/);
});

test('fold setting never hides context, policy, weak evidence or similar variants', () => {
  const posts = classifyRulePosts([
    { id: 0, text: '我们反对代练，具体规则看 https://example.org/rules 。' },
    { id: 1, text: 'Ships for sale for in-game silver: https://example.org/trade' },
    { id: 2, text: '代练限时优惠' },
    { id: 3, text: 'Meet now here' }, { id: 4, text: 'Meet nowhere' },
  ]);
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: true, adMode: 'fold', aiHints: false, posts };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.doesNotMatch(html, /<details|class="is-folded"/);
  assert.match(html, /data-tier="context"/);
  assert.match(html, /data-tier="policy"/);
  assert.match(html, /data-tier="possible"/);
  assert.match(html, /可能重复；未合并/);
  assert.equal((html.match(/data-post-id=/g) || []).length, 5);
});

test('three independent switches default to rules on, keywords and AI off', () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(Feed, { view: controller.getSnapshot(), controller }));
  assert.match(html, /id="adEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="keywordEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="aiHints"[^>]*checked/);
  assert.match(html, /Content Safety Guard Small/);
  assert.match(html, /268 MB/);
  controller.dispose();
});

test('keyword folding is independent, literal, reversible, and escapes user words', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: false, adMode: 'fold', adEnabled: false,
    keywordEnabled: true, keywordMode: 'contains', keywords: ['代练', '<script>'], aiHints: false,
    posts: classifyRulePosts([{ id: 0, text: '请不要相信代练' }, { id: 1, text: '<script>not executable</script>' }, { id: 2, text: '普通消息' }]) };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller: {} }));
  assert.equal((html.match(/class="is-folded"/g) || []).length, 2);
  assert.match(html, /命中你的屏蔽词：代练/);
  assert.match(html, /命中你的屏蔽词：&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /请不要相信代练/);
  assert.match(html, /关键词命中 2 条/);
  const disabled = renderToStaticMarkup(createElement(Feed, { view: {...view,keywordEnabled:false}, controller: {} }));
  assert.doesNotMatch(disabled, /class="is-folded"|aria-label="推广规则详情"/);
  assert.match(disabled, /普通消息/);
});

test('AI results alone never fold a post and pending is distinct from no risk detected', () => {
  const view = { busy: false, connected: true, feedLoaded: true, mergeDuplicates: false, adMode: 'hint', adEnabled: true,
    aiHints: true, keywordEnabled: false, posts: [
      {id:0,text:'classified',aiLabels:['harassment'],aiAnalyzed:true},
      {id:1,text:'pending'}, {id:2,text:'checked',aiLabels:[],aiAnalyzed:true},
    ] };
  const html = renderToStaticMarkup(createElement(Feed, {view,controller:{}}));
  assert.doesNotMatch(html, /class="is-folded"/);
  assert.match(html, /骚扰／辱骂/);
  assert.match(html, /AI 尚未检测/);
  assert.match(html, /AI 未提示风险 · 不代表安全/);
  assert.match(html, />⚠<\/button>/);
  assert.match(html, />◇<\/button>/);
  assert.match(html, />◷<\/button>/);
  assert.doesNotMatch(html, /class="hint-content is-open"/);
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
