/**
 * Idempotency store — a state machine, not a seen-set (DESIGN §8, RISKS R7).
 * RECEIVED -> EXECUTING -> FILLED | FAILED. A retry that finds FAILED may re-execute
 * (within the freshness window enforced upstream); FILLED/EXECUTING short-circuit.
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export type DedupStatus = 'RECEIVED' | 'EXECUTING' | 'FILLED' | 'FAILED';

export function dedupKey(material: string): string {
  return createHash('sha256').update(material).digest('hex');
}

export function clientOrderId(key: string): string {
  return key.slice(0, 32);
}

export interface ClaimResult {
  isNew: boolean;
  status: DedupStatus;
  clientOrderId: string;
}

export class DedupStore {
  private db: Database.Database;

  constructor(path = 'data/dedup.sqlite') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS dedup (
         key TEXT PRIMARY KEY,
         coid TEXT NOT NULL,
         status TEXT NOT NULL,
         created_at REAL NOT NULL,
         updated_at REAL NOT NULL,
         detail TEXT
       )`,
    );
  }

  /** Claim a key atomically. New or previously-FAILED -> RECEIVED (isNew=true). */
  claim(key: string): ClaimResult {
    const coid = clientOrderId(key);
    const now = Date.now() / 1000;
    const row = this.db.prepare('SELECT status FROM dedup WHERE key = ?').get(key) as
      | { status: DedupStatus }
      | undefined;

    if (!row) {
      this.db
        .prepare('INSERT INTO dedup(key, coid, status, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(key, coid, 'RECEIVED', now, now);
      return { isNew: true, status: 'RECEIVED', clientOrderId: coid };
    }
    if (row.status === 'FAILED') {
      this.db
        .prepare('UPDATE dedup SET status = ?, updated_at = ?, detail = NULL WHERE key = ?')
        .run('RECEIVED', now, key);
      return { isNew: true, status: 'RECEIVED', clientOrderId: coid };
    }
    return { isNew: false, status: row.status, clientOrderId: coid };
  }

  mark(key: string, status: DedupStatus, detail?: string): void {
    this.db
      .prepare('UPDATE dedup SET status = ?, updated_at = ?, detail = ? WHERE key = ?')
      .run(status, Date.now() / 1000, detail ?? null, key);
  }

  status(key: string): DedupStatus | null {
    const row = this.db.prepare('SELECT status FROM dedup WHERE key = ?').get(key) as
      | { status: DedupStatus }
      | undefined;
    return row?.status ?? null;
  }

  close(): void {
    this.db.close();
  }
}
