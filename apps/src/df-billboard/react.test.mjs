import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";

import { createBillboardController } from "./controller.ts";

const compiled = await build({
  stdin: {
    contents:
      "export { PostTime, formatPostTime } from './PostTime.tsx'; export { App } from './App.tsx'; export { Feed } from './Feed.tsx'; export { Select } from './Select.tsx';",
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  external: [
    "react",
    "react/jsx-runtime",
    "react-router-dom",
    "./board-guide-driver",
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports
);
const { App, Feed, Select, PostTime, formatPostTime } = module.exports;
const renderToStaticMarkup = (element) =>
  renderMarkup(createElement(StaticRouter, { location: "/" }, element));

test("the initial feed shows a skeleton until its first page is complete", () => {
  const controller = createBillboardController();
  const view = {
    ...controller.getSnapshot(),
    canRead: true,
    feedLoading: true,
  };
  const html = renderToStaticMarkup(createElement(Feed, { view, controller }));
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /data-post-id=/);
  assert.match(html, /class="feed-skeleton" aria-hidden="true"/);
  assert.equal((html.match(/class="feed-skeleton-row"/g) || []).length, 3);
  assert.match(html, /Loading posts… 0 \/ 0 loaded/);
  assert.doesNotMatch(html, /shown/);
  assert.match(html, /id="refresh"[^>]*disabled/);
  assert.doesNotMatch(html, /class="empty-state"|No post yet|Load older posts/);
  controller.dispose();
});

test("feed uses skeletons only while content is missing or older posts load", () => {
  const controller = createBillboardController();
  const base = controller.getSnapshot();
  const render = (view) =>
    renderToStaticMarkup(createElement(Feed, { view, controller }));
  assert.match(render(base), /class="feed-skeleton" aria-hidden="true"/);
  const empty = render({ ...base, feedLoaded: true });
  assert.match(empty, /class="card feed-card is-empty"/);
  assert.match(empty, /No post yet/);
  const loaded = {
    ...base,
    feedLoaded: true,
    posts: [{ id: 1, text: "Still visible" }],
  };
  assert.doesNotMatch(render(loaded), /class="feed-skeleton"/);
  const refreshing = render({
    ...loaded,
    feedLoading: true,
    hasOlderPosts: true,
    progress: { label: "Loading recent posts…", completed: false },
  });
  assert.doesNotMatch(refreshing, /Still visible|data-post-id=/);
  assert.match(refreshing, /Refreshing posts…/);
  assert.equal(
    (refreshing.match(/class="feed-skeleton-row"/g) || []).length,
    3
  );
  const emptyRefresh = render({ ...loaded, posts: [], feedLoading: true });
  assert.match(emptyRefresh, /class="feed-skeleton"/);
  assert.doesNotMatch(emptyRefresh, /No post yet/);
  const older = render({
    ...loaded,
    feedLoading: true,
    hasOlderPosts: true,
    progress: { label: "Loading older posts…", completed: false },
  });
  assert.match(older, /Still visible/);
  assert.equal((older.match(/class="feed-skeleton-row"/g) || []).length, 1);
  const failedRefresh = render({
    ...loaded,
    actionError: { label: "Refresh posts", message: "offline", guidance: "" },
  });
  assert.match(failedRefresh, /Still visible/);
  assert.doesNotMatch(failedRefresh, /class="feed-skeleton"/);
  controller.dispose();
});

test("old settings and about URLs show the board without filtering posts", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    feedLoaded: true,
    posts: [
      { id: 1, text: "ordinary message" },
      {
        id: 2,
        text: "<script>literal text</script>",
        ruleMatches: ["promotion"],
      },
    ],
  };
  const controller = { ...base, getSnapshot: () => view };
  for (const url of ["/?view=settings", "/?view=about"]) {
    const html = renderMarkup(
      createElement(
        StaticRouter,
        { location: url },
        createElement(App, { controller })
      )
    );
    assert.match(html, /aria-label="Public posts"/);
    assert.match(html, /data-post-id="1"/);
    assert.match(html, /data-post-id="2"/);
    assert.match(html, /&lt;script&gt;literal text&lt;\/script&gt;/);
    assert.doesNotMatch(
      html,
      /<h1>Settings<\/h1>|<h1>About<\/h1>|Filter(?:ed)? \(/
    );
  }
  base.dispose();
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

test("the board renders a single disconnected composer and no wallet modal", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /id="walletMenu"/);
  assert.doesNotMatch(html, /id="walletPanel"/);
  assert.match(html, /id="post"[^>]*aria-label="Connect to post"/);
  assert.equal((html.match(/id="message"/g) || []).length, 1);
  assert.match(html, /NOTCH/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  controller.dispose();
});

test("the wallet waits for a ready private account before staking", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletOpen: true,
    stake: { ...base.getSnapshot().stake, available: true },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
  assert.match(render(), /role="dialog" aria-modal="true"/);
  assert.match(render(), /01<\/span>Connect/);
  assert.match(render(), /02<\/span>Stake/);
  assert.match(render(), /03<\/span>Post/);
  assert.match(render(), /Finding wallets/);
  assert.doesNotMatch(
    render(),
    /Aztec extension wallet|Download private account backup|<select/
  );
  view.stake = { ...view.stake, payer: `0x${"1".repeat(40)}` };
  assert.match(render(), /Finding wallets/);
  assert.doesNotMatch(render(), /Download private account backup/);
  view.stake = {
    ...view.stake,
    payer: `0x${"1".repeat(40)}`,
    owner: `0x${"2".repeat(64)}`,
    amount: "500000000000000",
  };
  assert.match(render(), /0.0005 ETH/);
  assert.match(render(), /5 posts \/ 24h/);
  assert.match(render(), /Ready to post/);
  assert.doesNotMatch(render(), /Finding wallets/);
  base.dispose();
});

test("pending stake and withdrawal recovery stay inside the wallet", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletOpen: true,
    stake: {
      ...base.getSnapshot().stake,
      payer: `0x${"1".repeat(40)}`,
      owner: `0x${"2".repeat(64)}`,
      pendingDeposit: true,
      depositNeedsHash: true,
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
  assert.match(render(), /L1 deposit transaction hash/);
  assert.match(render(), /Continue deposit/);
  view.stake = { ...view.stake, depositNeedsHash: false, claimNeedsHash: true };
  assert.match(render(), /Aztec claim transaction hash/);
  view.stake = {
    ...view.stake,
    pendingDeposit: false,
    claimNeedsHash: false,
    pendingExit: true,
    exitNeedsHash: true,
  };
  assert.match(render(), /Aztec withdrawal transaction hash/);
  assert.match(render(), /Complete withdrawal/);
  assert.doesNotMatch(render(), /Activity|Unfinished post/);
  base.dispose();
});

test("Onchain Reality shell keeps the wallet above the board", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(createElement(App, { controller }));
  assert.match(html, /class="billboard-app"/);
  assert.match(html, /<canvas class="ascii-clouds" aria-hidden="true">/);
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.doesNotMatch(header, /Settings|About/);
  assert.match(header, /id="walletMenu"/);
  assert.match(header, /class="header-control theme-toggle"/);
  assert.match(
    header,
    /id="walletMenu"[^>]*class="header-control header-action"/
  );
  assert.match(header, /NOTCH/);
  assert.match(header, /class="brand-mark"/);
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
  assert.match(feed, /id="refresh"[^>]*aria-label="Refresh posts"/);
  assert.doesNotMatch(feed, /Public board|Sort posts|feed-heading/);
  assert.doesNotMatch(feed, /feedSearch|type="search"|Search loaded posts/);
  assert.doesNotMatch(
    feed,
    /id="showFolded"|id="mergeDuplicates"|Reading preferences/
  );
  assert.doesNotMatch(header, /class="wallet-network"/);
  controller.dispose();
});

test("operation toast only shows completed results outside the board", () => {
  const base = createBillboardController();
  for (const progress of [
    null,
    { label: "Connecting wallet", completed: false },
    { label: "Preparing post", completed: false },
    { label: "Refresh posts completed", completed: true },
    { label: "Load older posts completed", completed: true },
    { label: "Post completed", completed: true },
    { label: "Post failed", completed: true, failed: true },
  ]) {
    const view = { ...base.getSnapshot(), progress };
    const controller = { ...base, getSnapshot: () => view };
    const html = renderToStaticMarkup(createElement(App, { controller }));
    assert.ok(
      html.indexOf("</footer>") < html.indexOf('id="operationProgress"')
    );
    const toast = html.slice(html.indexOf('id="operationProgress"'));
    if (
      !progress?.completed ||
      ["Refresh posts completed", "Load older posts completed"].includes(
        progress.label
      )
    )
      assert.match(toast, /hidden=""/);
    else {
      assert.doesNotMatch(toast, /hidden=""/);
      assert.ok(toast.includes(progress.label));
      if (progress.failed) assert.match(toast, /operation-progress failed/);
      assert.match(toast, progress.failed ? /role="alert"/ : /role="status"/);
    }
    assert.doesNotMatch(toast, /<progress|In progress|operationCount/);
  }
  base.dispose();
});

test("stake choices appear after connection and backup stays optional", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletOpen: true,
    stake: {
      ...base.getSnapshot().stake,
      payer: `0x${"1".repeat(40)}`,
      owner: `0x${"2".repeat(64)}`,
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
  const html = render();
  assert.match(html, /Stake to post|Connected/);
  assert.match(html, /Restore backup/);
  assert.match(html, /notch-wallet-actions/);
  assert.match(html, /Download backup/);
  assert.match(html, /notch-stake-options/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  view.stake = {
    ...view.stake,
    pendingDeposit: true,
    pendingAmount: "500000000000000",
    depositPrepared: true,
  };
  const prepared = render();
  assert.match(prepared, /Confirm stake/);
  assert.match(prepared, /To stake/);
  assert.match(prepared, /0\.0005/);
  assert.match(prepared, /Change amount/);
  assert.match(prepared, /Download backup/);
  assert.doesNotMatch(prepared, /notch-stake-options/);
  view.busy = true;
  view.progress = {
    label: "Confirm the stake in your wallet…",
    completed: false,
    failed: false,
  };
  assert.match(render(), /Processing stake/);
  assert.match(render(), /Confirm the stake in your wallet/);
  view.busy = false;
  view.progress = null;
  view.stake = { ...view.stake, depositPrepared: false };
  assert.doesNotMatch(render(), /Change amount/);
  base.dispose();
});

test("feed renders loaded posts newest first with a scroll sentinel", () => {
  const controller = createBillboardController();
  const html = renderToStaticMarkup(
    createElement(Feed, {
      controller,
      view: {
        ...controller.getSnapshot(),
        feedLoaded: true,
        hasOlderPosts: true,
        totalPosts: 35,
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
    Array.from({ length: 25 }, (_, i) => 24 - i)
  );
  assert.match(html, /class="feed-sentinel"/);
  assert.doesNotMatch(
    html,
    /Page 1 of 3|Post pagination|Next page|Load older posts|post-avatar/
  );
  assert.match(html, /id="refresh"[^>]*aria-label="Refresh posts"/);
  assert.doesNotMatch(html, /type="search"|Search loaded posts/);
  const failed = renderToStaticMarkup(
    createElement(Feed, {
      controller,
      view: {
        ...controller.getSnapshot(),
        feedLoaded: true,
        hasOlderPosts: true,
        posts: [{ id: 1, text: "Recent" }],
        actionError: {
          label: "Load older posts",
          message: "offline",
          guidance: "",
        },
      },
    })
  );
  assert.match(failed, /Retry loading posts/);
  controller.dispose();
});

test("action failure uses a compact copyable toast and escapes raw error text", () => {
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
  assert.doesNotMatch(
    html.slice(html.indexOf('class="toast-viewport"')),
    /View details|<details|Check chain time/
  );
  assert.match(html, /aria-label="Copy full error"/);
  assert.match(html, /Timestamp too old &lt;script&gt;/);
  assert.ok(html.indexOf("</main>") < html.indexOf('class="toast-viewport"'));
  assert.match(html, /aria-label="Dismiss notification"/);
  assert.doesNotMatch(html, /class="action-error"|>Retry<|<script>/);
  base.dispose();
});

test("load errors stay copyable without retry or duplicate failed progress", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    actionError: {
      label: "Load Notch",
      message: "HTTP 408",
      guidance: "Try again",
    },
    progress: {
      label: "Load failed",
      completed: true,
      failed: true,
    },
  };
  const html = renderToStaticMarkup(
    createElement(App, {
      controller: { ...base, getSnapshot: () => view },
    })
  );
  assert.equal((html.match(/role="alert"/g) || []).length, 1);
  assert.doesNotMatch(html, /Retry|Retrying/);
  assert.match(html, /aria-label="Copy full error"/);
  assert.match(html, /HTTP 408/);
  assert.match(html, /id="operationProgress"[^>]*hidden/);
  assert.doesNotMatch(html, /Load failed/);
  base.dispose();
});

test("post button shows the shared loading icon only during posting", () => {
  const base = createBillboardController();
  for (const posting of [false, true]) {
    const view = {
      ...base.getSnapshot(),
      connected: true,
      busy: true,
      posting,
    };
    const html = renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
    const button = html.match(/<button id="post"[\s\S]*?<\/button>/)[0];
    assert.ok(button.includes(`aria-busy="${posting}"`));
    assert.equal(button.includes('class="loading-icon"'), posting);
    assert.equal(button.includes("Posting…"), posting);
    assert.match(button, /disabled=""/);
  }
  base.dispose();
});

test("the wallet trigger shows a loading icon while connecting", () => {
  const base = createBillboardController();
  for (const connecting of [false, true]) {
    const view = {
      ...base.getSnapshot(),
      walletOpen: true,
      busy: connecting,
      connecting,
      stake: { ...base.getSnapshot().stake, available: true },
    };
    const html = renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
    const trigger = html.match(/<button id="walletMenu"[\s\S]*?<\/button>/)[0];
    assert.ok(trigger.includes(`aria-busy="${connecting}"`));
    assert.equal(trigger.includes('class="loading-icon"'), connecting);
    assert.match(html, /Finding wallets/);
  }
  base.dispose();
});

test("post time uses English relative dates and exposes the exact timestamp", () => {
  const now = new Date(2026, 9, 29, 14, 30).getTime();
  assert.equal(formatPostTime(now / 1000, now), "Just now");
  assert.equal(formatPostTime(now / 1000 - 300, now), "5m ago");
  assert.equal(formatPostTime(now / 1000 - 7200, now), "2h ago");
  assert.equal(
    formatPostTime(new Date(2026, 9, 28, 23, 59).getTime() / 1000, now),
    "Oct 28"
  );
  assert.match(
    formatPostTime(new Date(2025, 9, 29).getTime() / 1000, now),
    /2025/
  );
  assert.equal(formatPostTime(now / 1000 + 10, now), "Just now");
  const html = renderToStaticMarkup(
    createElement(PostTime, { timestamp: now / 1000 - 300, now })
  );
  assert.ok(html.includes(new Date(now - 300_000).toISOString()));
  assert.match(html, /<time[^>]*title="[^"]+"[^>]*aria-label="[^"]+">5m ago/);
});

test("feed renders publication time only when provided by the contract", () => {
  const base = createBillboardController();
  const html = renderToStaticMarkup(
    createElement(Feed, {
      controller: base,
      view: {
        ...base.getSnapshot(),
        feedLoaded: true,
        posts: [
          { id: 1, text: "New post", publishedAt: 1793275200 },
          { id: 0, text: "Old post" },
        ],
      },
    })
  );
  assert.equal((html.match(/<time /g) || []).length, 1);
  assert.match(html, /New post/);
  assert.match(html, /Old post/);
  base.dispose();
});
