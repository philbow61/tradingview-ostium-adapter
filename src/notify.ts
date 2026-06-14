/** Optional Discord notifications (fill / reject). No-op when no webhook URL is configured. */
export interface Notifier {
  send(text: string): Promise<void>;
}

export class DiscordNotifier implements Notifier {
  constructor(private url: string) {}
  async send(text: string): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text.slice(0, 1900) }),
      });
    } catch (e) {
      console.warn('[notify] failed', e);
    }
  }
}

export class NoopNotifier implements Notifier {
  async send(): Promise<void> {}
}

export function makeNotifier(url?: string): Notifier {
  return url ? new DiscordNotifier(url) : new NoopNotifier();
}
