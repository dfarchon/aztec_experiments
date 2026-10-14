import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORIES, reportEffect } from './report-data.ts';
import type { ReadingReport, ReportOptions, ReportRow } from './types';
import './report.css';

const sections = [['overview', '结果总览'], ['switches', '开关对比'], ['samples', '样本明细'], ['design', '设计逻辑'], ['limits', '已知局限'], ['evidence', '资料与复现']];
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function Header() {
  return <header className="site-header"><div className="header-inner">
    <div className="brand"><span className="brand-mark" aria-hidden="true">◈</span><span>Dark Forest <span className="brand-sub">/ Billboard</span></span></div>
    <div className="header-spacer" /><Link className="report-link" to="/">← 返回留言板</Link>
  </div></header>;
}

export function ReportContent({ report }: { report: ReadingReport }) {
  const [options, setOptions] = useState<ReportOptions>({ keyword: false, ad: false, ai: false });
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [category, language, outcome, search, options]);
  const setting = (name: 'keyword' | 'ad' | 'ai') => (event: ChangeEvent<HTMLInputElement>) => setOptions(value => ({ ...value, [name]: event.target.checked }));
  const evaluated = report.rows.map(row => ({ ...row, effect: reportEffect(row, options) }));
  const visible = evaluated.filter(row => (category === 'all' || row.category === category) && (language === 'all' || row.language === language) &&
    `${row.id} ${row.text}`.toLowerCase().includes(search.toLowerCase()) &&
    (outcome === 'all' || (outcome === 'folded' && row.effect.folded) ||
      (outcome === 'ad-miss' && row.category === 'advertising' && !row.adFold) ||
      (outcome === 'ai-fp' && row.category === 'normal' && row.aiRisk) ||
      (outcome === 'ai-fn' && row.category === 'toxic' && !row.aiRisk)));
  const pages = Math.max(1, Math.ceil(visible.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const count = (predicate: (row: ReportRow & {effect: ReturnType<typeof reportEffect>}) => boolean) => evaluated.filter(predicate).length;
  const normal = report.summary.find(row => row.category === 'normal')!;
  const ad = report.summary.find(row => row.category === 'advertising')!;
  const toxic = report.summary.find(row => row.category === 'toxic')!;
  const policy = report.summary.find(row => row.category === 'policy')!;
  return <>
    <a className="skip-link" href="#overview">跳到正文</a><Header />
    <div className="report-layout">
      <aside className="report-sidebar"><span className="eyebrow">TEST REPORT</span>
        <nav aria-label="报告目录">{sections.map(([id, title], index) => <a key={id} href={`#${id}`}><span>0{index + 1}</span>{title}</a>)}</nav>
      </aside>
      <main className="report-content">
        <div className="report-title"><h1>测试与设计</h1>
          <div className="report-meta">规则 {report.ruleVersion} · AI 记录 {date(report.ai.recordedAt)}</div>
        </div>
        <section id="overview" className="report-section"><h2>01 / 按样本类型汇总</h2>
          <div className="report-notice">首张是总数，后三张是各类的折叠数 / 样本数；另有 {policy.total} 条边界样本见下表。数据不代表真实使用效果。</div>
          <div className="report-metrics">
            <div><strong>{report.rows.length}</strong><span>全部测试消息（中英文）</span></div>
            <div><strong>{ad.adFold}/{ad.total}</strong><span>广告样本中，被推广规则折叠</span></div>
            <div><strong>{toxic.aiRisk}/{toxic.total}</strong><span>辱骂／威胁样本中，被 AI 折叠</span></div>
            <div><strong>{normal.aiRisk}/{normal.total}</strong><span>正常聊天样本中，被 AI 误折叠</span></div>
          </div>
        </section>
        <section id="switches" className="report-section"><h2>02 / 开关对比</h2>
          <p className="report-muted">示例关键词：<code>{report.exampleKeywords.join('、')}</code>（仅用于本页）</p>
          <div className="report-table-wrap" tabIndex={0} aria-label="开关效果表，可横向滚动"><table>
            <caption>单独开启各开关时的折叠条数</caption>
            <thead><tr><th scope="col">样本类别</th><th scope="col">总数</th><th scope="col">关键词折叠</th><th scope="col">推广折叠</th><th scope="col">AI 风险折叠</th></tr></thead>
            <tbody>{report.summary.map(row => <tr key={row.category}><th scope="row">{CATEGORIES[row.category]}</th>
              <td>{row.total}</td><td>{row.keyword}</td><td>{row.adFold}</td><td>{row.aiRisk}</td></tr>)}</tbody>
          </table></div>
          <p className="report-muted">同一消息可能命中多列，不能直接相加。</p>
          <fieldset className="report-simulator"><legend>组合预览</legend>
            <div className="report-controls">
              <label><input id="previewKeyword" type="checkbox" checked={options.keyword} onChange={setting('keyword')} />关键词屏蔽</label>
              <label><input id="previewAd" type="checkbox" checked={options.ad} onChange={setting('ad')} />折叠明显推广</label>
              <label><input id="previewAi" type="checkbox" checked={options.ai} onChange={setting('ai')} />折叠 AI 风险内容</label>
            </div>
            <p id="previewResult" role="status" aria-live="polite">共折叠 <strong>{count(row => row.effect.folded)}</strong> 条 ／ 关键词 {count(row => row.effect.keywordFolded)} · 推广 {count(row => row.effect.adFolded)} · AI {count(row => row.effect.aiFolded)}</p>
            <p className="report-muted">仅预览样本，不修改留言板设置。</p>
          </fieldset>
        </section>
        <section id="samples" className="report-section"><h2>03 / 样本明细</h2>
          <div className="report-controls report-filters">
            <label>类别<select id="sampleCategory" value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部类别</option>{Object.entries(CATEGORIES).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
            <label>语言<select id="sampleLanguage" value={language} onChange={event => setLanguage(event.target.value)}><option value="all">中英文</option><option value="zh">中文</option><option value="en">英文</option></select></label>
            <label>结果<select id="sampleOutcome" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="all">全部结果</option><option value="folded">当前组合折叠</option><option value="ad-miss">推广规则未折叠的广告</option><option value="ai-fp">AI 误折叠正常内容</option><option value="ai-fn">AI 漏折叠风险内容</option></select></label>
            <label>搜索<input id="sampleSearch" type="search" value={search} placeholder="文本或样本编号" onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <p className="report-muted" id="sampleCount" role="status">找到 {visible.length} 条 · 第 {currentPage + 1} / {pages} 页</p>
          <ul className="report-samples">{visible.slice(currentPage * 12, currentPage * 12 + 12).map(row => <li key={row.id} data-sample-id={row.id}>
            <div className="sample-heading"><code>{row.id}</code><span>{CATEGORIES[row.category]} · {row.language === 'zh' ? '中文' : '英文'}</span><span className={row.effect.folded ? 'sample-folded' : ''}>{row.effect.folded ? '折叠' : '显示'}</span></div>
            {row.category === 'toxic' ? <details><summary>展开风险样本原文</summary><p className="sample-text">{row.text}</p></details> : <p className="sample-text">{row.text}</p>}
            <details className="sample-reasons"><summary>判定明细</summary><dl>
              <dt>示例关键词</dt><dd>{row.keywordHits.join('、') || '未命中'}</dd>
              <dt>推广规则</dt><dd>{row.adTier} · {row.adReasons.join('；') || '未发现推广线索'}</dd>
              <dt>历史 AI</dt><dd>{row.aiRisk ? `风险：${row.aiLabels.join('、')}` : '未命中'}</dd>
            </dl></details>
          </li>)}</ul>
          {!visible.length && <p className="report-empty">没有匹配样本，请调整筛选条件。</p>}
          <div className="report-controls"><button id="samplesPrev" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← 上一页</button><button id="samplesNext" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页 →</button></div>
        </section>
        <section id="design" className="report-section"><h2>04 / 设计逻辑</h2>
          <ol className="design-steps"><li><h3>链上发帖</h3><p>DF 入局状态决定资格；每帖最多 512 UTF-8 字节，滚动 24 小时限 10 条。测试链由 Sponsored FPC 代付。</p></li>
            <li><h3>客户端折叠</h3><p>个人关键词、明显推广、本地 AI 各有独立开关，默认关闭。命中后可展开原文，不影响链上内容或发帖额度。</p></li>
            <li><h3>判定方式</h3><p>关键词做字面匹配；推广需要组合证据；AI 经用户开启后在浏览器内运行，未分析或失败时显示原文。</p></li></ol>
        </section>
        <section id="limits" className="report-section"><h2>05 / 已知局限</h2>
          <ul><li>样本均为人工编写，不代表生产准确率；风险类别覆盖不全。</li>
            <li>关键词会误折叠引用或劝阻；规则会漏掉隐晦引流；AI 也存在误判和漏判。</li>
            <li>尚未评测跨帖广告、批量刷屏和多轮攻击。折叠不是违规认定。</li>
          </ul>
        </section>
        <section id="evidence" className="report-section"><h2>06 / 资料与复现</h2>
          <p className="report-muted">{report.datasets.map(item => `${item.name} ${item.count} 条`).join(' ＋ ')} · 重复文本对照 {report.duplicatePairs} 组</p>
          <dl className="report-provenance"><dt>AI 模型</dt><dd>{report.ai.model}</dd><dt>版本</dt><dd><code>{report.ai.revision}</code></dd><dt>风险阈值</dt><dd>{report.ai.decision}</dd><dt>记录时间</dt><dd>{date(report.ai.recordedAt)}</dd></dl>
          <a className="report-download" href="/df-test-report.json" download="df-test-report.json">↓ 下载完整报告 JSON</a>
          <details className="report-source"><summary>数据来源与 SHA-256</summary>{report.sources?.map(source => <div key={source.file}><code>{source.file}</code><code>{source.sha256}</code></div>)}</details>
          <details className="report-source"><summary>复现测试</summary><pre><code>{'node --test apps/src/df-billboard-test/*.test.mjs\nnpm run build:df:harness'}</code></pre><p>本页读取历史 AI 结果，不会重新推理；本地链测试不代表测试网验证。</p></details>
        </section>
        <footer className="report-footer">Dark Forest Billboard / 本地诊断报告 · <a href="#overview">回到顶部 ↑</a></footer>
      </main>
    </div>
  </>;
}

export function ReportPage() {
  const [report, setReport] = useState<ReadingReport | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    fetch('/df-test-report.json', { cache: 'no-store', signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error('报告读取失败，请检查本地站点是否已构建。');
      return response.json();
    }).then(data => {
      if (!data.available) throw new Error(data.error || '测试资料不可用');
      setReport(data);
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => abort.abort();
  }, [attempt]);
  if (report) return <ReportContent report={report} />;
  return <><Header /><main className="shell report-loading"><h1>测试与设计</h1>{error ? <div role="alert"><p>{error}</p><p>检查项目外 ../docs 的样本和结果文件，或设置 DF_REPORT_DOCS_DIR，再运行 npm run build:df:harness。</p><button onClick={() => setAttempt(value => value + 1)}>重新读取</button></div> : <p role="status">正在读取测试报告…</p>}</main></>;
}
