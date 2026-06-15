/** Minimal serial async queue — processes jobs one at a time (per-wallet serialization, DESIGN §3). */
export class SerialQueue<T> {
  private items: T[] = [];
  private running = false;

  constructor(private handler: (job: T) => Promise<void>) {}

  push(job: T): void {
    this.items.push(job);
    void this.drain();
  }

  get size(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const job = this.items.shift()!;
        try {
          await this.handler(job);
        } catch (err) {
          console.error('[queue] handler error', err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * Routes each job to a per-key SerialQueue: jobs with the SAME key run serially (per-pair ordering
 * for flips/dedup), jobs with DIFFERENT keys run concurrently (so a slow settlement on one pair
 * doesn't block another). Key by pair.
 */
export class KeyedQueue<T> {
  private queues = new Map<string, SerialQueue<T>>();

  constructor(private handler: (job: T) => Promise<void>) {}

  push(key: string, job: T): void {
    let q = this.queues.get(key);
    if (!q) {
      q = new SerialQueue<T>(this.handler);
      this.queues.set(key, q);
    }
    q.push(job);
  }

  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.size;
    return n;
  }
}
