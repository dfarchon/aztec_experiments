import { useEffect, useState } from 'react';
import { canFoldPromotion, groupDuplicatePosts } from './moderation.ts';
import { keywordMatches } from './keywords.ts';
import { ReadingSettings } from './ReadingSettings';
import type { BillboardView, PostData, ViewProps } from './types';

function shouldFold(post: PostData, adEnabled: boolean, aiEnabled: boolean) {
  return Boolean(post.keywordHits?.length || (adEnabled && canFoldPromotion(post)) ||
    (aiEnabled && post.aiAnalyzed && post.aiLabels?.length));
}

function Post({ post, adEnabled, expanded, aiEnabled }: { post: PostData; adEnabled: boolean; expanded: boolean; aiEnabled: boolean }) {
  const folded = shouldFold(post, adEnabled, aiEnabled);
  const [open, setOpen] = useState(expanded);
  useEffect(() => setOpen(expanded), [expanded, folded]);
  return <article data-post-id={post.id} className={folded ? 'is-folded' : ''}>
    <div className="post-meta"><span>消息 #{post.id}</span></div>
    {post.decodeError ? <div>这条链上消息无法解码为 UTF-8，已跳过内容展示。</div>
      : folded ? <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>已折叠 · 查看原文</summary><p>{post.text}</p>
      </details> : <div className="post-text">{post.text}</div>}
  </article>;
}

function PostGroup({ posts, view, showFolded }: { posts: PostData[]; view: BillboardView; showFolded: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (showFolded) setOpen(true); }, [showFolded]);
  const props = { adEnabled: view.adEnabled, expanded: showFolded, aiEnabled: view.aiHints };
  return <li className="post-group">
    <Post post={posts[0]} {...props} />
    {posts.length > 1 && <details className="duplicates" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>另有 {posts.length - 1} 条相同消息 · 展开原文</summary>
      <ul>{posts.slice(1).map(post => <li key={post.id}><Post post={post} {...props} /></li>)}</ul>
    </details>}
  </li>;
}

export function Feed({ view, controller }: ViewProps) {
  const [showFolded, setShowFolded] = useState(false);
  const posts = view.posts.map(post => ({ ...post, keywordHits: view.keywordEnabled && !post.decodeError
    ? keywordMatches(post.text, view.keywords, view.keywordMode) : [] }));
  const groups = groupDuplicatePosts(posts, view.mergeDuplicates);
  const folded = posts.filter(post => shouldFold(post, view.adEnabled, view.aiHints)).length;
  useEffect(() => setShowFolded(false), [view.keywordEnabled, view.keywords, view.keywordMode, view.adEnabled, view.aiHints]);
  return <section className="card feed-card">
    <div className="card-head"><h2>公开消息</h2>
      <button id="refresh" type="button" disabled={view.busy || !view.connected} onClick={controller.refresh}>刷新消息</button></div>
    <ReadingSettings view={view} controller={controller} />
    <div className="feed-controls" aria-label="本地内容过滤设置">
      <label><input id="mergeDuplicates" type="checkbox" disabled={view.busy} checked={view.mergeDuplicates}
        onChange={event => controller.setField('mergeDuplicates', event.target.checked)} />合并重复消息</label>
      <button id="showFolded" type="button" disabled={view.busy || !folded} onClick={() => setShowFolded(value => !value)}>
        {showFolded && folded ? '收起已折叠内容' : `查看已折叠内容 (${folded})`}</button>
    </div>
    <div id="filterStatus" role="status" aria-live="polite">{view.feedLoaded
      ? `${view.posts.length} 条消息 · ${folded} 条折叠` : '等待读取公开消息'}</div>
    <ol id="feed">{groups.map(posts => <PostGroup key={posts[0].id} posts={posts} view={view} showFolded={showFolded} />)}</ol>
  </section>;
}
