import { classifyRulePosts, isPromotion, canFoldPromotion, MODERATION_RULE_VERSION } from './moderation.mjs';
import { keywordMatches } from './keywords.mjs';

export const EXAMPLE_KEYWORDS = ['代练', '微信', 'boosting', 'VPN'];
export const CATEGORIES = { normal: '正常聊天／讨论', advertising: '广告／变体引流', toxic: '辱骂／现实威胁', policy: '边界待定' };

export function createReadingReport({ original, holdout, browser, metadata }) {
  if (!browser.done || !Array.isArray(browser.rows)) throw new Error('AI 记录未完成');
  const expected = new Map(Object.entries(original).filter(([key, value]) => Array.isArray(value) && key !== 'duplicatePairs')
    .flatMap(([group, texts]) => texts.map((text, i) => [`${group}-${i + 1}`, text])));
  for (const row of holdout.samples) expected.set(`holdout-${row.id}`, row.text);
  if (browser.rows.length !== expected.size || new Set(browser.rows.map(row => row.id)).size !== expected.size ||
      browser.rows.some(row => expected.get(row.id) !== row.text || typeof row.flagged !== 'boolean')) {
    throw new Error('样本与 AI 记录不一致');
  }
  const rows = classifyRulePosts(browser.rows).map(row => ({
    id: row.id, text: row.text, language: row.language, dataset: row.dataset,
    category: row.group.startsWith('toxic') ? 'toxic' : row.group.startsWith('advertising') ? 'advertising'
      : row.group.startsWith('policy') ? 'policy' : 'normal',
    keywordHits: keywordMatches(row.text, EXAMPLE_KEYWORDS),
    adTier: row.adTier, adReasons: row.adReasons, promotion: isPromotion(row), adFold: canFoldPromotion(row),
    aiRisk: row.flagged, aiLabels: row.labels || [],
  }));
  return {
    available: true, generatedAt: new Date().toISOString(), ruleVersion: MODERATION_RULE_VERSION,
    ai: { model: metadata.repo, revision: metadata.revision, decision: metadata.decision,
      recordedAt: browser.startedAt, elapsedMs: browser.elapsedMs, workerSha256: browser.workerSha256 },
    exampleKeywords: EXAMPLE_KEYWORDS, rows,
    datasets: [{ name: '原始诊断集', count: expected.size - holdout.samples.length }, { name: '新增固定验证集', count: holdout.samples.length }],
    duplicatePairs: original.duplicatePairs.length + holdout.duplicatePairs.length,
    summary: Object.keys(CATEGORIES).map(category => {
      const selected = rows.filter(row => row.category === category);
      return { category, total: selected.length, keyword: selected.filter(row => row.keywordHits.length).length,
        promotion: selected.filter(row => row.promotion).length, adFold: selected.filter(row => row.adFold).length,
        aiRisk: selected.filter(row => row.aiRisk).length };
    }),
  };
}

export function reportEffect(row, { keyword, ad, adMode, ai }) {
  return { folded: Boolean((keyword && row.keywordHits.length) || (ad && adMode === 'fold' && row.adFold)),
    promotion: Boolean(ad && row.promotion), aiRisk: Boolean(ai && row.aiRisk) };
}
