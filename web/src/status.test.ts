import { describe, it, expect } from 'vitest';
import { deriveStates } from './status';

describe('deriveStates', () => {
  it('all pending before any status rows arrive', () => {
    expect(deriveStates({})).toEqual({ email: 'pending', analytics: 'pending', inventory: 'pending' });
  });

  it('a present row resolves to done', () => {
    expect(deriveStates({ email: { status: 'sent' } }).email).toBe('done');
  });

  it('inventory is dlq when the dead-letter row is present', () => {
    const s = deriveStates({ email: { status: 'sent' }, analytics: { status: 'recorded' }, inventory: { status: 'dead-letter' } });
    expect(s.inventory).toBe('dlq');
  });

  it('inventory shows processing (never a false dlq) while still on the queue', () => {
    // the old timer bug would have said dlq here after 20s
    expect(deriveStates({ email: { status: 'sent' }, analytics: { status: 'recorded' } }).inventory).toBe('processing');
  });

  it('inventory stays pending until the fast consumers finish', () => {
    expect(deriveStates({ email: { status: 'sent' } }).inventory).toBe('pending');
  });

  it('a present inventory row resolves done, not processing or dlq', () => {
    const s = deriveStates({ email: { status: 'sent' }, analytics: { status: 'recorded' }, inventory: { status: 'reserved' } });
    expect(s.inventory).toBe('done');
  });
});
