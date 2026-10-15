import { classifyRulePosts, isPromotion, canFoldPromotion, canFoldBasicRules, MODERATION_RULE_VERSION } from './moderation.ts';
import { keywordMatches } from './keywords.ts';
import type { Category, ReadingReport, ReportOptions, ReportRow } from './types';

export const EXAMPLE_KEYWORDS = ['代练', '微信', 'boosting', 'VPN'];
export const CATEGORIES: Record<Category, string> = { normal: '正常聊天／讨论', advertising: '广告／变体引流', toxic: '辱骂／现实威胁', policy: '边界待定' };

export function createReadingReport({ original, holdout, browser, metadata }: {
  original: Record<string, string[]>; holdout: { samples: { id: string | number; text: string }[]; duplicatePairs: unknown[] };
  browser: { done: boolean; rows: (ReportRow & { group: string; flagged: boolean; labels?: string[] })[]; startedAt: string; elapsedMs: number; workerSha256?: string };
  metadata: { repo: string; revision: string; decision: string };
}): ReadingReport {
  if (!browser.done || !Array.isArray(browser.rows)) throw new Error('AI 记录未完成');
  const expected = new Map(Object.entries(original).filter(([key, value]) => Array.isArray(value) && key !== 'duplicatePairs')
    .flatMap(([group, texts]) => texts.map((text, i) => [`${group}-${i + 1}`, text])));
  for (const row of holdout.samples) expected.set(`holdout-${row.id}`, row.text);
  if (browser.rows.length !== expected.size || new Set(browser.rows.map(row => row.id)).size !== expected.size ||
      browser.rows.some(row => expected.get(row.id) !== row.text || typeof row.flagged !== 'boolean')) {
    throw new Error('样本与 AI 记录不一致');
  }
  const rows: ReportRow[] = classifyRulePosts(browser.rows).map(row => ({
    id: row.id, text: row.text, language: row.language, dataset: row.dataset,
    category: (row.group.startsWith('toxic') ? 'toxic' : row.group.startsWith('advertising') ? 'advertising'
      : row.group.startsWith('policy') ? 'policy' : 'normal') as Category,
    keywordHits: keywordMatches(row.text, EXAMPLE_KEYWORDS),
    adTier: row.adTier, adReasons: row.adReasons, promotion: isPromotion(row), adFold: canFoldPromotion(row),
    ruleMatches: row.ruleMatches, ruleFold: canFoldBasicRules(row),
    aiRisk: row.flagged, aiLabels: row.labels || [],
  }));
  return {
    available: true, generatedAt: new Date().toISOString(), ruleVersion: MODERATION_RULE_VERSION,
    ai: { model: metadata.repo, revision: metadata.revision, decision: metadata.decision,
      recordedAt: browser.startedAt, elapsedMs: browser.elapsedMs, workerSha256: browser.workerSha256 },
    exampleKeywords: EXAMPLE_KEYWORDS, rows,
    datasets: [{ name: '原始诊断集', count: expected.size - holdout.samples.length }, { name: '新增固定验证集', count: holdout.samples.length }],
    duplicatePairs: original.duplicatePairs.length + holdout.duplicatePairs.length,
    summary: (Object.keys(CATEGORIES) as Category[]).map(category => {
      const selected = rows.filter(row => row.category === category);
      return { category, total: selected.length, keyword: selected.filter(row => row.keywordHits.length).length,
        promotion: selected.filter(row => row.promotion).length, adFold: selected.filter(row => row.adFold).length,
        ruleFold: selected.filter(row => row.ruleFold).length,
        aiRisk: selected.filter(row => row.aiRisk).length };
    }),
  };
}

export function reportEffect(row: ReportRow, { keyword, rules, ai }: ReportOptions) {
  const keywordFolded = Boolean(keyword && row.keywordHits.length);
  const ruleFolded = Boolean(rules && row.ruleFold);
  const aiFolded = Boolean(ai && row.aiRisk);
  return { folded: keywordFolded || ruleFolded || aiFolded, keywordFolded, ruleFolded, aiFolded };
}
