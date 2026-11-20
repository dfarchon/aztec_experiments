// Same-origin tabs share Web Locks. Never fall back to a racy localStorage lease.
export async function withWalletLock<T>(
  key: string,
  operation: () => Promise<T>,
  locks = globalThis.navigator?.locks
): Promise<T> {
  if (!locks)
    throw new Error(
      "This browser cannot safely coordinate wallet operations. Use a browser with Web Locks on HTTPS or localhost."
    );
  return locks.request(
    `billboard-wallet:${key}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          "This wallet is busy in another tab. Finish there, then retry here."
        );
      return operation();
    }
  );
}
