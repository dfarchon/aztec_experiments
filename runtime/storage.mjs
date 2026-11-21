export function indexedDBStoreNamespace(name, config, sdkVersion) {
  if (!config.rollupAddress || config.l1ChainId == null)
    throw new Error("PXE store requires a chain ID and rollup address");
  return `${config.dataDirectory ?? "billboard"}/${sdkVersion}/${config.l1ChainId}/${config.rollupAddress}/${name}`;
}
