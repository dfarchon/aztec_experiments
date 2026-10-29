// Explicit browser/CLI surface. Keep Aztec dependencies pinned together.
export { AccountManager, DeployAccountMethod } from '@aztec-labs/aztec.js/wallet';
export { AztecAddress, EthAddress, CompleteAddress } from '@aztec-labs/aztec.js/addresses';
export { BarretenbergSync } from '@aztec-foundation/bb.js';
export { BaseWallet } from '@aztec-labs/wallet-sdk/base-wallet';
export { WalletManager } from '@aztec-labs/wallet-sdk/manager';
export { hashToEmoji } from '@aztec-labs/wallet-sdk/crypto';
export { BatchCall, Contract, ContractFunctionInteraction, DeployMethod, NO_WAIT,
  getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
export { NO_FROM } from '@aztec-labs/aztec.js/account';
export { Capsule, ExecutionPayload, HashedValues, TxExecutionRequest, TxHash } from '@aztec-labs/aztec.js/tx';
export { TxContext } from '@aztec-labs/stdlib/tx';
export { EventSelector, FunctionCall, FunctionSelector, FunctionType, encodeArguments, loadContractArtifact } from '@aztec-labs/aztec.js/abi';
export { getPublicEvents } from '@aztec-labs/aztec.js/events';
export { FeeJuicePaymentMethodWithClaim, SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
export { Fq, Fr } from '@aztec-labs/aztec.js/fields';
export { Gas, GasFees, GasSettings } from '@aztec-labs/stdlib/gas';
export { MerkleTreeId } from '@aztec-labs/aztec.js/trees';
export { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
export const FeeJuiceAddress = ProtocolContractAddress.FeeJuice;
export { FeeJuiceArtifact } from '@aztec-labs/protocol-contracts/fee-juice';
export { SchnorrAccountContract, SchnorrAccountContractArtifact, SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact, getSchnorrAccountContractAddress,
  getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
export { computeFeeJuiceMessageNullifier, computeFeeJuiceMessageNullifier as computeL1ToL2MessageNullifier,
  getNonNullifiedL1ToL2MessageWitness } from '@aztec-labs/stdlib/messaging';
export { computePartialAddress } from '@aztec-labs/stdlib/contract';
export { computeSecretHash, siloNullifier } from '@aztec-labs/stdlib/hash';
import { createAztecNodeClient as createNodeClient } from '@aztec-labs/aztec.js/node';
export { waitForNode, waitForTx } from '@aztec-labs/aztec.js/node';
// Public testnet RPC allows at most three calls in a JSON-RPC batch.
export function createAztecNodeClient(url, options = {}) {
  return createNodeClient(url, { maxBatchSize: 3, ...options });
}
export { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
export { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { AztecIndexedDBStore } from '@aztec-labs/kv-store/deprecated/indexeddb';
import { createLogger } from '@aztec-labs/foundation/log';
// Preserve the existing browser/CLI storage API without opening old-version stores.
// Callers provide a rollup-specific prefix; include the SDK version as well.
export function createIndexedDBStore(name, config) {
  if (!config.rollupAddress || config.l1ChainId == null) throw new Error('PXE store requires a chain ID and rollup address');
  const namespace = `${config.dataDirectory ?? 'billboard'}/${SDK_VERSION}/${config.l1ChainId}/${config.rollupAddress}/${name}`;
  return AztecIndexedDBStore.open(createLogger('billboard:indexeddb'), namespace, false);
}
import { createPXE as createBundledPXE } from '@aztec-labs/pxe/client/bundle';
import { initializeNoirRuntime } from './noir-runtime.mjs';
export { initializeNoirRuntime };
export async function createPXE(...args) {
  await initializeNoirRuntime();
  return createBundledPXE(...args);
}
export { deriveKeys, deriveKeysFromMasterSecretKeys, deriveMasterMessageSigningSecretKey,
  deriveMasterMessageSigningSecretKey as deriveSigningKey } from '@aztec-labs/stdlib/keys';
export { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
export { poseidon2Hash, poseidon2HashBytes, poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
export { sha256ToField } from '@aztec-labs/foundation/crypto/sha256';
export const SDK_VERSION = '6.0.0';
