// Types for the lazily loaded browser/CLI Aztec runtime.
type AztecValue = any;

export interface AztecRuntimeSdk {
  [name: string]: AztecValue;
}

export interface AccountSetupOptions {
  secretKey: string;
  salt: string;
  signingKey: AztecValue;
  dataDirPrefix: string;
  proverEnabled: boolean;
  onProgress?(step: number, total: number, message: string): void;
  preProveHook?: (facts: {
    gasLimits: AztecValue;
    maxFee: bigint;
    feeOptions: AztecValue;
    teardownGasLimits: AztecValue;
  }) => Promise<void> | void;
}

export interface AztecRuntime extends AztecRuntimeSdk {
  sdk: AztecRuntimeSdk;
  createWallet(
    pxe: AztecValue,
    aztecNode: AztecValue,
    rawNode: AztecValue,
    options?: { preProveHook?: AccountSetupOptions["preProveHook"] }
  ): AztecValue;
  deriveAccountAddress(
    secretKey: string,
    salt: bigint,
    signingKey?: AztecValue
  ): Promise<{
    address: { toString(): string };
    [name: string]: AztecValue;
  }>;
  prepareProofEnvironment(): Promise<void>;
  setupAccount(
    state: Record<string, AztecValue>,
    options: AccountSetupOptions
  ): Promise<boolean>;
}

export function createAztecRuntime(
  sdk: AztecRuntimeSdk,
  config: {
    nodeUrl: string;
    onLog?(message: string, type?: string): void;
  }
): AztecRuntime;
