export type ConsumerState = 'pending' | 'done' | 'dlq';
export const CONSUMERS = ['email', 'analytics', 'inventory'] as const;
export type Consumer = (typeof CONSUMERS)[number];

export function deriveStates(
  statuses: Record<string, unknown>,
  forceFailure: boolean,
  elapsedMs: number,
): Record<Consumer, ConsumerState> {
  const out = {} as Record<Consumer, ConsumerState>;
  for (const c of CONSUMERS) {
    if (statuses[c]) out[c] = 'done';
    else if (c === 'inventory' && forceFailure && elapsedMs > 20000) out[c] = 'dlq';
    else out[c] = 'pending';
  }
  return out;
}
