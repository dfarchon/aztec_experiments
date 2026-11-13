import { AI_CACHE_NAME, AI_MODEL_VERSION, safetyResult } from "./ai-config.ts";
import { parseKeywords } from "./keywords.ts";
import type { BillboardView, PostData } from "./types";

export function createReadingController({
  getView,
  getPosts,
  getDeployment,
  isBusy,
  patch,
  savePreferences,
  publishPosts,
}: {
  getView(): BillboardView;
  getPosts(): PostData[];
  getDeployment(): { rollupAddress: string; board: string } | undefined;
  isBusy(): boolean;
  patch(value: Partial<BillboardView>): void;
  savePreferences(): void;
  publishPosts(): void;
}) {
  let disposed = false;
  let aiWorker: Worker | undefined;
  let aiRequestId = 0,
    aiGeneration = 0;
  let aiNeedsRun = false;
  type Result = { scores: Record<string, number> };
  const aiPending = new Map<
    number,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve(value: Result[]): void;
      reject(error: Error): void;
    }
  >();
  const AI_REQUEST_TIMEOUT_MS = 600_000;
  function disposeAiWorker(reason: string) {
    if (aiWorker) aiWorker.terminate();
    aiWorker = undefined;
    for (const pending of aiPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    aiPending.clear();
  }

  function pauseAiHints() {
    if (!getView().aiHints) return;
    aiGeneration++;
    aiNeedsRun = true;
    disposeAiWorker("AI analysis paused");
    patch({
      aiProgress: null,
      aiStatus:
        "AI analysis paused until the current onchain operation finishes.",
    });
  }

  function getAiWorker() {
    if (aiWorker) return aiWorker;
    // Replaced by the harness build, so an old cached runtime cannot survive an upgrade.
    const worker = new Worker(
      "/df-toxicity.worker.js?v=" + __DF_TOXICITY_WORKER_HASH__,
      { type: "module" }
    );
    worker.onmessage = (event) => {
      if (aiWorker !== worker) return;
      const { id, results, progress, error } = event.data || {};
      const pending = aiPending.get(id);
      if (!pending) return;
      if (progress) {
        const total = Number(progress.total),
          loaded = Number(progress.loaded);
        const percent =
          total > 0 && Number.isFinite(loaded)
            ? Math.min(100, Math.max(0, (loaded / total) * 100))
            : undefined;
        patch({
          aiProgress: { percent },
          aiStatus:
            progress.status === "ready"
              ? "Model ready. Analyzing locally…"
              : `Loading the English/Chinese model: ${progress.file || "Initializing runtime"}${percent === undefined ? "" : ` · ${percent.toFixed(0)}%`}. Disable AI to cancel.`,
        });
        return;
      }
      aiPending.delete(id);
      clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error));
      else pending.resolve(results);
    };
    worker.onerror = (event) => {
      if (aiWorker === worker)
        disposeAiWorker(event.message || "AI worker failed");
    };
    worker.onmessageerror = () => {
      if (aiWorker === worker)
        disposeAiWorker("AI worker returned unreadable data");
    };
    aiWorker = worker;
    return worker;
  }

  function classifyWithAi(texts: string[]): Promise<Result[]> {
    return new Promise<Result[]>((resolve, reject) => {
      const id = ++aiRequestId;
      const timer = setTimeout(() => {
        if (aiPending.has(id))
          disposeAiWorker(
            "Model loading or analysis timed out. Disable and re-enable AI filtering to retry."
          );
      }, AI_REQUEST_TIMEOUT_MS);
      aiPending.set(id, { resolve, reject, timer });
      try {
        getAiWorker().postMessage({ id, texts });
      } catch (error) {
        clearTimeout(timer);
        aiPending.delete(id);
        reject(error);
      }
    });
  }

  function aiCacheKey() {
    return `df-signal:ai:${getDeployment()!.rollupAddress}:${getDeployment()!.board}:${AI_MODEL_VERSION}`;
  }

  function readAiCache() {
    try {
      const value = JSON.parse(localStorage.getItem(aiCacheKey()) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }

  function saveAiCache(
    cache: Record<string, { hash: string; scores: Record<string, number> }>
  ) {
    try {
      const ids = Object.keys(cache);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500)))
        delete cache[id];
      localStorage.setItem(aiCacheKey(), JSON.stringify(cache));
    } catch {
      /* Storage can be unavailable; in-memory results still work. */
    }
  }

  async function contentHash(text: string) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function runAiHints() {
    if (disposed || !getView().aiHints || !getDeployment() || isBusy()) return;
    aiNeedsRun = false;
    const generation = ++aiGeneration;
    const posts = getPosts().filter(
      (post) => typeof post.text === "string" && post.text.trim()
    );
    if (!posts.length) {
      patch({ aiStatus: "No posts to analyze." });
      return;
    }
    patch({ aiStatus: "Checking the local AI classification cache…" });
    const cache = readAiCache();
    const missing = [];
    try {
      for (const post of posts) {
        const hash = await contentHash(post.text!);
        if (generation !== aiGeneration) return;
        const cached = cache[post.id];
        let validCache = false;
        if (cached?.hash === hash && cached.scores) {
          try {
            const checked = safetyResult(
              Object.entries(cached.scores).map(([label, score]) => ({
                label,
                score: score as number,
              }))
            );
            post.aiLabels = checked.labels;
            post.aiAnalyzed = true;
            validCache = true;
          } catch {
            /* Corrupt result cache is reclassified, never treated as safe. */
          }
        }
        if (!validCache) missing.push({ post, hash });
      }
      publishPosts();
      for (let offset = 0; offset < missing.length; offset += 4) {
        if (generation !== aiGeneration) return;
        const batch = missing.slice(offset, offset + 4);
        patch({
          aiStatus: `Experimental AI analysis: ${Math.min(offset + batch.length, missing.length)}/${missing.length} posts. First use requires a model download.`,
        });
        const results = await classifyWithAi(
          batch.map((entry) => entry.post.text!)
        );
        if (generation !== aiGeneration) return;
        if (!Array.isArray(results) || results.length !== batch.length)
          throw new Error("Unexpected number of AI classification results");
        const checked = results.map((entry) =>
          safetyResult(
            Object.entries(entry.scores || {}).map(([label, score]) => ({
              label,
              score,
            }))
          )
        );
        batch.forEach((entry, index) => {
          entry.post.aiLabels = checked[index].labels;
          entry.post.aiAnalyzed = true;
          cache[entry.post.id] = {
            hash: entry.hash,
            scores: checked[index].scores,
          };
        });
        saveAiCache(cache);
        publishPosts();
      }
      patch({
        aiProgress: null,
        aiStatus: `AI analyzed ${posts.length} posts (${missing.length} newly analyzed). Flagged posts move to Filtered; unflagged does not mean safe.`,
      });
    } catch (error) {
      if (generation !== aiGeneration) return;
      disposeAiWorker("AI analysis failed");
      patch({
        aiProgress: null,
        aiStatus: `AI filtering unavailable: ${error instanceof Error ? error.message : String(error)}. Unreviewed posts remain visible. Keywords and basic rules still work.`,
      });
      console.error("AI classification failed", error);
    }
  }

  function setAiHints(enabled: boolean) {
    if (
      typeof enabled !== "boolean" ||
      (enabled && (isBusy() || getView().aiClearing))
    )
      return;
    if (enabled && getView().aiHints && aiPending.size) return;
    if (enabled && !getView().aiConsentGiven) {
      patch({ aiConsentOpen: true });
      return;
    }
    patch({
      aiHints: enabled,
      aiConsentOpen: false,
      ...(enabled
        ? { aiStatus: "AI enabled. Waiting to load public posts." }
        : {}),
    });
    savePreferences();
    if (enabled) void runAiHints();
    else {
      aiGeneration++;
      aiNeedsRun = false;
      disposeAiWorker("AI filtering disabled");
      patch({ aiProgress: null, aiStatus: "AI filtering is off" });
    }
  }
  function confirmAiHints() {
    if (isBusy() || getView().aiClearing) return;
    patch({ aiConsentGiven: true });
    setAiHints(true);
  }
  function saveKeywords(text: string) {
    try {
      patch({ keywords: parseKeywords(text), keywordError: "" });
      savePreferences();
      return true;
    } catch (error) {
      patch({
        keywordError: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  async function clearAiCache() {
    if (getView().aiClearing) return;
    setAiHints(false);
    patch({ aiClearing: true, aiConsentGiven: false });
    savePreferences();
    for (const post of getPosts()) {
      delete post.aiLabels;
      delete post.aiAnalyzed;
    }
    publishPosts();
    try {
      if (typeof caches !== "undefined") await caches.delete(AI_CACHE_NAME);
      if (getDeployment()) localStorage.removeItem(aiCacheKey());
      patch({
        aiStatus:
          "Model and board classification caches cleared. Enabling AI again will reload the model.",
      });
    } catch (error) {
      patch({
        aiStatus: `Cache clearing incomplete: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      patch({ aiClearing: false });
    }
  }

  return {
    pauseAiHints,
    runAiHints,
    setAiHints,
    confirmAiHints,
    saveKeywords,
    clearAiCache,
    resume() {
      if (aiNeedsRun && getView().aiHints) void runAiHints();
    },
    dispose() {
      disposed = true;
      aiGeneration++;
      aiNeedsRun = false;
      disposeAiWorker("Page closed");
    },
  };
}
