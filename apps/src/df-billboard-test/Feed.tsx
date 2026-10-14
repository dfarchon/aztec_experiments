import { useEffect, useState } from 'react';
import { AD_TIER_LABELS, canFoldPromotion, groupDuplicatePosts, isPromotion } from './moderation.mjs';
import { keywordMatches } from './keywords.mjs';
import { ReadingSettings } from './ReadingSettings';
import { Hint } from './Hint';
import type { AdMode, BillboardView, PostData, ViewProps } from './types';

const toxicityNames: Record<string, string> = {
  toxicity: '不友善内容', severe_toxicity: '严重不友善内容', identity_attack: '身份攻击',
  insult: '辱骂', threat: '威胁', obscene: '粗俗用语', sexual_explicit: '露骨内容',
  unsafe: '潜在风险', hate: '仇恨', harassment: '骚扰／辱骂', violence: '暴力／威胁', weapons: '武器风险',
  sexual: '性内容', sexual_minors: '未成年人性内容风险', self_harm: '自伤风险', criminal_planning: '犯罪活动风险',
  drugs: '毒品风险', privacy: '隐私风险', profanity: '粗俗用语', fraud_manipulation: '欺诈／操纵风险',
  misinformation: '错误信息风险', unauthorized_advice: '高风险建议', other: '其他风险',
};

function Post({ post, adMode, expanded, aiEnabled, duplicateHints }: { post: PostData; adMode: AdMode | 'show'; expanded: boolean; aiEnabled: boolean; duplicateHints: boolean }) {
  const keywordFolded = Boolean(post.keywordHits?.length);
  const adFolded = adMode === 'fold' && canFoldPromotion(post);
  const folded = keywordFolded || adFolded;
  const [open, setOpen] = useState(expanded);
  useEffect(() => setOpen(expanded), [expanded, folded]);
  return <article data-post-id={post.id} className={folded ? 'is-folded' : ''}>
    <div className="post-meta"><span>消息 #{post.id}</span>
    {aiEnabled && !post.decodeError && <Hint label="AI 分析详情" symbol={post.aiLabels?.length ? '⚠' : post.aiAnalyzed ? '◇' : '◷'}
      tone={post.aiLabels?.length ? 'warning' : ''} data-ai-id={post.id}>
      {post.aiLabels?.length ? `实验性 AI 提示：${post.aiLabels.map(label => toxicityNames[label] || label).join('、')}`
        : post.aiAnalyzed ? 'AI 未提示风险 · 不代表安全' : 'AI 尚未检测'}
    </Hint>}
    {post.adTier && AD_TIER_LABELS[post.adTier] && adMode !== 'show' && <Hint label="推广规则详情" symbol="⚑" tone="warning" data-tier={post.adTier}>
      {AD_TIER_LABELS[post.adTier]} · {post.adReasons?.join('；')}（可能误判）
    </Hint>}
    {duplicateHints && post.similarTo != null && <Hint label="相似消息详情" symbol="≈">
      与消息 #{post.similarTo} 字符形式相近，可能重复；未合并，请自行判断。
    </Hint>}
    {keywordFolded && <Hint label="关键词命中详情" symbol="⊘" tone="warning">命中你的屏蔽词：{post.keywordHits?.join('、')}</Hint>}
    </div>
    {post.decodeError ? <div>这条链上消息无法解码为 UTF-8，已跳过内容展示。</div>
      : folded ? <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>已折叠 · 查看原文</summary><p>{post.text}</p>
      </details> : <div className="post-text">{post.text}</div>}
  </article>;
}

function PostGroup({ posts, view, showFolded }: { posts: PostData[]; view: BillboardView; showFolded: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (showFolded) setOpen(true); }, [showFolded]);
  const props = { adMode: view.adEnabled === false ? 'show' as const : view.adMode, expanded: showFolded, aiEnabled: view.aiHints, duplicateHints: view.mergeDuplicates };
  return <li className="post-group">
    <Post post={posts[0]} {...props} />
    {posts.length > 1 && <details className="duplicates" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>另有 {posts.length - 1} 条相同消息 · 展开原文</summary>
      <Hint label="重复合并说明">仅忽略首尾空白、连续空格和换行格式差异；保留大小写与字符形式。保留每条原文与编号，不代表广告判定。</Hint>
      <ul>{posts.slice(1).map(post => <li key={post.id}><Post post={post} {...props} /></li>)}</ul>
    </details>}
  </li>;
}

export function Feed({ view, controller }: ViewProps) {
  const [showFolded, setShowFolded] = useState(false);
  const posts = view.posts.map(post => ({ ...post, keywordHits: view.keywordEnabled && !post.decodeError
    ? keywordMatches(post.text, view.keywords, view.keywordMode) : [] }));
  const groups = groupDuplicatePosts(posts, view.mergeDuplicates);
  const suspected = view.adEnabled === false ? 0 : posts.filter(isPromotion).length;
  const uncertain = view.adEnabled === false ? 0 : posts.filter(post => post.adTier === 'context' || post.adTier === 'policy').length;
  const keywordCount = posts.filter(post => post.keywordHits.length).length;
  const folded = posts.filter(post => post.keywordHits.length || (view.adEnabled !== false && view.adMode === 'fold' && canFoldPromotion(post))).length;
  useEffect(() => setShowFolded(false), [view.keywordEnabled, view.keywords, view.keywordMode, view.adEnabled, view.adMode]);
  return <section className="card feed-card">
    <div className="card-head"><h2>公开消息 <Hint label="阅读设置说明">仅影响本页展示，原文仍在链上；不扣额度、不封禁。AI 不会单独隐藏帖子，也不是违法判定。</Hint></h2>
      <button id="refresh" type="button" disabled={view.busy || !view.connected} onClick={controller.refresh}>刷新消息</button></div>
    <ReadingSettings view={view} controller={controller} />
    <div className="feed-controls" aria-label="本地内容过滤设置">
      <label><input id="mergeDuplicates" type="checkbox" disabled={view.busy} checked={view.mergeDuplicates}
        onChange={event => controller.setField('mergeDuplicates', event.target.checked)} />合并重复消息</label>
      <button id="showFolded" type="button" disabled={view.busy || !folded} onClick={() => setShowFolded(value => !value)}>
        {showFolded && folded ? '收起已折叠内容' : `查看已折叠内容 (${folded})`}</button>
    </div>
    <div id="filterStatus" role="status" aria-live="polite">{view.feedLoaded
      ? <>{view.posts.length} 条消息 · {folded} 条折叠 <Hint label="过滤统计详情">{`合并 ${view.posts.length - groups.length} 条重复消息；关键词命中 ${keywordCount} 条；推广线索 ${suspected} 条，语境／政策待定 ${uncertain} 条；按设置折叠 ${folded} 条。`}</Hint></> : '等待读取公开消息'}</div>
    <ol id="feed">{groups.map(posts => <PostGroup key={posts[0].id} posts={posts} view={view} showFolded={showFolded} />)}</ol>
  </section>;
}
