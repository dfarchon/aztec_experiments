// @ts-nocheck -- Transformers' browser pipeline types do not model this worker's multi-label output.
import { env, pipeline } from "@huggingface/transformers";

import {
  AI_CACHE_NAME,
  AI_MODEL,
  AI_REVISION,
  safetyResult,
} from "./ai-config.ts";

env.allowLocalModels = false;
env.useBrowserCache = false;
// An app-owned cache can be removed without touching wallet/game storage.
env.useCustomCache = typeof caches !== "undefined";
env.customCache = {
  async match(key) {
    try {
      return await (await caches.open(AI_CACHE_NAME)).match(key);
    } catch {
      return undefined;
    }
  },
  async put(key, response) {
    try {
      await (await caches.open(AI_CACHE_NAME)).put(key, response);
    } catch {
      /* Full storage: inference still works. */
    }
  },
};
env.backends.onnx.wasm.wasmPaths = new URL("./onnx/", self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let modelPromise;
let queue = Promise.resolve();

async function getModel(id) {
  if (!modelPromise) {
    modelPromise = pipeline("text-classification", AI_MODEL, {
      revision: AI_REVISION,
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress) =>
        self.postMessage({
          id,
          progress: {
            status: progress.status,
            file: progress.file,
            loaded: progress.loaded,
            total: progress.total,
            progress: progress.progress,
          },
        }),
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function classify(id, texts) {
  try {
    const model = await getModel(id);
    if (model.model.config.problem_type !== "multi_label_classification")
      throw new Error("模型不支持预期的多标签分类");
    const results = [];
    // Short posts, one at a time: avoid padded large batches while DF is mining.
    for (const text of texts) {
      const predictions = await model(text, { top_k: null });
      results.push(safetyResult(predictions));
    }
    self.postMessage({ id, results });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
}

self.onmessage = (event) => {
  const { id, texts } = event.data || {};
  if (
    !Number.isInteger(id) ||
    !Array.isArray(texts) ||
    texts.length < 1 ||
    texts.length > 8 ||
    texts.some(
      (text) =>
        typeof text !== "string" || new TextEncoder().encode(text).length > 512
    )
  )
    return;
  queue = queue.then(() => classify(id, texts));
};
