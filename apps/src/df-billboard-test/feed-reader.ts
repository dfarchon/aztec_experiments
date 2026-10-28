import { decodeDFMessage } from "../../../shared/df-billboard.mjs";
import type { PostData } from "./types";

export const POST_PAGE_SIZE = 10;
const RPC_CONCURRENCY = 8;
const CACHE_POSTS = 100;
export interface Field {
  toBigInt(): bigint;
  toString(): string;
}
export interface FeedSDK {
  Fr: new (value: bigint) => Field;
  AztecAddress: { fromStringUnsafe(value: string): { toString(): string } };
  deriveStorageSlotInMap(slot: Field, key: Field): Promise<Field>;
}
export interface FeedNode {
  getBlockNumber(): Promise<number>;
  getPublicStorageAt(
    block: number,
    address: { toString(): string },
    slot: Field
  ): Promise<Field>;
  getPublicStorageMany?(
    block: number,
    address: { toString(): string },
    slots: Field[]
  ): Promise<Field[]>;
}
export type Layout = Record<
  "post_count" | "post_lengths" | "post_data",
  { slot: Field }
>;
export interface FeedCursor {
  block: number;
  total: number;
  before: number;
}
type FeedProgress = (posts: PostData[], total: number) => void;
async function mapLimited<T, R>(
  items: T[],
  read: (item: T) => Promise<R>,
  concurrency = RPC_CONCURRENCY
): Promise<R[]> {
  const results: R[] = [];
  let next = 0,
    failed = false,
    error: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await read(items[index]);
        } catch (cause) {
          failed = true;
          error = cause;
        }
      }
    })
  );
  // Drain in-flight reads before rejecting, so retries cannot pile up requests.
  if (failed) throw error;
  return results;
}

export function createFeedReader() {
  const cache = new Map<string, PostData>();
  let previousNode: FeedNode | undefined;
  return (
    sdk: FeedSDK,
    node: FeedNode,
    board: string,
    layout: Layout,
    cursor?: FeedCursor,
    onProgress?: FeedProgress
  ) => {
    if (node !== previousNode) {
      cache.clear();
      previousNode = node;
    }
    return readPostPage(sdk, node, board, layout, cursor, cache, onProgress);
  };
}
// All pages use the same snapshot. The caller only commits the returned cursor
// after a successful read, so failed pages can be retried without gaps.
export async function readPostPage(
  sdk: FeedSDK,
  node: FeedNode,
  board: string,
  layout: Layout,
  cursor?: FeedCursor,
  cache = new Map<string, PostData>(),
  onProgress?: FeedProgress
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
    (_, index) => before - 1 - index
  );
  const key = (id: number) => `${board}:${block}:${id}`;
  const missing = ids.filter((id) => !cache.has(key(id)));
  let published = 0;
  function publishProgress() {
    if (!onProgress) return;
    const ready: PostData[] = [];
    // Emit only a complete newest-first prefix, even if batches finish out of order.
    for (const id of ids) {
      const post = cache.get(key(id));
      if (!post) break;
      ready.push({ ...post });
    }
    if (ready.length > published) {
      published = ready.length;
      onProgress(ready.reverse(), total);
    }
  }
  publishProgress();
  let failed = false;
  try {
    await mapLimited(
      missing,
      async (id) => {
        try {
          const slots = await Promise.all([
            sdk.deriveStorageSlotInMap(
              layout.post_lengths.slot,
              new sdk.Fr(BigInt(id))
            ),
            ...Array.from({ length: 17 }, (_, i) =>
              sdk.deriveStorageSlotInMap(
                layout.post_data.slot,
                new sdk.Fr(BigInt(id * 17 + i))
              )
            ),
          ]);
          const values = node.getPublicStorageMany
            ? await node.getPublicStorageMany(block, address, slots)
            : await mapLimited(slots, read);
          let post: PostData;
          try {
            post = {
              id,
              text: decodeDFMessage(
                values.slice(1),
                Number(values[0].toBigInt())
              ),
            };
          } catch {
            post = { id, decodeError: true };
          }
          cache.set(key(id), post);
          if (!failed) publishProgress();
        } catch (error) {
          failed = true;
          throw error;
        }
      },
      node.getPublicStorageMany ? 2 : 1
    );
    // Copy the page before eviction; it may include older cached entries.
    const posts = ids.reverse().map((id) => ({ ...cache.get(key(id))! }));
    return { posts, cursor: { block, total, before: start } };
  } finally {
    while (cache.size > CACHE_POSTS) cache.delete(cache.keys().next().value!);
  }
}
