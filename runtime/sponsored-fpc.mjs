// Read the deployed instance instead of guessing its salt or deployer. No balance monitoring.
export async function resolveSponsoredFpc(node, sdk, artifact, address) {
  const instance = await node.getContract(
    sdk.AztecAddress.fromStringUnsafe(address)
  );
  if (
    !instance ||
    instance.address.toString().toLowerCase() !== address.toLowerCase()
  )
    throw new Error("Sponsored FPC is not deployed at the configured address");
  const expected = await sdk.getContractClassFromArtifact(artifact);
  if (instance.currentContractClassId.toString() !== expected.id.toString())
    throw new Error("Sponsored FPC class does not match the pinned artifact");
  return instance;
}
