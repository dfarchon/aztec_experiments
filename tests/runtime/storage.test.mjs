import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "@aztec-labs/foundation/log";
import { AztecIndexedDBStore } from "@aztec-labs/kv-store/deprecated/indexeddb";

import { indexedDBStoreNamespace } from "../../runtime/storage.mjs";

const config = {
  dataDirectory: `notch-storage-${Date.now()}`,
  l1ChainId: 31337,
  rollupAddress: "0x01",
};

test("PXE storage namespaces include the version, chain, rollup and data directory", () => {
  assert.equal(
    indexedDBStoreNamespace("pxe_data", config, "6.0.0"),
    `${config.dataDirectory}/6.0.0/31337/0x01/pxe_data`
  );
  assert.throws(
    () => indexedDBStoreNamespace("pxe_data", {}, "6.0.0"),
    /chain ID and rollup/
  );
  assert.equal(
    indexedDBStoreNamespace(
      "pxe_data",
      { ...config, l1ChainId: 31338 },
      "6.0.0"
    ),
    `${config.dataDirectory}/6.0.0/31338/0x01/pxe_data`
  );
});

test("IndexedDB storage persists and isolates another chain", async (t) => {
  const logger = createLogger("notch:storage-test");
  const store = await AztecIndexedDBStore.open(
    logger,
    indexedDBStoreNamespace("pxe", config, "6.0.0"),
    false
  );
  await store.openSingleton("smoke").set("persisted");
  await store.close();
  const reopened = await AztecIndexedDBStore.open(
    logger,
    indexedDBStoreNamespace("pxe", config, "6.0.0"),
    false
  );
  assert.equal(await reopened.openSingleton("smoke").getAsync(), "persisted");
  const isolated = await AztecIndexedDBStore.open(
    logger,
    indexedDBStoreNamespace("pxe", { ...config, l1ChainId: 31338 }, "6.0.0"),
    false
  );
  assert.equal(await isolated.openSingleton("smoke").getAsync(), undefined);
  t.after(async () => {
    await reopened.delete();
    await isolated.delete();
  });
});
