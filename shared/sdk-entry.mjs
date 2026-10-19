// Explicit browser/CLI surface. Keep Aztec dependencies pinned together.
export { AccountManager, DeployAccountMethod } from '@aztec/aztec.js/wallet';
export { AztecAddress, EthAddress, CompleteAddress } from '@aztec/aztec.js/addresses';
export { BarretenbergSync } from '@aztec/bb.js';
export { BaseWallet } from '@aztec/wallet-sdk/base-wallet';
export { WalletManager } from '@aztec/wallet-sdk/manager';
export { hashToEmoji } from '@aztec/wallet-sdk/crypto';
export { BatchCall, Contract, ContractFunctionInteraction, DeployMethod, NO_WAIT,
  getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
export { NO_FROM } from '@aztec/aztec.js/account';
export { Capsule, ExecutionPayload, HashedValues, TxExecutionRequest, TxHash } from '@aztec/aztec.js/tx';
export { TxContext } from '@aztec/stdlib/tx';
export { EventSelector, FunctionCall, FunctionSelector, FunctionType, encodeArguments, loadContractArtifact } from '@aztec/aztec.js/abi';
export { getPublicEvents } from '@aztec/aztec.js/events';
export { FeeJuicePaymentMethodWithClaim, SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
export { Fq, Fr } from '@aztec/aztec.js/fields';
export { Gas, GasFees, GasSettings } from '@aztec/stdlib/gas';
export { MerkleTreeId } from '@aztec/aztec.js/trees';
export { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
export const FeeJuiceAddress = ProtocolContractAddress.FeeJuice;
export { FeeJuiceArtifact } from '@aztec/protocol-contracts/fee-juice';
export { SchnorrAccountContract, SchnorrAccountContractArtifact, SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact, getSchnorrAccountContractAddress,
  getSchnorrInitializerlessAccountContractAddress } from '@aztec/accounts/schnorr';
export { computeFeeJuiceMessageNullifier, computeFeeJuiceMessageNullifier as computeL1ToL2MessageNullifier,
  getNonNullifiedL1ToL2MessageWitness } from '@aztec/stdlib/messaging';
export { computePartialAddress } from '@aztec/stdlib/contract';
export { computeSecretHash, siloNullifier } from '@aztec/stdlib/hash';
export { createAztecNodeClient, waitForNode, waitForTx } from '@aztec/aztec.js/node';
export { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
export { createAztecNodeDebugClient } from '@aztec/stdlib/interfaces/client';
import { AztecIndexedDBStore } from '@aztec/kv-store/deprecated/indexeddb';
import { createLogger } from '@aztec/foundation/log';
// Preserve the existing browser/CLI storage API without opening old-version stores.
// Callers provide a rollup-specific prefix; include the SDK version as well.
export function createIndexedDBStore(name, config) {
  if (!config.rollupAddress || config.l1ChainId == null) throw new Error('PXE store requires a chain ID and rollup address');
  const namespace = `${config.dataDirectory ?? 'billboard'}/5.0.1/${config.l1ChainId}/${config.rollupAddress}/${name}`;
  return AztecIndexedDBStore.open(createLogger('billboard:indexeddb'), namespace, false);
}
import { createPXE as createBundledPXE } from '@aztec/pxe/client/bundle';
import { initializeNoirRuntime } from './noir-runtime.mjs';
export { initializeNoirRuntime };
export async function createPXE(...args) {
  await initializeNoirRuntime();
  return createBundledPXE(...args);
}
export { deriveKeys, deriveKeysFromMasterSecretKeys, deriveMasterMessageSigningSecretKey,
  deriveMasterMessageSigningSecretKey as deriveSigningKey } from '@aztec/stdlib/keys';
export { deriveStorageSlotInMap } from '@aztec/stdlib/hash';
export { poseidon2Hash, poseidon2HashBytes, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
export { sha256ToField } from '@aztec/foundation/crypto/sha256';
export const SDK_VERSION = '5.0.1';
