import {
  FetchRequest,
  type JsonRpcPayload,
  JsonRpcProvider,
  type JsonRpcResult,
} from "ethers";

// Explicit allowlist: sending transactions, signing and filter mutations never retry.
const reads = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);

function isRateLimited(value: unknown, depth = 0): boolean {
  if (depth > 5 || value == null) return false;
  if (typeof value === "string")
    return /too many requests|rate.?limit|requests per second|credits per second/i.test(
      value
    );
  if (Array.isArray(value))
    return value.some((item) => isRateLimited(item, depth + 1));
  if (typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (
    [entry.status, entry.statusCode, entry.code].some(
      (code) => Number(code) === 429
    )
  )
    return true;
  return ["message", "shortMessage", "error", "info", "response", "value"].some(
    (key) => isRateLimited(entry[key], depth + 1)
  );
}

const cancelled = () =>
  Object.assign(new Error("L1 read cancelled"), { code: "CANCELLED" });
const busy = () =>
  Object.assign(new Error("L1 network is busy. Please try again shortly."), {
    code: "L1_RATE_LIMIT",
  });
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Pending {
  promise: Promise<JsonRpcResult>;
  consumers: (() => boolean)[];
}

// One queue per endpoint, shared even by short-lived balance/receipt providers.
export class L1ReadQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private nextStart = 0;
  private interval: number;
  private retryBase: number;
  private random: () => number;

  constructor({ interval = 200, retryBase = 1000, random = Math.random } = {}) {
    this.interval = interval;
    this.retryBase = retryBase;
    this.random = random;
  }

  request(
    payload: JsonRpcPayload,
    send: () => Promise<JsonRpcResult[]>,
    active: () => boolean
  ) {
    const key = JSON.stringify(
      [payload.method, payload.params],
      (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            )
          : value
    );
    let entry = this.pending.get(key);
    if (!entry) {
      const consumers = [active];
      const alive = () => consumers.some((consumer) => consumer());
      const run = async () => {
        for (let attempt = 0; ; attempt++) {
          if (!alive()) throw cancelled();
          await sleep(Math.max(0, this.nextStart - Date.now()));
          if (!alive()) throw cancelled();
          this.nextStart = Date.now() + this.interval;
          try {
            const result = await send();
            // Some rate-limited gateways return an error without a JSON-RPC id.
            if (isRateLimited(result)) throw busy();
            const response = result.find((item) => item.id === payload.id);
            if (!response)
              throw new Error(
                "L1 RPC returned an incomplete response. Please try again."
              );
            return response;
          } catch (error) {
            if (
              !isRateLimited(error) &&
              (error as { code?: string })?.code !== "L1_RATE_LIMIT"
            )
              throw error;
            if (!alive()) throw cancelled();
            if (attempt === 3) throw busy();
            // Shared cooldown prevents other queued reads from continuing the burst.
            const delay =
              this.retryBase * 2 ** attempt +
              (this.random() * this.retryBase) / 4;
            this.nextStart = Math.max(this.nextStart, Date.now() + delay);
          }
        }
      };
      const promise = this.tail.then(run);
      this.tail = promise.catch(() => {});
      entry = { promise, consumers };
      this.pending.set(key, entry);
      const remove = () => this.pending.delete(key);
      void promise.then(remove, remove);
    } else {
      entry.consumers.push(active);
    }
    // Sharing a transport result must not share the original caller's RPC id.
    return entry.promise.then((response) => {
      if (!active()) throw cancelled();
      return { ...response, id: payload.id };
    });
  }
}

const queues = new Map<string, L1ReadQueue>();

export class L1ReadProvider extends JsonRpcProvider {
  private queue: L1ReadQueue;

  constructor(url: string) {
    const connection = new FetchRequest(url);
    // The queue owns bounded retries, including HTTP 429; disable ethers' hidden retries.
    connection.retryFunc = async () => false;
    connection.timeout = 10_000;
    super(connection, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    let queue = queues.get(url);
    if (!queue) {
      queue = new L1ReadQueue();
      queues.set(url, queue);
    }
    this.queue = queue;
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[]
  ): Promise<JsonRpcResult[]> {
    const requests = Array.isArray(payload) ? payload : [payload];
    return Promise.all(
      requests.map(async (request) => {
        if (!reads.has(request.method)) {
          // Non-read methods are neither merged nor retried.
          return (await super._send(request))[0];
        }
        return this.queue.request(
          request,
          () => super._send(request),
          () => !this.destroyed
        );
      })
    );
  }
}
