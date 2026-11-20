import type { AztecRuntime } from "../../../../runtime/wallet-runtime.mjs";
import type { AccountKeys } from "./account-keys.ts";
import type { InjectedProvider } from "./l1.ts";

export interface L1StakeDeployment {
  chainId: number;
  rpcUrl: string;
  portal: string;
  inbox: string;
  runtimeCodeHash: string;
  deploymentBlock?: number;
}

export interface NotchDeployment {
  kind: "notch-stake";
  schemaVersion: 2;
  environment?: "local" | "testnet";
  nodeUrl: string;
  rollupAddress: string;
  rollupVersion: string | number;
  board: string;
  boardClassId: string;
  boardArtifactHash: string;
  sponsoredFpc: string;
  sponsorSalt: string;
  l1Stake: L1StakeDeployment;
}

export interface DepositRecord {
  amount: string;
  secret: string;
  secretHash: string;
  submitted: boolean;
  l1Tx: string | null;
  l2Tx: string | null;
  l2Attempted: boolean;
  messageKey?: string;
  leafIndex?: string;
  nonce?: number;
  recovered?: boolean;
}

export interface ExitRecord {
  amount: string;
  l1Tx: string | null;
  l2Tx: string | null;
  l2Attempted: boolean;
}

export interface WalletAccountRecord extends Partial<AccountKeys> {
  payer: string;
  amount: string;
  stakeChoice: string;
  remaining?: number | null;
  lastPost?: string;
  setupComplete?: boolean;
  importedAmountHint?: string | null;
  address?: string;
  keyDerivation?: "l1-signature-v1";
  recoveryAmount?: string;
  recoveryDeposits?: DepositRecord[];
  deposit?: DepositRecord | null;
  exit?: ExitRecord | null;
}

export interface WalletSessionPreference {
  walletId: string;
  walletName: string;
  payer: string;
}

export interface WalletStakeState {
  available: boolean;
  payer: string;
  owner: string;
  aztecReady: boolean;
  setupComplete: boolean;
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
}

export interface AccountBackup {
  filename: string;
  contents: string;
}

export interface ImportedAccount {
  keyDerivation?: "l1-signature-v1";
  recoveryAmount?: string;
  recoveryDeposits?: DepositRecord[];
  keys?: AccountKeys;
  address?: string;
  amountHint: string;
  deposit: DepositRecord | null;
  exit: ExitRecord | null;
}

export interface WalletFlow {
  connect(
    provider: InjectedProvider,
    session?: Pick<WalletSessionPreference, "payer">
  ): Promise<boolean | void>;
  disconnect(): Promise<void>;
  dispose(): void;
  selectStakeAmount(amount: string): void;
  initializeAztec(runtime: AztecRuntime): Promise<boolean | string | void>;
  stake(amount: string, onSubmitted?: () => void): Promise<boolean | string>;
  resume(): Promise<boolean | string>;
  recoverDeposit(hash: string): Promise<void>;
  recoverClaim(hash: string): Promise<void>;
  recoverAccount(): Promise<boolean>;
  withdraw(): Promise<void>;
  resumeExit(): Promise<void>;
  recoverExit(hash: string): Promise<void>;
  post(message: string): Promise<string>;
  restore(file: File, runtime: AztecRuntime): Promise<boolean>;
  backup(): AccountBackup | null;
}

export type StakeListener = (state: WalletStakeState) => void;
export type WalletProgress = (label: string) => void;
