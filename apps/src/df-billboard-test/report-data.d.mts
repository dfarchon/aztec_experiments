import type { Category, ReadingReport, ReportOptions, ReportRow } from './types';
export const EXAMPLE_KEYWORDS: string[];
export const CATEGORIES: Record<Category, string>;
export function reportEffect(row: ReportRow, options: ReportOptions): { folded: boolean; promotion: boolean; aiRisk: boolean };
