/** Append-only audit/event log (DESIGN §8). Secrets are never written here. */
import Database from 'better-sqlite3';

export interface EventRow {
  ts: number;
  strategyId: string | null;
  dedupKey: string | null;
  kind: string;
  data: Record<string, unknown>;
}

export class EventStore {
  private db: Database.Database;

  constructor(path = 'data/events.sqlite') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts REAL NOT NULL,
         strategy_id TEXT,
         dedup_key TEXT,
         kind TEXT NOT NULL,
         data TEXT
       )`,
    );
  }

  log(
    kind: string,
    opts: { strategyId?: string; dedupKey?: string; data?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare('INSERT INTO events(ts, strategy_id, dedup_key, kind, data) VALUES (?,?,?,?,?)')
      .run(Date.now() / 1000, opts.strategyId ?? null, opts.dedupKey ?? null, kind, JSON.stringify(opts.data ?? {}));
  }

  recent(limit = 50): EventRow[] {
    const rows = this.db
      .prepare('SELECT ts, strategy_id, dedup_key, kind, data FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ ts: number; strategy_id: string | null; dedup_key: string | null; kind: string; data: string }>;
    return rows.map((r) => ({
      ts: r.ts,
      strategyId: r.strategy_id,
      dedupKey: r.dedup_key,
      kind: r.kind,
      data: r.data ? JSON.parse(r.data) : {},
    }));
  }

  /** Unix-seconds ts of the newest event of a kind, or null. */
  latest(kind: string): number | null {
    const row = this.db.prepare('SELECT ts FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as
      | { ts: number }
      | undefined;
    return row ? row.ts : null;
  }

  close(): void {
    this.db.close();
  }
}
