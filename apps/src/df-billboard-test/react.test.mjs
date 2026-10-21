import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";

import { createBillboardController } from "./controller.ts";
import { classifyRulePosts } from "./moderation.ts";

const compiled = await build({
  stdin: {
    contents:
      "export { App } from './App.tsx'; export { Feed, pageNumbers } from './Feed.tsx'; export { ReadingSettings } from './ReadingSettings.tsx'; export { Select } from './Select.tsx';",
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  external: ["react", "react/jsx-runtime", "react-router-dom"],
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports
);
const { App, Feed, pageNumbers, ReadingSettings, Select } = module.exports;
const renderToStaticMarkup = (element) =>
  renderMarkup(createElement(StaticRouter, { location: "/" }, element));

test("older posts remain reachable when every loaded post is filtered", () => {
  const controller = createBillboardController();
  const view = {
    ...controller.getSnapshot(),
    posts: [{ id: 24, text: "hidden" }],
    keywordEnabled: true,
    keywords: ["hidden"],
    feedLoaded: true,
    totalPosts: 25,
    hasOlderPosts: true,
    busy: true,
  };
  const render = () =>
    renderToStaticMarkup(createElement(Feed, { view, controller }));
  assert.match(render(), /No visible posts/);
  assert.match(render(), /1 \/ 25 loaded/);
  assert.match(render(), /<button disabled="">Load older posts/);
  view.hasOlderPosts = false;
  assert.doesNotMatch(render(), /Load older posts/);
  controller.dispose();
});

test("shared select labels its list and preserves disabled and selected options", () => {
  const render = (disabled = false) =>
    renderToStaticMarkup(
      createElement(Select, {
        id: "choice",
        "aria-label": "Choose a wallet",
        value: "saved",
        disabled,
        options: [
          { value: "saved", label: "Saved account" },
          { value: "unavailable", label: "Unavailable", disabled: true },
        ],
        onChange() {},
      })
    );
  const html = render();
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-controls="choice-options"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /role="listbox" aria-label="Choose a wallet" hidden/);
  assert.match(html, /role="option" aria-selected="true"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(render(true), /<button[^>]*disabled/);
  assert.doesNotMatch(html, /<select/);
});

test("React renders the wallet, composer and disconnected action guards", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /id="walletMenu"/);
  assert.match(html, /DFARCHON/);
  assert.match(html, /aria-label="Billboard navigation"/);
  assert.match(html, /Public board/);
  assert.match(html, /billboard-readme.md/);
  assert.doesNotMatch(html, /href="\/reports"|设计与测试 →/);
  assert.match(html, /id="walletPanel"[^>]*hidden/);
  assert.doesNotMatch(html, /id="join"|Core\.initialize_player|PlayerStorage/);
  assert.doesNotMatch(html, /id="post"[^>]*disabled/);
  assert.match(html, /Connect to post/);
  assert.match(html, /id="post"[^>]*aria-label="Connect to post"/);
  assert.match(
    html,
    /class="post-connect-label-mobile" aria-hidden="true">Connect<\/span>/
  );
  assert.match(html, /id="refresh"[^>]*disabled/);
  assert.match(html, /0 \/ 512 bytes/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  controller.dispose();
});

test("one wallet menu offers MetaMask and Aztec without a second composer", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletOpen: true,
    walletMode: "metamask",
    request: { available: true, payer: "", jobs: [] },
  };
  const html = renderToStaticMarkup(
    createElement(App, { controller: { ...base, getSnapshot: () => view } })
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /MetaMask · Pay L1 gas/);
  assert.match(html, /Azguard · L2 fees sponsored/);
  assert.doesNotMatch(
    html,
    /<select|testing only|testOptions|panel-address|id="localStatus"/
  );
  assert.match(html, /Connect MetaMask/);
  assert.match(html, /You pay L1 gas · L2 sponsored/);
  assert.equal((html.match(/id="message"/g) || []).length, 1);
  assert.doesNotMatch(html, /href="\/l1-post-lab"|l1-post-text/);
  assert.match(html, /id="localOptions" hidden/);
  base.dispose();
});

test("MetaMask recovery blocks new posts and keeps the original request visible", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletMode: "metamask",
    connected: true,
    address: "0xpayer",
    canPost: false,
    message: "pending",
    request: {
      available: true,
      payer: "0xpayer",
      jobs: [{ commitment: "one", text: "pending", l1Tx: "0xpaid" }],
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, { controller: { ...base, getSnapshot: () => view } })
    );
  assert.match(render(), /Resume post/);
  assert.match(render(), /id="post"[^>]*disabled/);
  assert.match(render(), /Switch wallet/);
  assert.doesNotMatch(render(), /class="panel-address"/);
  view.request.jobs[0].l1Tx = undefined;
  assert.match(render(), /aria-label="L1 transaction hash"/);
  assert.match(render(), /Recover post/);
  view.request.jobs[0].l1Tx = "0xpaid";
  view.request.jobs[0].l2Attempted = true;
  assert.match(render(), /aria-label="L2 transaction hash"/);
  base.dispose();
});

test("product sections support direct URLs and keep the composer mounted", () => {
  const controller = createBillboardController();
  for (const [section, title] of [
    ["settings", "Settings"],
    ["activity", "Activity"],
  ]) {
    const html = renderMarkup(
      createElement(
        StaticRouter,
        { location: `/?view=${section}` },
        createElement(App, { controller })
      )
    );
    assert.match(html, new RegExp(`<h1>${title}</h1>`));
    assert.match(html, /class="back-button" aria-label="Back to board"/);
    assert.ok(
      html.indexOf('class="back-button"') < html.indexOf(`<h1>${title}</h1>`)
    );
    assert.match(
      html,
      new RegExp(
        `<section class="[^"]+" aria-label="${section === "activity" ? "Publishing activity" : title}">`
      )
    );
    assert.match(
      html,
      /class="card compose-card" aria-label="Write a post" hidden=""/
    );
    assert.match(html, /id="message"/);
  }
  controller.dispose();
});

test("Onchain Reality shell keeps wallet and section controls above the board", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /class="billboard-app"/);
  assert.match(html, /<canvas class="ascii-clouds" aria-hidden="true">/);
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(header, /aria-label="Billboard navigation"/);
  assert.match(header, /id="walletMenu"/);
  assert.match(header, /class="header-action nav-item nav-settings"/);
  assert.match(header, /id="walletMenu"[^>]*class="header-action"/);
  assert.match(header, /orbit-mark brand-mark/);
  assert.match(html, /id="main-content" class="product-main" tabindex="-1"/);
  assert.match(html, /class="board-content is-board"/);
  assert.match(html, /class="board-page"/);
  assert.match(
    html,
    /class="feed-scroll"[^>]*role="region"[^>]*aria-label="Posts"/
  );
  assert.ok(html.indexOf('id="feed"') < html.indexOf('id="message"'));
  assert.doesNotMatch(
    html,
    /context-sidebar|orbit-art|page-orbit|Share a thought|A SPACE FOR EVERY VOICE/
  );
  const feed = renderToStaticMarkup(
    createElement(Feed, {
      view: { ...controller.getSnapshot(), posts: [], feedLoaded: true },
      controller,
    })
  );
  assert.match(feed, /id="feedSearch"[^>]*hidden/);
  assert.doesNotMatch(
    feed,
    /id="showFolded"|id="mergeDuplicates"|Reading preferences/
  );
  assert.doesNotMatch(header, /class="wallet-network"/);
  assert.ok(html.indexOf("</main>") < html.indexOf('class="site-footer"'));
  controller.dispose();
});

test("operation toast sits outside the board and retains accessible progress states", () => {
  const base = createBillboardController();
  for (const progress of [
    null,
    { label: "Connecting wallet", count: "In progress", total: 1 },
    { label: "Loading posts", count: "1/2", total: 2, value: 1 },
    { label: "Post completed", count: "1/1", total: 1, value: 1 },
    { label: "Post failed", count: "Failed", total: 1, failed: true },
  ]) {
    const view = { ...base.getSnapshot(), progress };
    const controller = { ...base, getSnapshot: () => view };
    const html = renderToStaticMarkup(createElement(App, { controller }));
    assert.ok(
      html.indexOf("</footer>") < html.indexOf('id="operationProgress"')
    );
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    const toast = html.slice(html.indexOf('id="operationProgress"'));
    if (!progress) assert.match(toast, /hidden=""/);
    else {
      assert.doesNotMatch(toast, /hidden=""/);
      assert.ok(toast.includes(progress.label));
      if (progress.failed) assert.match(toast, /operation-progress failed/);
      if (progress.value != null)
        assert.match(toast, new RegExp(`value="${progress.value}"`));
    }
  }
  base.dispose();
});

test("account actions live in the wallet without Ethereum copy controls", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    connected: true,
    address: "0x123456789",
    hasLocalAccount: true,
    walletOpen: true,
  };
  const controller = { ...base, getSnapshot: () => view };
  const html = renderToStaticMarkup(createElement(App, { controller }));
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(header, /My wallet/);
  assert.match(header, /id="copyAddress"/);
  assert.match(header, /id="backupAccount"/);
  assert.match(header, /Keep the backup private/);
  assert.doesNotMatch(html, /id="accountBar"/);
  assert.doesNotMatch(html, /publishToL1|Ethereum cop|publish-l1/);
  const settings = html.slice(
    html.indexOf('class="preferences-page"'),
    html.indexOf('class="activity-page"')
  );
  assert.doesNotMatch(settings, /id="mergeDuplicates"/);
  assert.doesNotMatch(settings, /Connection details &amp; activity log/);
  base.dispose();
});

test("developer connection details are opt-in and proof mode is not a user control", () => {
  const controller = createBillboardController();
  const production = renderToStaticMarkup(createElement(App, { controller }));
  const development = renderToStaticMarkup(
    createElement(App, { controller, development: true })
  );
  assert.doesNotMatch(
    production,
    /Connection details &amp; activity log|id="log"/
  );
  assert.match(development, /Connection details &amp; activity log/);
  for (const html of [production, development])
    assert.doesNotMatch(
      html,
      /id="realProofs"|Generate real client proofs|Advanced options/
    );
  controller.dispose();
});

test("wallet selector has three methods and nests browser account actions", () => {
  const base = createBillboardController();
  for (const mode of ["metamask", "extension", "local", "create", "import"]) {
    const view = { ...base.getSnapshot(), walletMode: mode };
    const html = renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
    const options = [
      ...html.matchAll(
        /<div id="walletMode-options-\d+"[^>]*><span>(.*?)<\/span>/g
      ),
    ];
    assert.equal(options.length, 3);
    const methods = options.map((option) => option[1]).join(" ");
    for (const name of ["MetaMask", "Azguard", "Browser wallet"])
      assert.ok(methods.includes(name));
    assert.doesNotMatch(
      methods,
      /Create account|Import backup|Use saved account/
    );
    if (["metamask", "extension"].includes(mode)) {
      assert.match(html, /id="localOptions" hidden/);
    } else {
      assert.doesNotMatch(html, /id="localOptions" hidden/);
      assert.match(html, /id="browserAccountAction"/);
      assert.match(html, /Create account/);
      assert.match(html, /Import backup/);
    }
  }
  base.dispose();
});

test("wallet modes and AI consent use English-only interface copy", () => {
  const base = createBillboardController();
  try {
    for (const walletMode of [
      "local",
      "create",
      "import",
      "extension",
      "metamask",
    ]) {
      const view = {
        ...base.getSnapshot(),
        walletMode,
        walletOpen: true,
        aiConsentOpen: true,
        aiHints: true,
      };
      const controller = { ...base, getSnapshot: () => view };
      const html = renderToStaticMarkup(createElement(App, { controller }));
      assert.doesNotMatch(html, /\p{Script=Han}/u, walletMode);
      assert.match(html, /Download &amp; enable/);
      assert.match(html, /Your L1 payer address is public/);
    }
  } finally {
    base.dispose();
  }
});

test("pagination bounds page links for empty, short and large feeds", () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
  assert.deepEqual(pageNumbers(50, 100), [1, 49, 50, 51, 100]);
  assert.deepEqual(pageNumbers(100, 100), [1, 99, 100]);
});

test("feed starts with the newest 10 posts and numbered pagination", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(
    createElement(Feed, {
      controller,
      view: {
        ...controller.getSnapshot(),
        feedLoaded: true,
        posts: Array.from({ length: 25 }, (_, id) => ({
          id,
          text: `Post ${id}`,
        })),
      },
    })
  );
  const ids = [...html.matchAll(/data-post-id="(\d+)"/g)].map((match) =>
    Number(match[1])
  );
  assert.deepEqual(
    ids,
    Array.from({ length: 10 }, (_, i) => 24 - i)
  );
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /aria-label="Post pagination"/);
  // Pagination is a sibling of the scrolling list, not part of its contents.
  assert.match(html, /<\/ol><\/div><div class="feed-footer">/);
  assert.match(html, /aria-label="Next page"/);
  assert.doesNotMatch(html, /Anonymous|post-avatar|Load more|<details/);
  assert.match(html, /Search loaded posts/);
  controller.dispose();
});

test("React feed keeps duplicates flat, excludes filtered hits and preserves malformed entries", () => {
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: false,
    aiHints: true,
    posts: classifyRulePosts([
      ...[0, 1, 2].map((id) => ({ id, text: "come to https://example.com" })),
      {
        id: 3,
        text: "<img src=x onerror=alert(1)>",
        aiLabels: ["insult"],
        aiAnalyzed: true,
      },
      { id: 4, decodeError: true },
    ]),
  };
  const html = renderToStaticMarkup(
    createElement(Feed, { view, controller: {} })
  );
  assert.doesNotMatch(html, /<details|identical posts|Anonymous/);
  assert.match(html, /Filtered \(1\)/);
  assert.doesNotMatch(html, /推广规则详情|AI 分析详情|关键词命中详情/);
  for (const id of [0, 1, 2, 4])
    assert.match(html, new RegExp(`data-post-id="${id}"`));
  assert.doesNotMatch(html, /data-post-id="3"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /could not be decoded as UTF-8/);
  const unfiltered = renderToStaticMarkup(
    createElement(Feed, {
      view: { ...view, aiHints: false },
      controller: {},
    })
  );
  assert.doesNotMatch(unfiltered, /<details(?! class="reading-panel")/);
  assert.doesNotMatch(unfiltered, /class="is-folded"/);
  assert.match(unfiltered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(unfiltered, /<img/);
  assert.equal((unfiltered.match(/data-post-id=/g) || []).length, 5);
});

test("basic rules exclude strong promotion without per-post warnings", () => {
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: false,
    aiHints: false,
    posts: classifyRulePosts([{ id: 0, text: "低价代练加微信 demo" }]),
  };
  const render = (rulesEnabled) =>
    renderToStaticMarkup(
      createElement(Feed, { view: { ...view, rulesEnabled }, controller: {} })
    );
  assert.doesNotMatch(
    render(false),
    /class="is-folded"|<details(?! class="reading-panel")/
  );
  assert.doesNotMatch(render(true), /data-post-id="0"|低价代练加微信 demo/);
  assert.match(render(true), /Filtered \(1\)/);
  assert.doesNotMatch(render(true), /推广规则详情|⚑/);
  assert.match(render(false), /低价代练加微信 demo/);
});

test("basic rules fold solicitation independently of keywords and AI", () => {
  const posts = classifyRulePosts([
    { id: 0, text: "输入你的助记词领取奖励" },
    { id: 1, text: "不要输入助记词，警惕骗局" },
  ]);
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: true,
    keywordEnabled: false,
    aiHints: false,
    posts,
  };
  const render = (rulesEnabled) =>
    renderToStaticMarkup(
      createElement(Feed, { view: { ...view, rulesEnabled }, controller: {} })
    );
  assert.doesNotMatch(render(true), /data-post-id="0"/);
  assert.match(render(true), /data-post-id="1"/);
  assert.match(render(true), /2 loaded posts · 1 filtered/);
  assert.match(render(false), /data-post-id="0"/);
});

test("fold setting never hides context, policy, weak evidence or similar variants", () => {
  const posts = classifyRulePosts([
    { id: 0, text: "我们反对代练，具体规则看 https://example.org/rules 。" },
    {
      id: 1,
      text: "Ships for sale for in-game silver: https://example.org/trade",
    },
    { id: 2, text: "代练限时优惠" },
    { id: 3, text: "Meet now here" },
    { id: 4, text: "Meet nowhere" },
  ]);
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: true,
    aiHints: false,
    posts,
  };
  const html = renderToStaticMarkup(
    createElement(Feed, { view, controller: {} })
  );
  assert.doesNotMatch(
    html,
    /<details(?! class="reading-panel")|class="is-folded"/
  );
  assert.doesNotMatch(html, /data-tier=|推广规则详情|相似消息详情/);
  assert.equal((html.match(/data-post-id=/g) || []).length, 5);
});

test("three independent folding switches default to off", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(
    createElement(ReadingSettings, {
      view: controller.getSnapshot(),
      controller,
    })
  );
  assert.doesNotMatch(html, /id="rulesEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="keywordEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="aiHints"[^>]*checked/);
  assert.match(html, /Content Safety Guard Small/);
  assert.match(html, /268 MB/);
  assert.doesNotMatch(html, /mergeDuplicates|Group duplicate posts/);
  controller.dispose();
});

test("keyword folding is independent, literal, reversible, and escapes user words", () => {
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: false,
    keywordEnabled: true,
    keywordMode: "contains",
    keywords: ["代练", "<script>"],
    aiHints: false,
    posts: classifyRulePosts([
      { id: 0, text: "请不要相信代练" },
      { id: 1, text: "<script>not executable</script>" },
      { id: 2, text: "普通消息" },
    ]),
  };
  const html = renderToStaticMarkup(
    createElement(Feed, { view, controller: {} })
  );
  assert.equal((html.match(/data-post-id=/g) || []).length, 1);
  assert.doesNotMatch(html, /命中你的屏蔽词|关键词命中详情/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /请不要相信代练/);
  assert.match(html, /3 loaded posts · 2 filtered/);
  const disabled = renderToStaticMarkup(
    createElement(Feed, {
      view: { ...view, keywordEnabled: false },
      controller: {},
    })
  );
  assert.doesNotMatch(disabled, /class="is-folded"|aria-label="推广规则详情"/);
  assert.match(disabled, /普通消息/);
  assert.match(disabled, /请不要相信代练/);
  assert.match(disabled, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(disabled, /<script>/);
});

test("Feed applies all eight filter combinations and counts overlapping hits once", () => {
  const posts = [
    { id: 0, text: "ordinary message" },
    { id: 1, text: "blocked keyword" },
    { id: 2, text: "rule hit", ruleMatches: ["promotion"] },
    { id: 3, text: "AI hit", aiAnalyzed: true, aiLabels: ["harassment"] },
    {
      id: 4,
      text: "blocked overlap",
      ruleMatches: ["promotion"],
      aiAnalyzed: true,
      aiLabels: ["harassment"],
    },
  ];
  for (const keywordEnabled of [false, true])
    for (const rulesEnabled of [false, true])
      for (const aiHints of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(Feed, {
            view: {
              feedLoaded: true,
              posts,
              keywordEnabled,
              keywordMode: "contains",
              keywords: ["blocked"],
              rulesEnabled,
              aiHints,
            },
            controller: {},
          })
        );
        const hidden = [
          false,
          keywordEnabled,
          rulesEnabled,
          aiHints,
          keywordEnabled || rulesEnabled || aiHints,
        ];
        hidden.forEach((filtered, id) =>
          assert.equal(html.includes(`data-post-id="${id}"`), !filtered)
        );
        const count = hidden.filter(Boolean).length;
        assert.equal((html.match(/data-post-id=/g) || []).length, 5 - count);
        if (count)
          assert.match(html, new RegExp(`5 loaded posts · ${count} filtered`));
      }
});

test("AI folds only analyzed risk hits while pending and clean posts remain visible", () => {
  const view = {
    busy: false,
    connected: true,
    feedLoaded: true,
    rulesEnabled: false,
    aiHints: true,
    keywordEnabled: false,
    posts: [
      { id: 0, text: "classified", aiLabels: ["harassment"], aiAnalyzed: true },
      { id: 1, text: "pending" },
      { id: 2, text: "checked", aiLabels: [], aiAnalyzed: true },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(Feed, { view, controller: {} })
  );
  assert.doesNotMatch(html, /data-post-id="0"/);
  assert.match(html, /data-post-id="1"/);
  assert.match(html, /data-post-id="2"/);
  assert.doesNotMatch(html, /AI 分析详情|AI 尚未检测|⚠|◇|◷/);
  const disabled = renderToStaticMarkup(
    createElement(Feed, { view: { ...view, aiHints: false }, controller: {} })
  );
  assert.doesNotMatch(disabled, /class="is-folded"/);
  assert.match(disabled, /data-post-id="0"/);
});

test("action failure is retained in an expandable alert and escapes raw error details", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    actionError: {
      label: "Anonymous posting",
      message: "Timestamp too old <script>",
      guidance: "Check chain time",
    },
  };
  const controller = { ...base, getSnapshot: () => view };
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Anonymous posting failed/);
  assert.match(html, /View details/);
  assert.match(html, /Timestamp too old &lt;script&gt;/);
  base.dispose();
});
