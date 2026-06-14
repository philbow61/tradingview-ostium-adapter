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
