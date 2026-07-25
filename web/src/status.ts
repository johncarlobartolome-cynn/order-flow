export type ConsumerState = 'pending' | 'processing' | 'done' | 'dlq';
export const CONSUMERS = ['email', 'analytics', 'inventory'] as const;
export type Consumer = (typeof CONSUMERS)[number];

// Reads REAL state from the status rows. No timers, no forceFailure guess.
//   row.status === 'dead-letter'  -> 'dlq'  (the DLQ consumer wrote it)
//   any other present row          -> 'done'
//   inventory still missing once email+analytics are done -> 'processing'
//        (honest: order accepted, inventory is being worked on the queue;
//         we do NOT claim a terminal state it hasn't reached)
//   otherwise -> 'pending'
export function deriveStates(
  statuses: Record<string, { status?: string } | undefined>,
): Record<Consumer, ConsumerState> {
  const out = {} as Record<Consumer, ConsumerState>;
  const fastDone = !!statuses.email && !!statuses.analytics;
  for (const c of CONSUMERS) {
    const row = statuses[c];
    if (row?.status === 'dead-letter') out[c] = 'dlq';
    else if (row) out[c] = 'done';
    else if (c === 'inventory' && fastDone) out[c] = 'processing';
    else out[c] = 'pending';
  }
  return out;
}
