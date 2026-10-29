import { useEffect, useRef, useState } from "react";

import { POST_PAGE_SIZE as PAGE_SIZE } from "./feed-reader";
import { Icon } from "./Icon";
import { keywordMatches } from "./keywords.ts";
import { canFoldBasicRules } from "./moderation.ts";
import { PostTime } from "./PostTime";
import { Select } from "./Select";
import type { PostData, ViewProps } from "./types";

function isFiltered(post: PostData, rulesEnabled: boolean, aiEnabled: boolean) {
  return Boolean(
    post.keywordHits?.length ||
    (rulesEnabled && canFoldBasicRules(post)) ||
    (aiEnabled && post.aiAnalyzed && post.aiLabels?.length)
  );
}

export function pageNumbers(current: number, total: number) {
  const numbers = new Set([1, total, current - 1, current, current + 1]);
  return [...numbers]
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);
}

export function Feed({ view, controller }: ViewProps) {
  const [filteredView, setFilteredView] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState("newest");
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(Date.now);
  const hasTimestamps = view.posts.some((post) => post.publishedAt != null);
  useEffect(() => {
    if (!hasTimestamps) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hasTimestamps]);
  const root = useRef<HTMLElement>(null);
  const posts = view.posts.map((post) => ({
    ...post,
    keywordHits:
      view.keywordEnabled && !post.decodeError
        ? keywordMatches(post.text, view.keywords, view.keywordMode)
        : [],
  }));
  const filteredCount = posts.filter((post) =>
    isFiltered(post, view.rulesEnabled, view.aiHints)
  ).length;
  const matching = posts
    .filter(
      (post) =>
        isFiltered(post, view.rulesEnabled, view.aiHints) === filteredView &&
        `${post.id} ${post.text || ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
    )
    .sort((a, b) =>
      order === "newest"
        ? Number(b.id) - Number(a.id)
        : Number(a.id) - Number(b.id)
    );
  const totalPages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const offset = (current - 1) * PAGE_SIZE;
  const numbers = pageNumbers(current, totalPages);

  function resetPage() {
    setPage(1);
  }
  function navigate(next: number) {
    setPage(next);
    root.current?.querySelector(".feed-scroll")?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    resetPage();
    setFilteredView(false);
  }, [
    view.keywordEnabled,
    view.keywords,
    view.keywordMode,
    view.rulesEnabled,
    view.aiHints,
    view.feedRevision,
  ]);

  return (
    <section className="card feed-card" ref={root}>
      <div className="feed-heading">
        <div className="card-head">
          <h1>
            {filteredView ? "Filtered posts" : "Public board"}
            <span className="count-badge">
              {view.feedLoaded || posts.length > 0
                ? filteredView
                  ? filteredCount
                  : posts.length - filteredCount
                : "—"}
            </span>
          </h1>
          <div className="feed-toolbar">
            {(filteredCount > 0 || filteredView) && (
              <button
                id="showFiltered"
                type="button"
                aria-pressed={filteredView}
                onClick={() => {
                  setFilteredView((value) => !value);
                  resetPage();
                }}
              >
                {filteredView ? "← All posts" : `Filtered (${filteredCount})`}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Search and sort posts"
              title="Search and sort posts"
              aria-expanded={searchOpen}
              aria-controls="feedSearch"
              onClick={() => {
                setSearchOpen((value) => !value);
                if (searchOpen) {
                  setQuery("");
                  setOrder("newest");
                  resetPage();
                }
              }}
            >
              <Icon name="search" />
            </button>
            <button
              id="refresh"
              type="button"
              className="icon-button"
              aria-label="Refresh posts"
              title="Refresh posts"
              disabled={view.busy || view.feedLoading || !view.canRead}
              onClick={controller.refresh}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </div>
        <div id="feedSearch" className="feed-search" hidden={!searchOpen}>
          <label className="search-field">
            <Icon name="search" />
            <span className="sr-only">Search loaded posts</span>
            <input
              type="search"
              value={query}
              placeholder="Search loaded posts…"
              onChange={(event) => {
                setQuery(event.target.value);
                resetPage();
              }}
            />
          </label>
          <Select
            aria-label="Sort posts"
            value={order}
            onChange={(value) => {
              setOrder(value);
              resetPage();
            }}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
        </div>
      </div>
      <div
        className="feed-scroll"
        tabIndex={0}
        role="region"
        aria-label="Posts"
        aria-busy={view.feedLoading}
      >
        <div
          id="filterStatus"
          className="sr-only"
          role="status"
          aria-live="polite"
        >
          {view.feedLoading
            ? `Loading posts… ${posts.length} / ${view.totalPosts} loaded`
            : view.feedLoaded
              ? `${posts.length} loaded posts · ${filteredCount} filtered · Page ${current} of ${totalPages}`
              : "Waiting to load public posts"}
        </div>
        {view.feedLoaded && matching.length === 0 && (
          <div className="empty-state">
            <h2>
              {query
                ? "No matching posts"
                : filteredView
                  ? "No filtered posts"
                  : posts.length
                    ? "No visible posts"
                    : "No posts yet"}
            </h2>
            {query && (
              <button
                onClick={() => {
                  setQuery("");
                  resetPage();
                }}
              >
                Clear search
              </button>
            )}
          </div>
        )}
        {!view.feedLoaded && posts.length === 0 && (
          <div className="empty-state" role="status">
            <p>
              {view.canRead ? "Loading posts…" : "Connecting to the board…"}
            </p>
          </div>
        )}
        <ol
          id="feed"
          aria-label={filteredView ? "Filtered posts" : "Public posts"}
          start={offset + 1}
        >
          {matching.slice(offset, offset + PAGE_SIZE).map((post) => (
            <li className="post-row" key={post.id}>
              <article data-post-id={post.id}>
                <div className="post-meta">
                  <span className="post-number">#{post.id}</span>
                  {post.publishedAt != null && (
                    <PostTime timestamp={post.publishedAt} now={now} />
                  )}
                </div>
                <div className="post-text">
                  {post.decodeError
                    ? "This onchain message could not be decoded as UTF-8."
                    : post.text}
                </div>
              </article>
            </li>
          ))}
        </ol>
      </div>
      {(view.feedLoaded || posts.length > 0) &&
        (matching.length > 0 || view.hasOlderPosts) && (
          <div className="feed-footer">
            <span className="page-range">
              {posts.length} / {view.totalPosts} loaded
              {view.feedLoading && " · Loading…"}
              {matching.length > 0 &&
                ` · ${offset + 1}–${Math.min(offset + PAGE_SIZE, matching.length)} shown`}
            </span>
            {view.hasOlderPosts && current === totalPages && (
              <button
                disabled={view.busy || view.feedLoading}
                onClick={() => void controller.loadOlder()}
              >
                Load older posts
              </button>
            )}
            <nav className="feed-pagination" aria-label="Post pagination">
              <button
                disabled={current === 1}
                onClick={() => navigate(current - 1)}
                aria-label="Previous page"
              >
                ←
              </button>
              {numbers.map((number, index) => (
                <span className="page-slot" key={number}>
                  {index > 0 && number - numbers[index - 1] > 1 && (
                    <span className="page-gap">…</span>
                  )}
                  <button
                    aria-label={`Page ${number}`}
                    aria-current={number === current ? "page" : undefined}
                    onClick={() => navigate(number)}
                  >
                    {number}
                  </button>
                </span>
              ))}
              <button
                disabled={current === totalPages}
                onClick={() => navigate(current + 1)}
                aria-label="Next page"
              >
                →
              </button>
            </nav>
          </div>
        )}
    </section>
  );
}
