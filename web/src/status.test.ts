import { describe, it, expect } from 'vitest';
import { deriveStates } from './status';

describe('deriveStates', () => {
  it('marks consumers done when their status exists', () => {
    expect(deriveStates({ email: {}, analytics: {}, inventory: {} }, false, 5000))
      .toEqual({ email: 'done', analytics: 'done', inventory: 'done' });
  });
  it('keeps missing consumers pending early', () => {
    const s = deriveStates({ email: {} }, false, 3000);
    expect(s.analytics).toBe('pending');
    expect(s.inventory).toBe('pending');
  });
  it('infers inventory → DLQ on a forceFailure order after the grace window', () => {
    expect(deriveStates({ email: {}, analytics: {} }, true, 25000).inventory).toBe('dlq');
  });
  it('does not mark DLQ before the grace window', () => {
    expect(deriveStates({ email: {}, analytics: {} }, true, 5000).inventory).toBe('pending');
  });
});
