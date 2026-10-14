import type { PostData } from './types';
export const MODERATION_RULE_VERSION: string;
export const AD_TIER_LABELS: Record<string, string>;
export function isPromotion(post: PostData): boolean;
export function canFoldPromotion(post: PostData): boolean;
export function normalizeMessage(text: string): string;
export function hasContactSignal(text: string): boolean;
export function classifyRulePosts<T extends PostData>(posts: T[]): (T & {adTier: string; adReasons: string[]; similarTo: string | number | null})[];
export function groupDuplicatePosts<T extends PostData>(posts: T[], enabled?: boolean): T[][];
