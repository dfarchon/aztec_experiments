import * as linkify from 'linkifyjs';
import type { PostData } from './types';

export const MODERATION_RULE_VERSION = 'conservative-reading-v3';

const contactPattern = /(?:微信|薇信|威信|加微|加v|v信|\bvx\b|telegram|t\.me|qq群|q群|私聊|主页|聯繫|联系)|\b(?:dm|inbox|contact|email|(?:link in|in my|in our) bio)\b/i;
const productPattern = /(?:代练|代練|玳练|陪练|上分|耳机|套餐|服务器|账号|返利|返佣|稳赚)|\b(?:boosting|b00sting|coaching|headphones|headsets|vpn|subscription|chairs|laptops|airdrop|returns?)\b/i;
const salesPattern = /(?:接单|接單|出售|下单|购买|转让|低价|低價|优惠|半价|清仓|返利|返佣|稳赚|包赢|包贏|特惠|折扣|询价|\d+\s*[元折])|[$¥￥]\s*\d|\b(?:buy now|buy cheap|discount|cheap|for sale|on sale|promotion|promo|guaranteed|order|quote|rates|prices|\d+%\s*off)\b/i;
const contextPattern = /(?:不要|请勿|别相信|别买|禁止|反对|警惕|提醒|举报|骗局|被骗|风险|分析|讨论|教程)|\b(?:do not|don't|avoid|prohibit|report|warning|scam|investigat\w*|studied|tutorial|example of spam|nothing is being sold)\b/i;
const ownOfferPattern = /(?:我们|本店|工作室).{0,16}(?:接单|出售|服务)|\b(?:buy our|hire our|we offer|our packages)\b/i;
const policyPattern = /(?:出售|转让|交换|交易|换).{0,14}(?:账号|星球|舰船)|(?:游戏内|银币).{0,16}(?:交易|换|出售)|(?:联盟.{0,8}(?:招募|加入)|加入.{0,8}联盟|QQ群.{0,20}一起玩|比赛筹款|社区捐款)|\b(?:ships? for sale|in-game silver|(?:sell\w*|trad\w*).{0,20}(?:account|planet|ship)|join.{0,20}(?:alliance|discord)|donate|donation|community tournament)\b/i;

export const AD_TIER_LABELS = {
  likely: '推广线索较强', possible: '推广线索不完整／语境不确定',
  context: '广告讨论／风险提醒语境', policy: '玩家交易／社区活动 · 规则待定',
};
export const isPromotion = (post: PostData): boolean => post.adTier === 'likely' || post.adTier === 'possible';
export const canFoldPromotion = (post: PostData): boolean => post.adTier === 'likely';

export function normalizeMessage(text: string): string {
  // Conservative grouping: preserve case, character forms and word boundaries.
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function variantKey(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function hasContactSignal(text: string): boolean {
  const searchable = text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
  return contactPattern.test(searchable) || contactPattern.test(searchable.replace(/\s+/g, '')) ||
    linkify.find(searchable).some(item => item.type === 'url' || item.type === 'email');
}

// Deterministic local classification, not semantic moderation. Context,
// policy and weak evidence never authorize folding.
export function classifyRulePosts<T extends PostData>(posts: T[]): (T & { adTier: string; adReasons: string[]; similarTo: string | number | null })[] {
  const variants = new Map<string, { id: string | number; strict: string }>();
  return posts.map(post => {
    const text = typeof post.text === 'string' && !post.decodeError ? post.text : '';
    let readable = text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
    // A URL path such as /sale or /promo is not promotional wording by itself.
    for (const link of linkify.find(readable).reverse()) {
      readable = readable.slice(0, link.start) + ' ' + readable.slice(link.end);
    }
    const compact = readable.replace(/[\s\-·]+/g, '');
    const product = productPattern.test(readable) || /代练|代練|陪练|玳练/.test(compact);
    const sales = salesPattern.test(readable) || /限时优惠|低价|特惠|接单/.test(compact);
    const contact = hasContactSignal(text);
    const context = contextPattern.test(readable);
    let adTier = 'none';
    let adReasons: string[] = [];
    if (context && (product || sales)) {
      adTier = ownOfferPattern.test(readable) && sales && contact ? 'possible' : 'context';
      adReasons = ['出现引用、讨论、否定或风险提醒语境', '不自动折叠，仍可能夹带推广'];
    } else if (policyPattern.test(readable)) {
      adTier = 'policy';
      adReasons = ['涉及玩家交易或社区活动，是否允许需另行确定'];
    } else if (sales && (product || contact)) {
      adTier = product && contact ? 'likely' : 'possible';
      adReasons = [product && '商品／服务', '价格／优惠／接单行为', contact && '联系或跳转入口'].filter((value): value is string => Boolean(value));
    } else if (product && contact) {
      adTier = 'possible';
      adReasons = ['商品／服务与联系入口同时出现', '未确认推销行为'];
    }
    // Approximate variants are only annotated; NEVER use this key for grouping.
    const loose = variantKey(text);
    const strict = normalizeMessage(text);
    const previous = loose && variants.get(loose);
    const similarTo = previous && previous.strict !== strict ? previous.id : null;
    if (loose && !previous) variants.set(loose, { id: post.id, strict });
    return { ...post, adTier, adReasons, similarTo };
  });
}

// Preserve every original ID/text/AI label. This is display grouping only.
export function groupDuplicatePosts<T extends PostData>(posts: T[], enabled = true): T[][] {
  const groups: T[][] = [];
  const seen = new Map<string, T[]>();
  for (const post of posts) {
    const key = enabled && !post.decodeError && typeof post.text === 'string'
      ? normalizeMessage(post.text) : '';
    const existing = key && seen.get(key);
    if (existing) existing.push(post);
    else {
      const group = [post];
      groups.push(group);
      if (key) seen.set(key, group);
    }
  }
  return groups;
}
