import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { CATEGORIES, reportEffect } from './report-data.mjs';
import type { AdMode, ReadingReport, ReportOptions, ReportRow } from './types';
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
  const [options, setOptions] = useState<ReportOptions>({ keyword: false, ad: true, adMode: 'hint', ai: false });
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
      (outcome === 'ad-miss' && row.category === 'advertising' && !row.promotion) ||
      (outcome === 'ai-fp' && row.category === 'normal' && row.aiRisk) ||
      (outcome === 'ai-fn' && row.category === 'toxic' && !row.aiRisk)));
  const pages = Math.max(1, Math.ceil(visible.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const count = (predicate: (row: ReportRow & {effect: ReturnType<typeof reportEffect>}) => boolean) => evaluated.filter(predicate).length;
  const normal = report.summary.find(row => row.category === 'normal')!;
  const ad = report.summary.find(row => row.category === 'advertising')!;
  const toxic = report.summary.find(row => row.category === 'toxic')!;
  return <>
    <a className="skip-link" href="#overview">跳到正文</a><Header />
    <div className="report-layout">
      <aside className="report-sidebar"><span className="eyebrow">FIELD NOTES / 01</span>
        <nav aria-label="报告目录">{sections.map(([id, title], index) => <a key={id} href={`#${id}`}><span>0{index + 1}</span>{title}</a>)}</nav>
        <p>只读测试报告<br />无需钱包 · 无模型下载</p>
      </aside>
      <main className="report-content">
        <div className="report-title"><span className="eyebrow">TESTS & DESIGN</span><h1>阅读过滤：测试与设计</h1>
          <p>三个独立开关，各自解决一种问题。这里记录它们做到了什么，也保留没有做好的部分。</p>
          <div className="report-meta">规则：{report.ruleVersion}<br />AI 实测：{date(report.ai.recordedAt)}（北京时间）</div>
        </div>
        <section id="overview" className="report-section"><h2>01 / 结果总览</h2>
          <div className="report-notice">这是固定人工诊断集，不是真实玩家抽样，也不是生产准确率。规则与关键词在构建时重新计算；AI 使用已保存的浏览器推理结果，本页不会启动模型。</div>
          <div className="report-metrics">
            <div><strong>{report.rows.length}</strong><span>内容样本 · 中英文各 {report.rows.filter(row => row.language === 'zh').length} 条</span></div>
            <div><strong>{ad.promotion}/{ad.total}</strong><span>广告获得推广提示</span></div>
            <div><strong>{toxic.aiRisk}/{toxic.total}</strong><span>辱骂／威胁获得 AI 提示</span></div>
            <div><strong>{normal.aiRisk}/{normal.total}</strong><span>正常聊天／讨论被 AI 误报</span></div>
          </div>
          <p>{report.datasets.map(item => `${item.name} ${item.count} 条`).join(' ＋ ')}。另有 {report.duplicatePairs} 组重复文本对照，不计入内容样本，也不计入下表。</p>
          <p className="report-muted">关键词是个人阅读偏好；推广规则判断推销线索；AI 补充识别内容风险。三者均不删除链上原文、不扣额度、不封禁玩家。</p>
        </section>
        <section id="switches" className="report-section"><h2>02 / 三个开关，分别会发生什么？</h2>
          <p>关键词示例词表：<code>{report.exampleKeywords.join('、')}</code>，采用“包含关键词”。它不是默认词表，也不会写入你的留言板设置。</p>
          <div className="report-table-wrap" tabIndex={0} aria-label="开关效果表，可横向滚动"><table>
            <caption>固定样本上的独立效果；每个数字代表消息条数</caption>
            <thead><tr><th scope="col">样本类别</th><th scope="col">总数</th><th scope="col">关键词折叠</th><th scope="col">推广提示</th><th scope="col">推广可折叠</th><th scope="col">AI 风险提示</th></tr></thead>
            <tbody>{report.summary.map(row => <tr key={row.category}><th scope="row">{CATEGORIES[row.category]}</th>
              <td>{row.total}</td><td>{row.keyword}</td><td>{row.promotion}</td><td>{row.adFold}</td><td>{row.aiRisk}</td></tr>)}</tbody>
          </table></div>
          <p className="report-muted">“推广提示”只统计疑似推广，不含“广告讨论／风险提醒”和“玩家交易／社区活动”标签。仅提示模式不会折叠；选择折叠后，也只折叠证据较强的推广。AI 本身永远不触发折叠。</p>
          <fieldset className="report-simulator"><legend>组合预览</legend>
            <div className="report-controls">
              <label><input id="previewKeyword" type="checkbox" checked={options.keyword} onChange={setting('keyword')} />关键词屏蔽</label>
              <label><input id="previewAd" type="checkbox" checked={options.ad} onChange={setting('ad')} />推广规则</label>
              <label>推广处理 <select id="previewAdMode" value={options.adMode} disabled={!options.ad} onChange={event => setOptions(value => ({ ...value, adMode: event.target.value as AdMode }))}>
                <option value="hint">仅提示</option><option value="fold">折叠较强线索</option></select></label>
              <label><input id="previewAi" type="checkbox" checked={options.ai} onChange={setting('ai')} />AI 提示</label>
            </div>
            <p id="previewResult" role="status" aria-live="polite">折叠 <strong>{count(row => row.effect.folded)}</strong> 条 ／ 推广提示 {count(row => row.effect.promotion)} 条 ／ AI 风险提示 {count(row => row.effect.aiRisk)} 条</p>
            <p className="report-muted">仅预览这批样本；不改变真实留言板、不发交易、不重新推理。命中多个折叠条件只计一次。</p>
          </fieldset>
        </section>
        <section id="samples" className="report-section"><h2>03 / 样本明细</h2>
          <p>查看每条原文、命中理由和历史 AI 标签。风险样本默认收起；样本链接只作为文本展示。</p>
          <div className="report-controls report-filters">
            <label>类别<select id="sampleCategory" value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部类别</option>{Object.entries(CATEGORIES).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
            <label>语言<select id="sampleLanguage" value={language} onChange={event => setLanguage(event.target.value)}><option value="all">中英文</option><option value="zh">中文</option><option value="en">英文</option></select></label>
            <label>结果<select id="sampleOutcome" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="all">全部结果</option><option value="folded">当前组合折叠</option><option value="ad-miss">规则未提示的广告</option><option value="ai-fp">AI 误报正常内容</option><option value="ai-fn">AI 漏报风险内容</option></select></label>
            <label>搜索<input id="sampleSearch" type="search" value={search} placeholder="文本或样本编号" onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <p className="report-muted" id="sampleCount" role="status">找到 {visible.length} 条 · 第 {currentPage + 1} / {pages} 页</p>
          <ul className="report-samples">{visible.slice(currentPage * 12, currentPage * 12 + 12).map(row => <li key={row.id} data-sample-id={row.id}>
            <div className="sample-heading"><code>{row.id}</code><span>{CATEGORIES[row.category]} · {row.language === 'zh' ? '中文' : '英文'}</span><span className={row.effect.folded ? 'sample-folded' : ''}>{row.effect.folded ? '当前组合：折叠' : '当前组合：展示'}</span></div>
            {row.category === 'toxic' ? <details><summary>展开风险样本原文</summary><p className="sample-text">{row.text}</p></details> : <p className="sample-text">{row.text}</p>}
            <details className="sample-reasons"><summary>判定明细</summary><dl>
              <dt>示例关键词</dt><dd>{row.keywordHits.join('、') || '未命中'}</dd>
              <dt>推广规则</dt><dd>{row.adTier} · {row.adReasons.join('；') || '未发现推广线索'}</dd>
              <dt>历史 AI</dt><dd>{row.aiRisk ? `风险提示：${row.aiLabels.join('、')}` : '未提示风险（不代表安全）'}</dd>
            </dl></details>
          </li>)}</ul>
          {!visible.length && <p className="report-empty">没有匹配样本，请调整筛选条件。</p>}
          <div className="report-controls"><button id="samplesPrev" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← 上一页</button><button id="samplesNext" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页 →</button></div>
        </section>
        <section id="design" className="report-section"><h2>04 / 设计逻辑</h2>
          <ol className="design-steps"><li><h3>资格与发帖在链上</h3><p>以当前赛季指定的 DF PlayerStorage 入局状态验证资格。独立留言板保存公开文本；每条最多 512 UTF-8 字节，按 Aztec 锚定区块时间计算滚动 24 小时内 10 条额度。首帖自动处理资格，无手动领取步骤。本地交易由 Sponsored FPC 代付。</p></li>
            <li><h3>阅读偏好在客户端</h3><p>读取消息后，分别运行个人词表和推广规则。默认推广规则开启且仅提示，关键词关闭、词表为空，AI 关闭。三个开关彼此独立，设置只保存在此浏览器。</p></li>
            <li><h3>关键词不做语义判断</h3><p>忽略英文大小写与全半角差异；每行一个词，最多 200 个，每词最多 80 个字符。可选英文完整单词匹配，中文仍按包含。不会自动识别谐音、零宽字符变体；引用和劝阻也可能命中。</p></li>
            <li><h3>推广需要组合证据</h3><p>结合商品／服务、推销行为、联系方式判断。单独一个链接不是广告。较强线索可以折叠；不完整线索、风险讨论、玩家交易与社区活动只提示，避免把游戏交流当广告。</p></li>
            <li><h3>AI 是可选提示层</h3><p>用户确认后才加载中英文模型，在浏览器 Worker 中本地推理；帖子不上传审核服务。首次需下载约 268 MB 权重、34 MB 分词器及运行库。失败时保留原文，链上操作期间暂停 AI；关闭后停止分析。</p></li>
            <li><h3>展示不等于处罚</h3><p>关键词命中或强推广折叠条件满足其一，即可折叠。AI 不参与折叠条件。原文始终可展开；不引入管理员审核，不删帖、不扣额度。其他客户端仍可读取链上原文。</p></li></ol>
          <p className="report-legend">符号：⊘ 关键词命中 · ⚑ 规则标签 · ⚠ AI 风险 · ◇ AI 未提示风险 · ◷ 待分析。留言板中悬停或点击符号查看解释。</p>
        </section>
        <section id="limits" className="report-section"><h2>05 / 已知局限</h2>
          <ul><li>144 条均为人工编写，中英文均衡但不代表真实使用比例；新增验证集已被查看，下一轮需新的未见样本。</li>
            <li>风险样本主要覆盖辱骂与现实威胁；色情、隐私泄露、诈骗等类别覆盖不足，不能宣称“全面屏蔽非法内容”。</li>
            <li>AI 会把劝阻、引用和游戏表达误判。例如“如果有人威胁杀人，请保存聊天记录。”因此不凭一次模型判断隐藏内容。</li>
            <li>规则会漏掉隐晦引流；关键词可能把“我们反对代练”一起折叠。命中不是违法认定，未命中也不等于安全。</li>
            <li>独立匿名帖子缺少上下文，尚未评测跨帖广告、批量刷屏和多轮攻击。重复合并仅处理文本展示，不是身份处罚。</li>
          </ul>
        </section>
        <section id="evidence" className="report-section"><h2>06 / 资料与复现</h2>
          <p>构建时间：{date(report.generatedAt)}（北京时间）。这不是重新运行 AI 的时间。</p>
          <dl className="report-provenance"><dt>历史 AI 模型</dt><dd>{report.ai.model}</dd><dt>固定版本</dt><dd><code>{report.ai.revision}</code></dd><dt>风险阈值</dt><dd>{report.ai.decision}</dd><dt>历史浏览器耗时</dt><dd>{(report.ai.elapsedMs / 1000).toFixed(2)} 秒／全部样本，含缓存模型初始化，不含首次下载；不是冷启动或通用设备性能承诺。</dd></dl>
          <a className="report-download" href="/df-test-report.json" download="df-test-report.json">↓ 下载完整报告 JSON</a>
          <details className="report-source"><summary>数据来源与 SHA-256</summary>{report.sources?.map(source => <div key={source.file}><code>{source.file}</code><code>{source.sha256}</code></div>)}</details>
          <h3>功能验证与内容效果是两回事</h3><p>2026-10-14 本页实现时的回归记录：42 项功能测试通过，涵盖钱包、入局、发帖、开关、AI 缓存、文本渲染与本地时间同步，其中 4 项验证报告数据、开关组合、证据完整性与页面渲染。此前另用独立测试账号完成了本地入局 → 发帖；链使用 synthetic 模式，不代表测试网或生产验证。</p>
          <p>本页不在后台执行测试；查看当前代码的最新结果，请在项目目录运行：</p>
          <pre><code>{'node --test apps/src/df-billboard-test/*.test.mjs\nnpm run build:df:harness'}</code></pre>
          <p className="report-muted">原始文档位于项目外的 ../docs。更换位置可设置 DF_REPORT_DOCS_DIR 后构建。构建只重新计算规则与示例词表、读取历史 AI 结果；更换模型后需重新采集 AI 测试记录。</p>
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
