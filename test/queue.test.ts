import { describe, it, expect } from 'vitest';
import { KeyedQueue } from '../src/queue';

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

describe('KeyedQueue', () => {
  it('runs different keys concurrently and the same key serially', async () => {
    const events: string[] = [];
    const resolvers: Record<string, () => void> = {};
    const handler = (job: { id: string }) =>
      new Promise<void>((resolve) => {
        events.push('start:' + job.id);
        resolvers[job.id] = () => {
          events.push('end:' + job.id);
          resolve();
        };
      });

    const q = new KeyedQueue(handler);
    q.push('BTC/USD', { id: 'a' });
    q.push('ETH/USD', { id: 'b' });
    q.push('BTC/USD', { id: 'c' }); // same key as `a` → must wait for it
    await tick();

    // different keys overlap; same-key job is still queued behind the in-flight one
    expect(events).toContain('start:a');
    expect(events).toContain('start:b');
    expect(events).not.toContain('start:c');

    resolvers['a']!(); // finishing `a` lets its key advance to `c`
    await tick();
    expect(events).toContain('start:c');

    resolvers['b']!();
    resolvers['c']!();
    await tick();
    expect(q.size).toBe(0);
  });
});
