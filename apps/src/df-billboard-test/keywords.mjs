export const KEYWORD_LIMIT = 200;
export const KEYWORD_LENGTH_LIMIT = 80;
export const normalizeKeywordText = text => text.normalize('NFKC').toLowerCase();

// Literal user preferences, not an advertising or safety judgement. Never
// interpret user input as regex or remove spaces / zero-width characters.
export function parseKeywords(input) {
  if (typeof input !== 'string' || input.length > 20_000) throw new Error('词表过大，请限制在 200 个词以内');
  const words = [], seen = new Set();
  for (const line of input.split(/\r?\n/)) {
    const word = line.trim();
    if (!word) continue;
    if ([...word].length > KEYWORD_LENGTH_LIMIT) throw new Error('每个关键词最多 80 个字符');
    const key = normalizeKeywordText(word);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length > KEYWORD_LIMIT) throw new Error('最多保存 200 个关键词');
  return words;
}

export function keywordMatches(text, words = [], mode = 'contains') {
  if (typeof text !== 'string') return [];
  const normalized = normalizeKeywordText(text);
  return words.filter(word => {
    const keyword = normalizeKeywordText(word);
    if (!keyword) return false;
    if (mode !== 'word' || !/^[a-z0-9_]+(?:[ -][a-z0-9_]+)*$/i.test(keyword)) return normalized.includes(keyword);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}\\p{M}_])${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}_])`, 'u').test(normalized);
  });
}
