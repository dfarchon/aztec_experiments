export const KEYWORD_LIMIT = 200;
export const KEYWORD_LENGTH_LIMIT = 80;
export const normalizeKeywordText = (text: string) =>
  text.normalize("NFKC").toLowerCase();

// Literal user preferences, not an advertising or safety judgement. Never
// interpret user input as regex or remove spaces / zero-width characters.
export function parseKeywords(input: string): string[] {
  if (typeof input !== "string" || input.length > 20_000)
    throw new Error("The word list is too large. Use at most 200 keywords.");
  const words: string[] = [],
    seen = new Set<string>();
  for (const line of input.split(/\r?\n/)) {
    const word = line.trim();
    if (!word) continue;
    if ([...word].length > KEYWORD_LENGTH_LIMIT)
      throw new Error("Each keyword can contain up to 80 characters");
    const key = normalizeKeywordText(word);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length > KEYWORD_LIMIT)
    throw new Error("You can save up to 200 keywords");
  return words;
}

export function keywordMatches(
  text: string | undefined,
  words: string[] = [],
  mode: "contains" | "word" = "contains"
): string[] {
  if (typeof text !== "string") return [];
  const normalized = normalizeKeywordText(text);
  return words.filter((word) => {
    const keyword = normalizeKeywordText(word);
    if (!keyword) return false;
    if (mode !== "word" || !/^[a-z0-9_]+(?:[ -][a-z0-9_]+)*$/i.test(keyword))
      return normalized.includes(keyword);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}\\p{M}_])${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}_])`,
      "u"
    ).test(normalized);
  });
}
