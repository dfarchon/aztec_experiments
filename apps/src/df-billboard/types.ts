import type { InjectedProvider } from "./l1.ts";

export type RuleCategory =
  | "promotion"
  | "credential-request"
  | "token-claim-link"
  | "adult-solicitation"
  | "repeated-solicitation";
export interface PostData {
  id: number | string;
  publishedAt?: number;
  text?: string;
  decodeError?: boolean;
  adTier?: string;
  adReasons?: string[];
  ruleMatches?: RuleCategory[];
  keywordHits?: string[];
  aiLabels?: string[];
  aiAnalyzed?: boolean;
}
export interface Progress {
  label: string;
  completed: boolean;
  failed: boolean;
}
export interface EditableFields {
  message: string;
}
export interface BillboardView extends EditableFields {
  stake: {
    available: boolean;
    payer: string;
    owner: string;
    amount: string;
    pendingDeposit: boolean;
    depositPrepared: boolean;
    depositNeedsHash: boolean;
    claimNeedsHash: boolean;
    pendingExit: boolean;
    exitNeedsHash: boolean;
    backedUp: boolean;
    lastPost: string;
  };
  busy: boolean;
  connecting: boolean;
  posting: boolean;
  connected: boolean;
  canRead: boolean;
  canPost: boolean;
  walletOpen: boolean;
  deployment: {
    nodeUrl: string;
    board: string;
    sponsoredFpc: string;
    l1Stake: { rpcUrl: string; portal: string };
  } | null;
  progress: Progress | null;
  actionError: { label: string; message: string; guidance: string } | null;
  logs: { id: number; message: string; type: string; time: string }[];
  posts: PostData[];
  feedLoaded: boolean;
  feedLoading: boolean;
  totalPosts: number;
  hasOlderPosts: boolean;
  feedRevision: number;
}
export interface BillboardController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BillboardView;
  initialize(): Promise<void>;
  dispose(): void;
  log(message: unknown, type?: string): void;
  setField<K extends keyof EditableFields>(
    name: K,
    value: EditableFields[K]
  ): void;
  setWalletPanel(open: boolean): void;
  accountBackup(): { filename: string; contents: string } | null;
  connect(provider: InjectedProvider): Promise<void>;
  disconnect(): Promise<void>;
  resumeRequest(hash?: string, layer?: "l1" | "l2"): Promise<void>;
  deposit(amount: string): Promise<void>;
  withdrawStake(): Promise<void>;
  resumeWithdrawal(hash?: string): Promise<void>;
  importStakeBackup(file: File): Promise<void>;
  post(): Promise<void>;
  refresh(): Promise<void>;
  loadOlder(): Promise<void>;
}
export interface ViewProps {
  view: BillboardView;
  controller: BillboardController;
}
export type Category = "normal" | "advertising" | "toxic" | "policy";
export interface ReportRow {
  id: string;
  text: string;
  language: string;
  dataset: string;
  category: Category;
  keywordHits: string[];
  adTier: string;
  adReasons: string[];
  promotion: boolean;
  adFold: boolean;
  ruleMatches: RuleCategory[];
  ruleFold: boolean;
  aiRisk: boolean;
  aiLabels: string[];
}
export interface ReadingReport {
  available: true;
  generatedAt: string;
  ruleVersion: string;
  ai: {
    model: string;
    revision: string;
    decision: string;
    recordedAt: string;
    elapsedMs: number;
    workerSha256?: string;
  };
  exampleKeywords: string[];
  rows: ReportRow[];
  datasets: { name: string; count: number }[];
  duplicatePairs: number;
  summary: {
    category: Category;
    total: number;
    keyword: number;
    promotion: number;
    adFold: number;
    ruleFold: number;
    aiRisk: number;
  }[];
  sources?: { file: string; sha256: string }[];
}
