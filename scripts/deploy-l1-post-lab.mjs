// Isolated deployment: leaves the running board and its UI manifest intact.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { ContractFactory, JsonRpcProvider, keccak256 } from 'ethers';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { getFeeJuiceBalance } from '@aztec-labs/aztec.js/utils';
import { getBillboardFeeOptions } from '../shared/df-billboard.mjs';
import { syncLocalClock } from './sync-df-clock.mjs';

const root = new URL('../', import.meta.url);
const base = JSON.parse(fs.readFileSync(new URL('apps/dist/df-local.json', root)));
for (const value of [base.nodeUrl, base.l1.rpcUrl]) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
}
const node = createAztecNodeClient(base.nodeUrl);
const info = await node.getNodeInfo();
assert.equal(info.nodeVersion, '6.0.0-rc.3');
assert.equal(info.l1ChainId, 31337);
assert.equal(info.realProofs, false);
const addresses = await node.getL1ContractAddresses();
assert.equal(addresses.rollupAddress.toString(), base.rollupAddress);
await syncLocalClock(node, createAztecNodeDebugClient(base.nodeUrl), base);
const rpc = new JsonRpcProvider(base.l1.rpcUrl, undefined, { cacheTimeout: -1 });
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
try {
  assert.equal((await rpc.getNetwork()).chainId, 31337n);
  const [account] = await getInitialTestAccountsData();
  await wallet.createSchnorrInitializerlessAccount(account.secret, account.salt, account.signingKey);
  const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
  await wallet.registerContract(sponsor, SponsoredFPCContract.artifact);
  assert((await getFeeJuiceBalance(sponsor.address, node)) > 0n, 'Sponsor depleted');
  const solidity = JSON.parse(fs.readFileSync(new URL('.local/billboard-l1-out/BillboardInbox.sol/BillboardInbox.json', root)));
  const entry = await new ContractFactory(solidity.abi, solidity.bytecode.object, await rpc.getSigner(0))
    .deploy(base.rollupAddress, info.rollupVersion);
  await entry.waitForDeployment();
  const entryAddress = await entry.getAddress();
  const raw = fs.readFileSync(new URL('df-billboard/target/df_billboard-DFBillboard.json', root));
  const artifact = loadContractArtifact(JSON.parse(raw));
  const deployed = await Contract.deploy(wallet, artifact, [EthAddress.fromString(entryAddress)], 'constructor_with_inbox').send({
    from: account.address,
    fee: await getBillboardFeeOptions(node, new SponsoredFeePaymentMethod(sponsor.address), GasFees),
  });
  assert.equal(String(deployed.receipt.executionResult), 'success');
  const config = {
    kind: 'local-sponsored-l1-post', nodeUrl: base.nodeUrl,
    rollupAddress: base.rollupAddress, rollupVersion: String(info.rollupVersion),
    board: deployed.contract.address.toString(), sponsoredFpc: sponsor.address.toString(), sponsorSalt: '0',
    l1: { chainId: 31337, rpcUrl: base.l1.rpcUrl, entry: entryAddress,
      inbox: addresses.inboxAddress.toString(), runtimeCodeHash: keccak256(await rpc.getCode(entryAddress)) },
  };
  fs.writeFileSync(new URL('.local/l1-post-lab.json', root), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(new URL('apps/dist/df-l1-post-lab.json', root), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(new URL('apps/dist/df-l1-post-artifact.json', root), raw);
  console.log(JSON.stringify(config, null, 2));
} finally { await wallet.stop(); rpc.destroy(); }
