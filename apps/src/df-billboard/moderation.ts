import * as linkify from "linkifyjs";

import type { PostData, RuleCategory } from "./types";

export const MODERATION_RULE_VERSION = "basic-reading-v2";

const contactPattern =
  /(?:\u5fae\u4fe1|\u8587\u4fe1|\u5a01\u4fe1|\u52a0\u5fae|\u52a0v|v\u4fe1|\bvx\b|telegram|t\.me|qq\u7fa4|q\u7fa4|\u79c1\u804a|\u4e3b\u9875|\u806f\u7e6b|\u8054\u7cfb)|\b(?:dm|inbox|contact|email|(?:link in|in my|in our) bio)\b/i;
const productPattern =
  /(?:\u4ee3\u7ec3|\u4ee3\u7df4|\u73b3\u7ec3|\u966a\u7ec3|\u4e0a\u5206|\u66ff\u4f60\u73a9|\u5347\u7ea7\u670d\u52a1|\u8033\u673a|\u5957\u9910|\u670d\u52a1\u5668|\u8d26\u53f7|\u8fd4\u5229|\u8fd4\u4f63|\u7a33\u8d5a)|\b(?:boosting|b00st(?:ing)?|coaching|play for you|upgrades?|headphones|headsets|vpn|subscription|chairs|laptops|airdrop|returns?)\b/i;
const salesPattern =
  /(?:\u63a5\u5355|\u63a5\u55ae|\u51fa\u552e|\u4e0b\u5355|\u8d2d\u4e70|\u8f6c\u8ba9|\u4f4e\u4ef7|\u4f4e\u50f9|\u4f18\u60e0|\u534a\u4ef7|\u6e05\u4ed3|\u8fd4\u5229|\u8fd4\u4f63|\u7a33\u8d5a|\u5305\u8d62|\u5305\u8d0f|\u7279\u60e0|\u6298\u6263|\u8be2\u4ef7|(?:\d+|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343]+)\s*[\u5143\u6298])|[$¥￥]\s*\d|\b(?:buy now|buy cheap|discount|cheap|for sale|on sale|promotion|promo|guaranteed|order|quote|rates|prices|deals?|get .{0,30} today|\d+%\s*off)\b/i;
const contextPattern =
  /(?:\u4e0d\u8981|\u8bf7\u52ff|\u522b\u76f8\u4fe1|\u522b\u4e70|\u7981\u6b62|\u53cd\u5bf9|\u8b66\u60d5|\u63d0\u9192|\u4e3e\u62a5|\u9a97\u5c40|\u88ab\u9a97|\u98ce\u9669|\u5206\u6790|\u8ba8\u8bba|\u6559\u7a0b)|\b(?:do not|don't|avoid|prohibit|report|warning|scam|investigat\w*|studied|tutorial|example of spam|nothing is being sold)\b/i;
const ownOfferPattern =
  /(?:\u6211\u4eec|\u672c\u5e97|\u5de5\u4f5c\u5ba4).{0,16}(?:\u63a5\u5355|\u51fa\u552e|\u670d\u52a1)|\b(?:buy our|hire our|we offer|our packages)\b/i;
const strongOfferPattern =
  /(?:\u9650\u65f6\u4f18\u60e0|\u4f4e\u4ef7\u51fa\u552e|\u5168\u573a\u4f18\u60e0|\u4eca\u5929\u7279\u60e0|\u65b0\u5e97\u5f00\u4e1a|\u6e05\u4ed3|\u53ea\u5269\u4eca\u5929)|\b(?:limited promotion|flash deals?|hot deals?|special offer)\b/i;
const serviceOfferPattern =
  /(?:\u66ff\u4f60\u73a9|\u53ea\u8981.{0,4}(?:\u5143|\u5757)|\u670d\u52a1.{0,8}(?:\u63d0\u4f9b|\u51fa\u552e))|\b(?:(?:service|packages?) available|play for you|b00st your rank|get .{0,30} today)\b/i;
const gameAssetOfferPattern =
  /(?:\u51fa\u552e|\u8f6c\u8ba9|\u4ea4\u6362|\u4ea4\u6613|\u6362).{0,14}(?:\u8d26\u53f7|\u661f\u7403|\u8230\u8239)|(?:\u8d26\u53f7|\u661f\u7403|\u8230\u8239).{0,14}(?:\u51fa\u552e|\u8f6c\u8ba9|\u4ea4\u6362|\u4ea4\u6613|\u6362)|\b(?:ships? for sale|(?:sell\w*|trad\w*).{0,20}(?:account|planet|ship))\b/i;
const inGameTradePattern =
  /(?:\u6e38\u620f\u5185|\u94f6\u5e01).{0,16}(?:\u4ea4\u6613|\u6362|\u51fa\u552e)|(?:\u4ea4\u6613|\u6362|\u51fa\u552e|\u53ea\u6536).{0,16}(?:\u6e38\u620f\u5185|\u94f6\u5e01)|\b(?:in-game silver|for silver|in-game trade)\b/i;
const communityPattern =
  /(?:\u8054\u76df.{0,8}(?:\u62db\u52df|\u52a0\u5165)|\u52a0\u5165.{0,8}\u8054\u76df|QQ\u7fa4.{0,20}\u4e00\u8d77\u73a9|\u6bd4\u8d5b\u7b79\u6b3e|\u793e\u533a\u6350\u6b3e)|\b(?:join.{0,20}(?:alliance|discord)|donate|donation|community tournament)\b/i;
const storefrontUrlPattern =
  /(?:^|[/.:-])(?:shop|store|marketplace|checkout)(?:[/?#.:_-]|$)/i;
const storefrontCallPattern =
  /(?:\u8d2d\u4e70\u5165\u53e3|\u4e0b\u5355\u5165\u53e3|\u7ad9\u5916\u5546\u5e97|\u5546\u57ce)|\b(?:buy now|order now|shop now|visit (?:our|the) store)\b/i;
const credentialRequestPattern =
  /(?:\u8f93\u5165|\u63d0\u4ea4|\u53d1\u9001|\u63d0\u4f9b|\u4e0a\u4f20|\u9a8c\u8bc1|\u5bfc\u5165|\u586b\u5199).{0,20}(?:\u52a9\u8bb0\u8bcd|\u79c1\u94a5|\u6062\u590d\u77ed\u8bed)|\b(?:enter|submit|send|share|verify|import|provide).{0,35}(?:seed phrase|private key|recovery phrase)\b/i;
const tokenClaimPattern =
  /(?:\u9886\u53d6|\u7533\u9886|\u70b9\u51fb\u9886\u53d6).{0,18}(?:\u7a7a\u6295|\u4ee3\u5e01|\u5956\u52b1)|(?:\u7a7a\u6295|\u4ee3\u5e01).{0,18}(?:\u9886\u53d6|\u7533\u9886)|\b(?:claim|get).{0,25}(?:airdrop|free tokens?|token rewards?)\b/i;
const adultSolicitationPattern =
  /(?:\u88f8\u804a|\u6210\u4eba\u966a\u804a|\u8272\u60c5\u670d\u52a1|\u4ed8\u8d39\u6210\u4eba\u89c6\u9891|\u4ed8\u8d39\u79c1\u5bc6\u5185\u5bb9)|\b(?:paid adult chat|nude content|explicit content|sex services?)\b/i;
const repeatedCallPattern =
  /(?:\u70b9\u51fb|\u70b9\u6b64|\u626b\u7801|\u8fdb\u7fa4|\u5165\u7fa4|\u9886\u53d6\u798f\u5229|\u514d\u8d39\u793c\u7269)|\b(?:click here|join (?:our|my) (?:group|channel)|free gift|sign up now)\b/i;

export const isPromotion = (post: PostData): boolean =>
  post.adTier === "likely" || post.adTier === "possible";
export const canFoldPromotion = (post: PostData): boolean =>
  post.adTier === "likely";
export const canFoldBasicRules = (post: PostData): boolean =>
  Boolean(post.ruleMatches?.length);

export function normalizeMessage(text: string): string {
  // Count repetitions conservatively: preserve case, forms and word boundaries.
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function hasContactSignal(text: string): boolean {
  const searchable = text
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "");
  return (
    contactPattern.test(searchable) ||
    contactPattern.test(searchable.replace(/\s+/g, "")) ||
    linkify
      .find(searchable)
      .some((item) => item.type === "url" || item.type === "email")
  );
}

// Deterministic local classification, not semantic moderation. Context,
// policy and weak evidence never authorize folding.
export function classifyRulePosts<T extends PostData>(
  posts: T[]
): (T & {
  adTier: string;
  adReasons: string[];
  ruleMatches: RuleCategory[];
})[] {
  const repeats = new Map<string, number>();
  for (const post of posts) {
    if (post.decodeError || typeof post.text !== "string") continue;
    const key = normalizeMessage(post.text);
    if (key) repeats.set(key, (repeats.get(key) || 0) + 1);
  }
  return posts.map((post) => {
    const text =
      typeof post.text === "string" && !post.decodeError ? post.text : "";
    let readable = text.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
    // A URL path such as /sale or /promo is not promotional wording by itself.
    for (const link of linkify.find(readable).reverse()) {
      readable = readable.slice(0, link.start) + " " + readable.slice(link.end);
    }
    const compact = readable.replace(/[\s\-·]+/g, "");
    const product =
      productPattern.test(readable) ||
      /\u4ee3\u7ec3|\u4ee3\u7df4|\u966a\u7ec3|\u73b3\u7ec3/.test(compact);
    const sales =
      salesPattern.test(readable) ||
      /\u9650\u65f6\u4f18\u60e0|\u4f4e\u4ef7|\u7279\u60e0|\u63a5\u5355/.test(
        compact
      );
    const contact = hasContactSignal(text);
    const context = contextPattern.test(readable);
    const gameAssetOffer = gameAssetOfferPattern.test(readable);
    const inGameTrade = inGameTradePattern.test(readable);
    const externalStorefront =
      gameAssetOffer &&
      !inGameTrade &&
      linkify
        .find(text)
        .some(
          (link) =>
            link.type === "url" &&
            (storefrontUrlPattern.test(link.value) ||
              storefrontCallPattern.test(readable))
        );
    const policy =
      inGameTrade ||
      communityPattern.test(readable) ||
      (gameAssetOffer && !externalStorefront);
    let adTier = "none";
    let adReasons: string[] = [];
    if (context && (product || sales)) {
      adTier =
        ownOfferPattern.test(readable) && sales && contact
          ? "possible"
          : "context";
      adReasons = [
        "Quoted, discussed, negated, or warned about",
        "Not folded automatically; promotion may still be present",
      ];
    } else if (policy) {
      adTier = "policy";
      adReasons = [
        "Player trade or community activity needs a separate policy decision",
      ];
    } else if (externalStorefront) {
      adTier = "likely";
      adReasons = ["Game asset offered for sale", "External store link"];
    } else if (sales && (product || contact)) {
      adTier =
        contact && (product || strongOfferPattern.test(readable))
          ? "likely"
          : "possible";
      adReasons = [
        product && "Product or service",
        "Price, discount, or order solicitation",
        contact && "Contact or external destination",
      ].filter((value): value is string => Boolean(value));
    } else if (product && contact) {
      adTier = serviceOfferPattern.test(readable) ? "likely" : "possible";
      adReasons = [
        "Product or service with contact details",
        adTier === "likely"
          ? "Service offered directly"
          : "Unconfirmed solicitation",
      ];
    }
    const ruleMatches: RuleCategory[] = [];
    if (adTier === "likely") ruleMatches.push("promotion");
    // These are local reading preferences, not a legal or on-chain verdict.
    // Discussion, warnings and game-policy cases remain visible by default.
    if (!context && !policy) {
      if (
        credentialRequestPattern.test(readable) ||
        credentialRequestPattern.test(compact)
      )
        ruleMatches.push("credential-request");
      if (
        tokenClaimPattern.test(readable) &&
        linkify.find(text).some((link) => link.type === "url")
      )
        ruleMatches.push("token-claim-link");
      if (adultSolicitationPattern.test(readable) && contact)
        ruleMatches.push("adult-solicitation");
      if (
        (repeats.get(normalizeMessage(text)) || 0) >= 4 &&
        contact &&
        repeatedCallPattern.test(readable)
      ) {
        ruleMatches.push("repeated-solicitation");
      }
    }
    return { ...post, adTier, adReasons, ruleMatches };
  });
}
