import { useEffect, useRef, useState } from "react";

import { POST_PAGE_SIZE as PAGE_SIZE } from "./feed-reader";
import { Icon } from "./Icon";
import { PostTime } from "./PostTime";
import type { ViewProps } from "./types";

export function pageNumbers(current: number, total: number) {
  const numbers = new Set([1, total, current - 1, current, current + 1]);
  return [...numbers]
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);
}

export function Feed({ view, controller }: ViewProps) {
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
  const posts = view.posts;
  const sorted = [...posts].sort((a, b) => Number(b.id) - Number(a.id));
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
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
  }, [view.feedRevision]);

  return (
    <section className="card feed-card" ref={root}>
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
      <div
        className="feed-scroll"
        tabIndex={0}
        role="region"
        aria-label="Posts"
        aria-busy={view.feedLoading}
      >
        <div
          id="feedStatus"
          className="sr-only"
          role="status"
          aria-live="polite"
        >
          {view.feedLoading
            ? `Loading posts… ${posts.length} / ${view.totalPosts} loaded`
            : view.feedLoaded
              ? `${posts.length} loaded posts · Page ${current} of ${totalPages}`
              : "Waiting to load public posts"}
        </div>
        {view.feedLoaded && sorted.length === 0 && (
          <div className="empty-state">
            <h2>No posts yet</h2>
          </div>
        )}
        {!view.feedLoaded && posts.length === 0 && (
          <div className="empty-state" role="status">
            <p>
              {view.canRead ? "Loading posts…" : "Connecting to the board…"}
            </p>
          </div>
        )}
        <ol id="feed" aria-label="Public posts" start={offset + 1}>
          {sorted.slice(offset, offset + PAGE_SIZE).map((post) => (
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
        (sorted.length > 0 || view.hasOlderPosts) && (
          <div className="feed-footer">
            <span className="page-range">
              {posts.length} / {view.totalPosts} loaded
              {view.feedLoading && " · Loading…"}
              {sorted.length > 0 &&
                ` · ${offset + 1}–${Math.min(offset + PAGE_SIZE, sorted.length)} shown`}
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
