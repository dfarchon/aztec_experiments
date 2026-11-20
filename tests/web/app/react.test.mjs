import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";

import { createBillboardController } from "../../../web/src/app/controller.ts";

const compiled = await build({
  stdin: {
    contents:
      "export { PostTime, formatPostTime } from '../features/feed/PostTime.tsx'; export { App } from './App.tsx'; export { SiteLayout } from './SiteLayout.tsx'; export { Feed } from '../features/feed/Feed.tsx';",
    resolveDir: fileURLToPath(new URL("../../../web/src/app", import.meta.url)),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  define: { "import.meta.url": '"file:///notch/"' },
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
const {
  App: Board,
  SiteLayout,
  Feed,
  PostTime,
  formatPostTime,
} = module.exports;
const App = ({ controller }) =>
  createElement(
    SiteLayout,
    { controller },
    createElement(Board, { controller })
  );
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
      { id: 2, text: "<script>literal text</script>" },
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

test("the wallet stakes before private account initialization", () => {
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
  assert.match(render(), /step-indicator-label">Connect/);
  assert.match(render(), /aria-current="step"/);
  assert.match(render(), /Set up/);
  assert.match(render(), /step-indicator-label">Ready/);
  assert.match(render(), /Finding wallets/);
  assert.doesNotMatch(
    render(),
    /Aztec extension wallet|Download private account backup|<select/
  );
  view.stake = { ...view.stake, payer: `0x${"1".repeat(40)}` };
  assert.match(render(), /notch-stake-options/);
  assert.match(render(), /Keep this tab open/);
  assert.match(render(), /Setup may take 1–2 minutes or longer/);
  assert.equal(
    (render().match(/class="notch-wallet-warning"/g) || []).length,
    1
  );
  assert.doesNotMatch(render(), /Download private account backup/);
  view.stake = { ...view.stake, owner: `0x${"2".repeat(64)}` };
  assert.match(render(), /Stake &amp; set up/);
  assert.doesNotMatch(render(), /Initializing Aztec/);
  view.stake = {
    ...view.stake,
    payer: `0x${"1".repeat(40)}`,
    owner: `0x${"2".repeat(64)}`,
    aztecReady: true,
    amount: "500000000000000",
  };
  assert.match(render(), /0.0005 ETH/);
  assert.match(render(), /5 posts \/ 24h/);
  view.stake = { ...view.stake, remaining: 3 };
  assert.match(render(), /3 \/ 5 posts left/);
  assert.match(render(), /Ready to post/);
  assert.match(render(), /Export account/);
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
  assert.doesNotMatch(render(), /L1 deposit transaction hash/);
  assert.match(render(), /Check L1 status/);
  view.stake = {
    ...view.stake,
    depositNeedsHash: false,
    depositL1Confirmed: true,
  };
  assert.match(render(), /Continue setup/);
  assert.doesNotMatch(render(), /Check L1 status/);
  view.stake = {
    ...view.stake,
    depositNeedsHash: false,
    claimNeedsHash: true,
    depositL1Confirmed: true,
    aztecReady: true,
  };
  assert.doesNotMatch(render(), /Aztec claim transaction hash/);
  assert.match(render(), /Claim status is uncertain/);
  assert.doesNotMatch(render(), /Keep this tab open/);
  assert.equal(
    (render().match(/class="notch-wallet-warning"/g) || []).length,
    1
  );
  view.busy = true;
  assert.match(render(), /Keep this tab open/);
  assert.doesNotMatch(render(), /Claim status is uncertain/);
  assert.equal(
    (render().match(/class="notch-wallet-warning"/g) || []).length,
    1
  );
  assert.doesNotMatch(render(), /<h2>/);
  view.busy = false;
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
  assert.doesNotMatch(header, /Settings/);
  assert.match(header, /aria-label="About Notch"/);
  assert.match(header, /href="\/about"/);
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

test("stake choices persist before payment and import stays secondary", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    walletOpen: true,
    stake: {
      ...base.getSnapshot().stake,
      payer: `0x${"1".repeat(40)}`,
      owner: "",
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...base, getSnapshot: () => view },
      })
    );
  const html = render();
  assert.match(html, /Stake &amp; set up/);
  assert.match(html, /Already have an account\? Import it/);
  assert.match(html, /aria-pressed="true">0\.0005 ETH/);
  assert.match(html, /Stake 0\.0005 ETH/);
  assert.doesNotMatch(html, /Restore backup|Change amount|<select/);
  assert.doesNotMatch(html, />Staked</);
  assert.doesNotMatch(html, /Download backup/);
  assert.match(html, /notch-stake-options/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
  view.stake = {
    ...view.stake,
    pendingDeposit: true,
    pendingAmount: "500000000000000",
    depositPrepared: true,
  };
  const prepared = render();
  assert.match(prepared, /Stake 0\.0005 ETH/);
  assert.doesNotMatch(prepared, /To stake|L1 deposit transaction hash/);
  assert.match(prepared, /notch-stake-options/);
  assert.doesNotMatch(prepared, /Change amount|Download recovery backup/);
  view.busy = true;
  view.progress = {
    label: "Confirm the stake in your wallet…",
    completed: false,
    failed: false,
  };
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
    assert.equal(button.includes("May take 1–2 min"), posting);
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

test("background account restoration keeps its panel closable and wallet trigger active", () => {
  const controller = createBillboardController();
  const view = {
    ...controller.getSnapshot(),
    busy: true,
    restoring: true,
    walletOpen: true,
    stake: {
      ...controller.getSnapshot().stake,
      payer: "0x" + "1".repeat(40),
      amount: "500000000000000",
      setupComplete: true,
    },
    progress: { label: "Syncing account…", completed: false, failed: false },
  };
  const html = renderToStaticMarkup(
    createElement(App, {
      controller: { ...controller, getSnapshot: () => view },
    })
  );
  assert.match(html, /Restoring account/);
  assert.doesNotMatch(html, /Keep this tab open/);
  assert.doesNotMatch(html, /<button[^>]*id="walletMenu"[^>]*disabled/);
  assert.doesNotMatch(
    html,
    /<button[^>]*aria-label="Close wallet panel"[^>]*disabled/
  );
  assert.match(html, /Syncing account/);
  controller.dispose();
});

test("wallet step indicator distinguishes completed, current and future stages", () => {
  const controller = createBillboardController();
  const view = {
    ...controller.getSnapshot(),
    walletOpen: true,
    stake: { ...controller.getSnapshot().stake, payer: "0x" + "1".repeat(40) },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...controller, getSnapshot: () => view },
      })
    );
  const setup = render();
  assert.equal((setup.match(/aria-current="step"/g) || []).length, 1);
  assert.equal((setup.match(/class="is-complete"/g) || []).length, 1);
  assert.match(setup, /Completed/);
  assert.match(setup, /Not started/);
  assert.doesNotMatch(setup, /notch-wallet-steps|<h2>/);
  view.stake = { ...view.stake, amount: "500000000000000", aztecReady: true };
  assert.equal((render().match(/class="is-complete"/g) || []).length, 2);
  controller.dispose();
});

test("wallet trigger keeps its address while status changes", () => {
  const controller = createBillboardController();
  const address = "0x1234567890123456789012345678901234567890";
  const view = {
    ...controller.getSnapshot(),
    stake: {
      ...controller.getSnapshot().stake,
      payer: address,
      amount: "500000000000000",
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...controller, getSnapshot: () => view },
      })
    ).match(/<button id="walletMenu"[\s\S]*?<\/button>/)[0];
  for (const [restoring, aztecReady, status] of [
    [true, false, "Updating account"],
    [false, true, "Account ready"],
    [false, false, "Setup required"],
  ]) {
    view.restoring = restoring;
    view.busy = restoring;
    view.stake.aztecReady = aztecReady;
    const html = render();
    assert.match(html, /0x123456…567890/);
    assert.match(html, new RegExp(status));
    assert.equal(html.includes('class="loading-icon"'), restoring);
    assert.doesNotMatch(html, /Restoring account/);
    assert.match(html, new RegExp(`aria-busy="${restoring}"`));
  }
  controller.dispose();
});

test("Ready account actions group connection, stake and posting while preserving withdrawal locks", () => {
  const controller = createBillboardController();
  const view = {
    ...controller.getSnapshot(),
    walletOpen: true,
    stake: {
      ...controller.getSnapshot().stake,
      payer: "0x" + "1".repeat(40),
      amount: "1000000000000000",
      aztecReady: true,
      lastPost: String(Math.floor(Date.now() / 1000)),
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, {
        controller: { ...controller, getSnapshot: () => view },
      })
    );
  const html = render();
  assert.match(html, /notch-wallet-ready-actions/);
  assert.match(html, /Add stake/);
  assert.match(html, /Withdrawal available 24h/);
  assert.match(html, /<button[^>]*aria-label="Withdraw stake"[^>]*disabled/);
  assert.match(html, /Export account/);
  assert.match(html, /Disconnect/);
  const account = html.slice(
    html.indexOf('class="notch-wallet-account"'),
    html.indexOf('class="notch-wallet-balance is-ready"')
  );
  assert.match(account, /Disconnect/);
  const balance = html.slice(
    html.indexOf('class="notch-wallet-balance is-ready"'),
    html.indexOf('class="notch-wallet-topups"')
  );
  assert.match(balance, /Withdraw/);
  const footer = html.match(
    /<div class="notch-wallet-ready-actions">[\s\S]*?<\/div>/
  )[0];
  assert.equal((footer.match(/<button/g) || []).length, 2);
  assert.match(footer, /class="notch-wallet-secondary"[^>]*>Export account/);
  assert.match(footer, /class="notch-wallet-primary"[^>]*>Ready to post/);
  assert.doesNotMatch(footer, /Disconnect|Withdraw/);
  assert.doesNotMatch(html, /Close this panel and write below/);
  view.stake = { ...view.stake, amount: "2000000000000000", lastPost: "0" };
  assert.doesNotMatch(render(), /Add stake|Withdrawal available 24h/);
  controller.dispose();
});

test("pending wallet actions keep their accessible label while busy and connection loading still reports testnet availability", () => {
  const base = createBillboardController();
  const view = {
    ...base.getSnapshot(),
    busy: true,
    walletOpen: true,
    stake: {
      ...base.getSnapshot().stake,
      pendingExit: true,
      payer: "",
      available: false,
    },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(App, { controller: { ...base, getSnapshot: () => view } })
    );
  assert.match(render(), /aria-label="Complete the pending wallet action"/);
  assert.match(render(), /Finding wallets/);
  assert.match(render(), /Waiting for the testnet/);
  view.actionError = {
    label: "Load Notch",
    message: "Node unavailable",
    guidance: "",
  };
  assert.match(render(), /Testnet unavailable/);
  base.dispose();
});
