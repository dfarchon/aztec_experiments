import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import { PostTime } from "./PostTime";
import type { ViewProps } from "./types";

function FeedSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="feed-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="feed-skeleton-row" key={index}>
          <span className="feed-skeleton-meta" />
          <span className="feed-skeleton-line" />
          <span className="feed-skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export function Feed({ view, controller }: ViewProps) {
  const [now, setNow] = useState(Date.now);
  const hasTimestamps = view.posts.some((post) => post.publishedAt != null);
  useEffect(() => {
    if (!hasTimestamps) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hasTimestamps]);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const lastRequested = useRef("");
  const posts = view.posts;
  const sorted = [...posts].sort((a, b) => Number(b.id) - Number(a.id));
  const refreshing =
    view.feedLoaded &&
    view.feedLoading &&
    view.progress?.label === "Loading recent posts…";
  const empty = view.feedLoaded && sorted.length === 0 && !view.feedLoading;
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [view.feedRevision]);
  useEffect(() => {
    if (refreshing) scroller.current?.scrollTo({ top: 0 });
  }, [refreshing]);
  useEffect(() => {
    if (
      !view.feedLoaded ||
      !view.hasOlderPosts ||
      view.feedLoading ||
      view.busy ||
      !scroller.current ||
      !sentinel.current
    )
      return;
    const key = `${view.feedRevision}:${posts.length}`;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || lastRequested.current === key) return;
        lastRequested.current = key;
        void controller.loadOlder();
      },
      { root: scroller.current, rootMargin: "0px 0px 96px 0px" }
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [
    controller,
    posts.length,
    view.busy,
    view.feedLoaded,
    view.feedLoading,
    view.feedRevision,
    view.hasOlderPosts,
  ]);

  return (
    <section className={`card feed-card${empty ? " is-empty" : ""}`}>
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
        ref={scroller}
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
          {refreshing
            ? "Refreshing posts…"
            : view.feedLoading
              ? `Loading posts… ${posts.length} / ${view.totalPosts} loaded`
              : view.feedLoaded
                ? `${posts.length} of ${view.totalPosts} posts loaded`
                : "Waiting to load public posts"}
        </div>
        {empty && (
          <div className="empty-state">
            <h2>No post yet</h2>
          </div>
        )}
        {!refreshing && (
          <ol id="feed" aria-label="Public posts">
            {sorted.map((post) => (
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
        )}
        {((!view.feedLoaded && !view.actionError) ||
          refreshing ||
          (view.feedLoading && posts.length === 0)) && <FeedSkeleton />}
        {view.hasOlderPosts && (
          <div className="feed-sentinel" ref={sentinel}>
            {view.feedLoading &&
              view.feedLoaded &&
              view.progress?.label === "Loading older posts…" && (
                <FeedSkeleton rows={1} />
              )}
            {view.actionError?.label === "Load older posts" &&
              !view.feedLoading && (
                <button
                  type="button"
                  disabled={view.busy}
                  onClick={() => void controller.loadOlder()}
                >
                  Retry loading posts
                </button>
              )}
          </div>
        )}
      </div>
    </section>
  );
}
