import type { RequestView } from "./request-view";

export type KeywordMode = "contains" | "word";
export type RuleCategory =
  | "promotion"
  | "credential-request"
  | "token-claim-link"
  | "adult-solicitation"
  | "repeated-solicitation";
export type WalletMode =
  | "local"
  | "create"
  | "import"
  | "extension"
  | "metamask";
export interface PostData {
  id: number | string;
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
  walletMode: WalletMode;
  savedAccount: string;
  accountLabel: string;
  accountFile: File | null;
  provider: string;
  message: string;
  rulesEnabled: boolean;
  keywordEnabled: boolean;
  keywordMode: KeywordMode;
}
export interface BillboardView extends EditableFields {
  request: RequestView;
  busy: boolean;
  connecting: boolean;
  posting: boolean;
  connected: boolean;
  address: string;
  canRead: boolean;
  canPost: boolean;
  hasLocalAccount: boolean;
  walletOpen: boolean;
  fileVersion: number;
  savedAccounts: { address: string; label: string }[];
  providers: { id: string; name: string }[];
  pendingConnection: boolean;
  verification: boolean;
  emoji: string;
  grantedAccounts: { value: string; label: string }[];
  grantedAccount: string;
  deployment: {
    nodeUrl: string;
    board: string;
    sponsoredFpc: string;
    l1?: { rpcUrl: string; publisher: string };
  } | null;
  progress: Progress | null;
  actionError: { label: string; message: string; guidance: string } | null;
  extensionStatus: string;
  copied: boolean;
  logs: { id: number; message: string; type: string; time: string }[];
  posts: PostData[];
  feedLoaded: boolean;
  feedLoading: boolean;
  totalPosts: number;
  hasOlderPosts: boolean;
  feedRevision: number;
  aiHints: boolean;
  aiStatus: string;
  keywords: string[];
  keywordError: string;
  aiConsentGiven: boolean;
  aiConsentOpen: boolean;
  aiProgress: { percent?: number } | null;
  aiClearing: boolean;
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
  setAiHints(enabled: boolean): void;
  confirmAiHints(): void;
  clearAiCache(): Promise<void>;
  saveKeywords(text: string): boolean;
  copyAddress(): Promise<void>;
  accountBackup(): { filename: string; contents: string } | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  resumeRequest(hash?: string): Promise<void>;
  scan(): Promise<void>;
  confirmWallet(): Promise<void>;
  cancelWallet(): void;
  selectGrantedAccount(value: string): Promise<void>;
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
