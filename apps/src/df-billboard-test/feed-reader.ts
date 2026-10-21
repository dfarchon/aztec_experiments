import { decodeDFMessage } from "../../../shared/df-billboard.mjs";
import type { RequestSDK } from "./l1-request-core";
import type { PostData } from "./types";

export const POST_PAGE_SIZE = 10;
const RPC_CONCURRENCY = 8;
const CACHE_POSTS = 100;
type Node = ReturnType<RequestSDK["createAztecNodeClient"]>;
type Field = InstanceType<RequestSDK["Fr"]>;
type Layout = Record<
  "post_count" | "post_lengths" | "post_data",
  { slot: Field }
>;
export interface FeedCursor {
  block: Awaited<ReturnType<Node["getBlockNumber"]>>;
  total: number;
  before: number;
}
async function mapLimited<T, R>(
  items: T[],
  read: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let next = 0,
    failed = false,
    error: unknown;
  await Promise.all(
    Array.from(
      { length: Math.min(RPC_CONCURRENCY, items.length) },
      async () => {
        while (!failed && next < items.length) {
          const index = next++;
          try {
            results[index] = await read(items[index]);
          } catch (cause) {
            failed = true;
            error = cause;
          }
        }
      }
    )
  );
  // Drain in-flight reads before rejecting, so retries cannot pile up requests.
  if (failed) throw error;
  return results;
}

export function createFeedReader() {
  const cache = new Map<string, PostData>();
  let previousNode: Node | undefined;
  return (
    sdk: RequestSDK,
    node: Node,
    board: string,
    layout: Layout,
    cursor?: FeedCursor
  ) => {
    if (node !== previousNode) {
      cache.clear();
      previousNode = node;
    }
    return readPostPage(sdk, node, board, layout, cursor, cache);
  };
}
// All pages use the same snapshot. The caller only commits the returned cursor
// after a successful read, so failed pages can be retried without gaps.
export async function readPostPage(
  sdk: RequestSDK,
  node: Node,
  board: string,
  layout: Layout,
  cursor?: FeedCursor,
  cache = new Map<string, PostData>()
) {
  const address = sdk.AztecAddress.fromStringUnsafe(board);
  const block = cursor?.block ?? (await node.getBlockNumber());
  const read = (slot: Field) => node.getPublicStorageAt(block, address, slot);
  const total =
    cursor?.total ?? Number((await read(layout.post_count.slot)).toBigInt());
  const before = cursor?.before ?? total;
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isInteger(before) ||
    before < 0 ||
    before > total
  )
    throw new Error("Invalid post count or cursor");
  const start = Math.max(0, before - POST_PAGE_SIZE);
  const ids = Array.from(
    { length: before - start },
    (_, index) => start + index
  );
  const key = (id: number) => `${board}:${block}:${id}`;
  const missing = ids.filter((id) => !cache.has(key(id)));
  const lengths = await mapLimited(missing, async (id) =>
    Number(
      (
        await read(
          await sdk.deriveStorageSlotInMap(
            layout.post_lengths.slot,
            new sdk.Fr(BigInt(id))
          )
        )
      ).toBigInt()
    )
  );
  const fields = await mapLimited(
    missing.flatMap((id) => Array.from({ length: 17 }, (_, i) => id * 17 + i)),
    async (slot) =>
      read(
        await sdk.deriveStorageSlotInMap(
          layout.post_data.slot,
          new sdk.Fr(BigInt(slot))
        )
      )
  );
  missing.forEach((id, index) => {
    let post: PostData;
    try {
      post = {
        id,
        text: decodeDFMessage(
          fields.slice(index * 17, (index + 1) * 17),
          lengths[index]
        ),
      };
    } catch {
      post = { id, decodeError: true };
    }
    cache.set(key(id), post);
  });
  // Return copies: UI classification must never mutate cached chain data.
  const posts = ids.map((id) => ({ ...cache.get(key(id))! }));
  while (cache.size > CACHE_POSTS) cache.delete(cache.keys().next().value!);
  return { posts, cursor: { block, total, before: start } };
}
