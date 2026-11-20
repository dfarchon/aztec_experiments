import type { InjectedProvider } from "../features/wallet/l1.ts";

export interface PostData {
  id: number | string;
  publishedAt?: number;
  text?: string;
  decodeError?: boolean;
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
    aztecReady: boolean;
    setupComplete: boolean;
    l1Amount: string | null;
    amount: string;
    stakeChoice: string;
    remaining: number | null;
    pendingDeposit: boolean;
    pendingAmount: string;
    depositL1Confirmed: boolean;
    depositPrepared: boolean;
    depositNeedsHash: boolean;
    claimNeedsHash: boolean;
    pendingExit: boolean;
    exitNeedsHash: boolean;
    lastPost: string;
  };
  busy: boolean;
  connecting: boolean;
  restoring: boolean;
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
  exportAccount(): { filename: string; contents: string } | null;
  connect(provider: InjectedProvider): Promise<void>;
  disconnect(): Promise<void>;
  resumeRequest(hash?: string, layer?: "l1" | "l2"): Promise<void>;
  initializeAztec(): Promise<void>;
  continueSetup(): Promise<void>;
  selectStakeAmount(amount: string): void;
  stake(amount: string): Promise<void>;
  withdrawStake(): Promise<void>;
  resumeWithdrawal(hash?: string): Promise<void>;
  post(): Promise<void>;
  refresh(): Promise<void>;
  loadOlder(): Promise<void>;
}
export interface ViewProps {
  view: BillboardView;
  controller: BillboardController;
}
