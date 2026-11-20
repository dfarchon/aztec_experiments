// Product stake tiers shared by the wallet UI and transaction coordinator.
export const STAKE_UNIT = 500_000_000_000_000n;
export const MAX_STAKE = 2_000_000_000_000_000n;

export function postQuota(amount: bigint): number {
  return Number(amount / STAKE_UNIT) * 5;
}

export function validateTopup(amount: bigint, current: bigint): void {
  if (
    amount < STAKE_UNIT ||
    amount % STAKE_UNIT !== 0n ||
    current < 0n ||
    current + amount > MAX_STAKE
  )
    throw new Error("Stake must be in 0.0005 ETH steps, up to 0.002 ETH");
}
