import * as linkify from 'linkifyjs';
import type { PostData, RuleCategory } from './types';

export const MODERATION_RULE_VERSION = 'basic-reading-v2';

const contactPattern = /(?:微信|薇信|威信|加微|加v|v信|\bvx\b|telegram|t\.me|qq群|q群|私聊|主页|聯繫|联系)|\b(?:dm|inbox|contact|email|(?:link in|in my|in our) bio)\b/i;
const productPattern = /(?:代练|代練|玳练|陪练|上分|替你玩|升级服务|耳机|套餐|服务器|账号|返利|返佣|稳赚)|\b(?:boosting|b00st(?:ing)?|coaching|play for you|upgrades?|headphones|headsets|vpn|subscription|chairs|laptops|airdrop|returns?)\b/i;
const salesPattern = /(?:接单|接單|出售|下单|购买|转让|低价|低價|优惠|半价|清仓|返利|返佣|稳赚|包赢|包贏|特惠|折扣|询价|(?:\d+|[一二三四五六七八九十百千]+)\s*[元折])|[$¥￥]\s*\d|\b(?:buy now|buy cheap|discount|cheap|for sale|on sale|promotion|promo|guaranteed|order|quote|rates|prices|deals?|get .{0,30} today|\d+%\s*off)\b/i;
const contextPattern = /(?:不要|请勿|别相信|别买|禁止|反对|警惕|提醒|举报|骗局|被骗|风险|分析|讨论|教程)|\b(?:do not|don't|avoid|prohibit|report|warning|scam|investigat\w*|studied|tutorial|example of spam|nothing is being sold)\b/i;
const ownOfferPattern = /(?:我们|本店|工作室).{0,16}(?:接单|出售|服务)|\b(?:buy our|hire our|we offer|our packages)\b/i;
const strongOfferPattern = /(?:限时优惠|低价出售|全场优惠|今天特惠|新店开业|清仓|只剩今天)|\b(?:limited promotion|flash deals?|hot deals?|special offer)\b/i;
const serviceOfferPattern = /(?:替你玩|只要.{0,4}(?:元|块)|服务.{0,8}(?:提供|出售))|\b(?:(?:service|packages?) available|play for you|b00st your rank|get .{0,30} today)\b/i;
const gameAssetOfferPattern = /(?:出售|转让|交换|交易|换).{0,14}(?:账号|星球|舰船)|(?:账号|星球|舰船).{0,14}(?:出售|转让|交换|交易|换)|\b(?:ships? for sale|(?:sell\w*|trad\w*).{0,20}(?:account|planet|ship))\b/i;
const inGameTradePattern = /(?:游戏内|银币).{0,16}(?:交易|换|出售)|(?:交易|换|出售|只收).{0,16}(?:游戏内|银币)|\b(?:in-game silver|for silver|in-game trade)\b/i;
const communityPattern = /(?:联盟.{0,8}(?:招募|加入)|加入.{0,8}联盟|QQ群.{0,20}一起玩|比赛筹款|社区捐款)|\b(?:join.{0,20}(?:alliance|discord)|donate|donation|community tournament)\b/i;
const storefrontUrlPattern = /(?:^|[/.:-])(?:shop|store|marketplace|checkout)(?:[/?#.:_-]|$)/i;
const storefrontCallPattern = /(?:购买入口|下单入口|站外商店|商城)|\b(?:buy now|order now|shop now|visit (?:our|the) store)\b/i;
const credentialRequestPattern = /(?:输入|提交|发送|提供|上传|验证|导入|填写).{0,20}(?:助记词|私钥|恢复短语)|\b(?:enter|submit|send|share|verify|import|provide).{0,35}(?:seed phrase|private key|recovery phrase)\b/i;
const tokenClaimPattern = /(?:领取|申领|点击领取).{0,18}(?:空投|代币|奖励)|(?:空投|代币).{0,18}(?:领取|申领)|\b(?:claim|get).{0,25}(?:airdrop|free tokens?|token rewards?)\b/i;
const adultSolicitationPattern = /(?:裸聊|成人陪聊|色情服务|付费成人视频|付费私密内容)|\b(?:paid adult chat|nude content|explicit content|sex services?)\b/i;
const repeatedCallPattern = /(?:点击|点此|扫码|进群|入群|领取福利|免费礼物)|\b(?:click here|join (?:our|my) (?:group|channel)|free gift|sign up now)\b/i;

export const AD_TIER_LABELS = {
  likely: '推广线索较强', possible: '推广线索不完整／语境不确定',
  context: '广告讨论／风险提醒语境', policy: '玩家交易／社区活动 · 规则待定',
};
export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
  promotion: '明显推广', 'credential-request': '索取钱包凭证',
  'token-claim-link': '代币领取引流', 'adult-solicitation': '成人内容招揽',
  'repeated-solicitation': '重复外部招揽',
};
export const isPromotion = (post: PostData): boolean => post.adTier === 'likely' || post.adTier === 'possible';
export const canFoldPromotion = (post: PostData): boolean => post.adTier === 'likely';
export const canFoldBasicRules = (post: PostData): boolean => Boolean(post.ruleMatches?.length);

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
export function classifyRulePosts<T extends PostData>(posts: T[]): (T & { adTier: string; adReasons: string[]; ruleMatches: RuleCategory[]; similarTo: string | number | null })[] {
  const variants = new Map<string, { id: string | number; strict: string }>();
  const repeats = new Map<string, number>();
  for (const post of posts) {
    if (post.decodeError || typeof post.text !== 'string') continue;
    const key = normalizeMessage(post.text);
    if (key) repeats.set(key, (repeats.get(key) || 0) + 1);
  }
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
    const gameAssetOffer = gameAssetOfferPattern.test(readable);
    const inGameTrade = inGameTradePattern.test(readable);
    const externalStorefront = gameAssetOffer && !inGameTrade && linkify.find(text).some(link =>
      link.type === 'url' && (storefrontUrlPattern.test(link.value) || storefrontCallPattern.test(readable)));
    const policy = inGameTrade || communityPattern.test(readable) || (gameAssetOffer && !externalStorefront);
    let adTier = 'none';
    let adReasons: string[] = [];
    if (context && (product || sales)) {
      adTier = ownOfferPattern.test(readable) && sales && contact ? 'possible' : 'context';
      adReasons = ['出现引用、讨论、否定或风险提醒语境', '不自动折叠，仍可能夹带推广'];
    } else if (policy) {
      adTier = 'policy';
      adReasons = ['涉及玩家交易或社区活动，是否允许需另行确定'];
    } else if (externalStorefront) {
      adTier = 'likely';
      adReasons = ['游戏资产出售', '站外商店入口'];
    } else if (sales && (product || contact)) {
      adTier = contact && (product || strongOfferPattern.test(readable)) ? 'likely' : 'possible';
      adReasons = [product && '商品／服务', '价格／优惠／接单行为', contact && '联系或跳转入口'].filter((value): value is string => Boolean(value));
    } else if (product && contact) {
      adTier = serviceOfferPattern.test(readable) ? 'likely' : 'possible';
      adReasons = ['商品／服务与联系入口同时出现', adTier === 'likely' ? '主动提供服务' : '未确认推销行为'];
    }
    const ruleMatches: RuleCategory[] = [];
    if (adTier === 'likely') ruleMatches.push('promotion');
    // These are local reading preferences, not a legal or on-chain verdict.
    // Discussion, warnings and game-policy cases remain visible by default.
    if (!context && !policy) {
      if (credentialRequestPattern.test(readable) || credentialRequestPattern.test(compact)) ruleMatches.push('credential-request');
      if (tokenClaimPattern.test(readable) && linkify.find(text).some(link => link.type === 'url')) ruleMatches.push('token-claim-link');
      if (adultSolicitationPattern.test(readable) && contact) ruleMatches.push('adult-solicitation');
      if ((repeats.get(normalizeMessage(text)) || 0) >= 4 && contact && repeatedCallPattern.test(readable)) {
        ruleMatches.push('repeated-solicitation');
      }
    }
    // Approximate variants are only annotated; NEVER use this key for grouping or repetition rules.
    const loose = variantKey(text);
    const strict = normalizeMessage(text);
    const previous = loose && variants.get(loose);
    const similarTo = previous && previous.strict !== strict ? previous.id : null;
    if (loose && !previous) variants.set(loose, { id: post.id, strict });
    return { ...post, adTier, adReasons, ruleMatches, similarTo };
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
