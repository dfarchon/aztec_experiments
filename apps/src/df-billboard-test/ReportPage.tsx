import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORIES, reportEffect } from './report-data.ts';
import { RULE_CATEGORY_LABELS } from './moderation.ts';
import type { ReadingReport, ReportOptions, ReportRow } from './types';
import './report.css';

const sections = [['overview', '功能概览'], ['flow', '完整链路'], ['contract', '合约设计'], ['reading', '阅读过滤'], ['results', '测试结果'], ['samples', '样本明细'], ['limits', '边界与待确认'], ['evidence', '资料与复现']];
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function Header() {
  return <header className="site-header"><div className="header-inner">
    <div className="brand"><span className="brand-mark" aria-hidden="true">◈</span><span>Dark Forest <span className="brand-sub">/ Billboard</span></span></div>
    <div className="header-spacer" /><Link className="report-link" to="/">← 返回留言板</Link>
  </div></header>;
}

export function ReportContent({ report, error = '', retry }: { report?: ReadingReport | null; error?: string; retry?: () => void }) {
  const [options, setOptions] = useState<ReportOptions>({ keyword: false, rules: false, ai: false });
  const [category, setCategory] = useState('all');
  const [language, setLanguage] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [category, language, outcome, search, options]);
  const setting = (name: 'keyword' | 'rules' | 'ai') => (event: ChangeEvent<HTMLInputElement>) => setOptions(value => ({ ...value, [name]: event.target.checked }));
  const evaluated = (report?.rows ?? []).map(row => ({ ...row, effect: reportEffect(row, options) }));
  const visible = evaluated.filter(row => (category === 'all' || row.category === category) && (language === 'all' || row.language === language) &&
    `${row.id} ${row.text}`.toLowerCase().includes(search.toLowerCase()) &&
    (outcome === 'all' || (outcome === 'folded' && row.effect.folded) ||
      (outcome === 'ad-miss' && row.category === 'advertising' && !row.ruleFold) ||
      (outcome === 'ai-fp' && row.category === 'normal' && row.aiRisk) ||
      (outcome === 'ai-fn' && row.category === 'toxic' && !row.aiRisk)));
  const pages = Math.max(1, Math.ceil(visible.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const count = (predicate: (row: ReportRow & {effect: ReturnType<typeof reportEffect>}) => boolean) => evaluated.filter(predicate).length;
  const normal = report?.summary.find(row => row.category === 'normal');
  const ad = report?.summary.find(row => row.category === 'advertising');
  const policy = report?.summary.find(row => row.category === 'policy');
  const adsByLanguage = (value: 'zh' | 'en') => (report?.rows ?? []).filter(row => row.category === 'advertising' && row.language === value);
  const chineseAds = adsByLanguage('zh');
  const englishAds = adsByLanguage('en');
  return <>
    <a className="skip-link" href="#overview">跳到正文</a><Header />
    <div className="report-layout">
      <aside className="report-sidebar"><span className="eyebrow">BILLBOARD DESIGN</span>
        <nav aria-label="报告目录">{sections.map(([id, title], index) => <a key={id} href={`#${id}`}><span>0{index + 1}</span>{title}</a>)}</nav>
      </aside>
      <main className="report-content">
        <div className="report-title"><h1>留言板 · 设计与测试</h1>
          <p>独立于 DF 游戏合约的公开频道：入局玩家匿名发帖，所有人可读，客户端自行决定折叠哪些内容。</p>
          <div className="report-meta">基于 DFBillboard 合约与本地测试客户端</div>
        </div>
        <section id="overview" className="report-section"><h2>01 / 功能概览</h2>
          <div className="report-notice">当前实现：DF 入局状态决定发帖资格；首帖自动核验，无须领取凭证。消息正文公开上链。阅读过滤仅在本地折叠，不审核、删除或处罚链上帖子。</div>
          <div className="report-table-wrap report-design-table"><table><caption>各层负责什么</caption><thead><tr><th scope="col">层</th><th scope="col">职责</th><th scope="col">公开结果</th></tr></thead><tbody>
            <tr><th scope="row">DF Core / PlayerStorage</th><td>完成入局，保存玩家状态根</td><td>入局状态根</td></tr>
            <tr><th scope="row">DFBillboard 私有调用</th><td>验证资格，记录每个账号的发帖时间</td><td>不直接写发帖地址</td></tr>
            <tr><th scope="row">DFBillboard 公有状态</th><td>按帖子 ID 存正文和长度</td><td>所有人可读的原文</td></tr>
            <tr><th scope="row">客户端</th><td>读取、解码与本地折叠</td><td>只改变当前用户看到的列表</td></tr>
          </tbody></table></div>
        </section>
        <section id="flow" className="report-section"><h2>02 / 完整链路</h2>
          <ol className="design-steps">
            <li><h3>DF 入局</h3><p>玩家通过 <code>Core.initialize_player</code> 入局；客户端保存链上 <code>PlayerUpdate</code> 状态，供首帖证明使用。</p></li>
            <li><h3>私有发帖</h3><p><code>post</code> 从调用者取得账号，在 Aztec 锚定区块读取绑定的 <code>PlayerStorage</code> 状态根。首帖核验真实入局；之后沿用私有发帖历史，无手动领取步骤。</p></li>
            <li><h3>合约公开正文</h3><p>资格、额度和字节校验通过后，私有调用排队执行仅合约自身可调用的 <code>_publish</code>。它分配帖子 ID，并公开写入正文与长度。</p></li>
            <li><h3>任何人阅读</h3><p>客户端调用 <code>get_post_count</code> 与 <code>get_post(id)</code>，解码原文后再按个人设置折叠。发帖和阅读不依赖审核服务。</p></li>
          </ol>
        </section>
        <section id="contract" className="report-section"><h2>03 / 合约设计</h2>
          <div className="report-table-wrap report-design-table"><table><caption>已实现的约束</caption><thead><tr><th scope="col">项目</th><th scope="col">当前行为</th></tr></thead><tbody>
            <tr><th scope="row">赛季绑定</th><td>部署时固定一个非零 PlayerStorage 地址；合约没有自动赛季切换或管理员改址入口。每季需明确对应 DF 部署与留言板。</td></tr>
            <tr><th scope="row">入局资格</th><td>每次检查玩家状态根非零；首帖还核对传入 Player 状态哈希及入局时间，并用一次性 nullifier 防止丢弃历史后重置额度。</td></tr>
            <tr><th scope="row">发帖额度</th><td>同一 Aztec 账号在任意滚动 86,400 秒内最多 10 条；时间取 Aztec 锚定区块，不取浏览器时钟。</td></tr>
            <tr><th scope="row">正文格式</th><td>客户端要求 1–512 字节有效 UTF-8；合约检查长度与固定 512 字节输入的补零，打包为 17 个 Field。直接调用合约时，UTF-8 有效性仍依赖客户端。</td></tr>
            <tr><th scope="row">隐私边界</th><td>公开帖子不存发帖地址；资格和额度在私有调用中处理。这不等于保证交易网络元数据或跨行为完全不可关联。</td></tr>
            <tr><th scope="row">费用</th><td>本地测试客户端使用 Sponsored FPC 为入局、发帖代付；生产环境的 FPC 地址、充值与预算仍需单独确定。</td></tr>
          </tbody></table></div>
        </section>
        <section id="reading" className="report-section"><h2>04 / 阅读过滤</h2>
          <p>关键词、基础规则和可选本地 AI 是三个独立开关。任一开启的规则命中，就在该客户端折叠帖子；用户仍可展开原文。默认不强制过滤，不扣发帖额度。</p>
          <p className="report-muted">基础规则识别推广、辱骂、成人招揽等线索；它与 AI 都可能误判或漏判。下方样本仅验证显示逻辑，不代表链上审核。</p>
        </section>
        <section id="results" className="report-section"><h2>05 / 测试结果</h2>
          <h3>合约验证覆盖</h3>
          <p className="report-muted">Noir 测试覆盖：未入局与伪造状态拒绝、首帖自动获得资格、10/11 条滚动限额、到期后释放名额、正文长度与补零、禁止外部直接调用 <code>_publish</code>、不同玩家额度独立。本地 E2E 另有真实 <code>Core.initialize_player</code> 路径；下方数字只统计阅读过滤样本，不是合约通过率。</p>
          <h3>阅读过滤样本</h3>
          {!report ? <div className="report-notice" role={error ? 'alert' : 'status'}>{error || '正在读取样本测试报告…'}{retry && <button className="report-retry" onClick={retry}>重新读取</button>}</div> : <>
          <p className="report-muted">共 {report.rows.length} 条人工编写中英文样本。数字为折叠数 / 该类样本数；AI 列使用 {date(report.ai.recordedAt)} 的历史记录。</p>
          <div className="report-metrics">
            <div><strong>{ad?.ruleFold}/{ad?.total}</strong><span>全部广告 · 基础规则折叠</span></div>
            <div><strong>{chineseAds.filter(row => row.ruleFold).length}/{chineseAds.length}</strong><span>中文广告 · 基础规则折叠</span></div>
            <div><strong>{englishAds.filter(row => row.ruleFold).length}/{englishAds.length}</strong><span>英文广告 · 基础规则折叠</span></div>
            <div><strong>{(normal?.ruleFold ?? 0) + (policy?.ruleFold ?? 0)}/{(normal?.total ?? 0) + (policy?.total ?? 0)}</strong><span>正常聊天＋边界 · 误折叠</span></div>
          </div>
          <h3>开关对比</h3>
          <p className="report-muted">示例关键词：<code>{report.exampleKeywords.join('、')}</code>（仅用于本页）</p>
          <div className="report-table-wrap" tabIndex={0} aria-label="开关效果表，可横向滚动"><table>
            <caption>单独开启各开关时的折叠条数</caption>
            <thead><tr><th scope="col">样本类别</th><th scope="col">总数</th><th scope="col">关键词折叠</th><th scope="col">基础规则折叠</th><th scope="col">AI 风险折叠</th></tr></thead>
            <tbody>{report.summary.map(row => <tr key={row.category}><th scope="row">{CATEGORIES[row.category]}</th>
              <td>{row.total}</td><td>{row.keyword}</td><td>{row.ruleFold}</td><td>{row.aiRisk}</td></tr>)}</tbody>
          </table></div>
          <p className="report-muted">同一消息可能命中多列，不能直接相加。</p>
          <fieldset className="report-simulator"><legend>组合预览</legend>
            <div className="report-controls">
              <label><input id="previewKeyword" type="checkbox" checked={options.keyword} onChange={setting('keyword')} />关键词屏蔽</label>
              <label><input id="previewRules" type="checkbox" checked={options.rules} onChange={setting('rules')} />基础规则过滤</label>
              <label><input id="previewAi" type="checkbox" checked={options.ai} onChange={setting('ai')} />折叠 AI 风险内容</label>
            </div>
            <p id="previewResult" role="status" aria-live="polite">共折叠 <strong>{count(row => row.effect.folded)}</strong> 条 ／ 关键词 {count(row => row.effect.keywordFolded)} · 基础规则 {count(row => row.effect.ruleFolded)} · AI {count(row => row.effect.aiFolded)}</p>
            <p className="report-muted">仅预览样本，不修改留言板设置。</p>
          </fieldset></>}
        </section>
        <section id="samples" className="report-section"><h2>06 / 样本明细</h2>
          {!report ? <p className="report-muted">样本报告尚未载入。</p> : <>
          <div className="report-controls report-filters">
            <label>类别<select id="sampleCategory" value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部类别</option>{Object.entries(CATEGORIES).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
            <label>语言<select id="sampleLanguage" value={language} onChange={event => setLanguage(event.target.value)}><option value="all">中英文</option><option value="zh">中文</option><option value="en">英文</option></select></label>
            <label>结果<select id="sampleOutcome" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="all">全部结果</option><option value="folded">当前组合折叠</option><option value="ad-miss">基础规则未折叠的广告</option><option value="ai-fp">AI 误折叠正常内容</option><option value="ai-fn">AI 漏折叠风险内容</option></select></label>
            <label>搜索<input id="sampleSearch" type="search" value={search} placeholder="文本或样本编号" onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <p className="report-muted" id="sampleCount" role="status">找到 {visible.length} 条 · 第 {currentPage + 1} / {pages} 页</p>
          <ul className="report-samples">{visible.slice(currentPage * 12, currentPage * 12 + 12).map(row => <li key={row.id} data-sample-id={row.id}>
            <div className="sample-heading"><code>{row.id}</code><span>{CATEGORIES[row.category]} · {row.language === 'zh' ? '中文' : '英文'}</span><span className={row.effect.folded ? 'sample-folded' : ''}>{row.effect.folded ? '折叠' : '显示'}</span></div>
            {row.category === 'toxic' ? <details><summary>展开风险样本原文</summary><p className="sample-text">{row.text}</p></details> : <p className="sample-text">{row.text}</p>}
            <details className="sample-reasons"><summary>判定明细</summary><dl>
              <dt>示例关键词</dt><dd>{row.keywordHits.join('、') || '未命中'}</dd>
              <dt>基础规则</dt><dd>{row.ruleMatches.map(rule => RULE_CATEGORY_LABELS[rule]).join('、') || '未命中'}{row.adTier !== 'none' ? ` · 推广线索 ${row.adTier}` : ''}</dd>
              <dt>历史 AI</dt><dd>{row.aiRisk ? `风险：${row.aiLabels.join('、')}` : '未命中'}</dd>
            </dl></details>
          </li>)}</ul>
          {!visible.length && <p className="report-empty">没有匹配样本，请调整筛选条件。</p>}
          <div className="report-controls"><button id="samplesPrev" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← 上一页</button><button id="samplesNext" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页 →</button></div></>}
        </section>
        <section id="limits" className="report-section"><h2>07 / 边界与待确认</h2>
          <ul><li>合约将 DF <code>PlayerStorage</code> 的玩家状态根槽位固定为当前版本布局；DF 升级后需核对槽位或部署适配版本。每季的 DF 地址与留言板地址也需明确配对。</li>
            <li>本地测试的 Sponsored FPC 不代表生产资助已落实；上链原文不可由前端过滤删除，也需要评估公有存储费用和长期读取方式。</li>
            {report && <li>样本均为人工编写，不代表生产准确率；仍有 {ad!.total - ad!.ruleFold} 条广告样本未被基础规则折叠。</li>}
            <li>关键词会误折叠引用或劝阻；规则仍会漏掉拆字、隐晦引流；AI 也存在误判和漏判。</li>
            <li>当前固定样本偏重推广与辱骂，缺少足够的凭证索取和成人招揽样本；重复规则只认完全相同的文本。折叠不是违规认定。</li>
          </ul>
        </section>
        <section id="evidence" className="report-section"><h2>08 / 资料与复现</h2>
          <p className="report-muted">实现：<code>df-billboard/contract/src/main.nr</code> · <code>apps/src/df-billboard-test/controller.ts</code> · <code>df-billboard/test/src/lib.nr</code></p>
          <details className="report-source"><summary>合约与链路验证</summary><pre><code>{'npm run test:df\nnpm run test:df:core'}</code></pre><p>完整 DF 入局路径需本地节点、PXE 和已部署的 DF；本地 rollup 的证明模式仍不等同正式测试网。</p></details>
          {report ? <>
          <p className="report-muted">{report.datasets.map(item => `${item.name} ${item.count} 条`).join(' ＋ ')} · 重复文本对照 {report.duplicatePairs} 组</p>
          <dl className="report-provenance"><dt>AI 模型</dt><dd>{report.ai.model}</dd><dt>版本</dt><dd><code>{report.ai.revision}</code></dd><dt>风险阈值</dt><dd>{report.ai.decision}</dd><dt>记录时间</dt><dd>{date(report.ai.recordedAt)}</dd></dl>
          <a className="report-download" href="/df-test-report.json" download="df-test-report.json">↓ 下载完整报告 JSON</a>
          <details className="report-source"><summary>数据来源与 SHA-256</summary>{report.sources?.map(source => <div key={source.file}><code>{source.file}</code><code>{source.sha256}</code></div>)}</details>
          <details className="report-source"><summary>样本测试</summary><pre><code>{'node --test apps/src/df-billboard-test/*.test.mjs\nnpm run build:df:harness'}</code></pre><p>本页读取历史 AI 结果，不会重新推理；本地链测试不代表测试网验证。</p></details></> : <p className="report-muted">样本测试报告尚未载入；上面的合约设计不依赖该文件。</p>}
        </section>
        <footer className="report-footer">Dark Forest Billboard / 设计与本地验证 · <a href="#overview">回到顶部 ↑</a></footer>
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
  return <ReportContent report={report} error={error} retry={() => setAttempt(value => value + 1)} />;
}
