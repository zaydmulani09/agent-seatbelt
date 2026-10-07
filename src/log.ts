// node:sqlite prints an ExperimentalWarning on import. Silence only that one.
const origEmit = process.emitWarning;
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w?.message ?? w).includes('SQLite')) return;
  return (origEmit as any).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = origEmit;

import { sha256 } from './redact.js';
import type { Outcome } from './summary.js';

export interface EventIn {
  ts?: number;
  agent?: string;
  upstream?: string;
  tool: string;
  cls: string;
  decision: 'allow' | 'ask' | 'deny' | 'paused' | 'system';
  outcome: Outcome | 'system';
  code?: string;
  summary: string;
  detail?: string;
  args?: string;
  argsHash?: string;
  amount?: number;
}

export interface EventRow extends Required<Omit<EventIn, 'amount'>> {
  id: number;
  amount: number | null;
  prevHash: string;
  hash: string;
}

export interface Approval {
  id: number;
  ts: number;
  agent: string;
  tool: string;
  cls: string;
  summary: string;
  detail: string;
  args: string;
  amount: number | null;
  status: 'pending' | 'approved' | 'denied' | 'timeout';
  decidedTs: number | null;
  always: number;
}

const GENESIS = '0'.repeat(64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '', upstream TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL, cls TEXT NOT NULL, decision TEXT NOT NULL, outcome TEXT NOT NULL, code TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '', args_hash TEXT NOT NULL DEFAULT '',
  amount REAL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'black box is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'black box is append-only'); END;
CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL, cls TEXT NOT NULL,
  summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '', amount REAL,
  status TEXT NOT NULL DEFAULT 'pending', decided_ts INTEGER, always INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`;

function chainHash(prev: string, e: Omit<EventRow, 'id' | 'prevHash' | 'hash'>): string {
  return sha256(
    prev +
      JSON.stringify([e.ts, e.agent, e.upstream, e.tool, e.cls, e.decision, e.outcome, e.code, e.summary, e.detail, e.args, e.argsHash, e.amount]),
  );
}

const mapEvent = (r: any): EventRow => ({
  id: r.id, ts: r.ts, agent: r.agent, upstream: r.upstream, tool: r.tool, cls: r.cls, decision: r.decision, outcome: r.outcome,
  code: r.code, summary: r.summary, detail: r.detail, args: r.args, argsHash: r.args_hash, amount: r.amount, prevHash: r.prev_hash, hash: r.hash,
});

const mapApproval = (r: any): Approval => ({
  id: r.id, ts: r.ts, agent: r.agent, tool: r.tool, cls: r.cls, summary: r.summary, detail: r.detail, args: r.args, amount: r.amount,
  status: r.status, decidedTs: r.decided_ts, always: r.always,
});

export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class Store {
  readonly db: InstanceType<typeof DatabaseSync>;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  append(e: EventIn): number {
    const row = {
      ts: e.ts ?? Date.now(), agent: e.agent ?? '', upstream: e.upstream ?? '', tool: e.tool, cls: e.cls, decision: e.decision,
      outcome: e.outcome, code: e.code ?? '', summary: e.summary, detail: e.detail ?? '', args: e.args ?? '', argsHash: e.argsHash ?? '',
      amount: e.amount ?? null,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = this.db.prepare('SELECT hash FROM events ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
      const prev = last?.hash ?? GENESIS;
      const res = this.db
        .prepare(
          'INSERT INTO events(ts,agent,upstream,tool,cls,decision,outcome,code,summary,detail,args,args_hash,amount,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(row.ts, row.agent, row.upstream, row.tool, row.cls, row.decision, row.outcome, row.code, row.summary, row.detail, row.args, row.argsHash, row.amount, prev, chainHash(prev, row));
      this.db.exec('COMMIT');
      return Number(res.lastInsertRowid);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  events(limit = 100, since = 0): EventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY id DESC LIMIT ?').all(since, limit) as any[]).map(mapEvent);
  }

  verify(): { ok: boolean; count: number; brokenAt?: number } {
    let prev = GENESIS;
    let count = 0;
    for (const raw of this.db.prepare('SELECT * FROM events ORDER BY id').iterate() as Iterable<any>) {
      const e = mapEvent(raw);
      if (e.prevHash !== prev || chainHash(prev, e) !== e.hash) return { ok: false, count, brokenAt: e.id };
      prev = e.hash;
      count++;
    }
    return { ok: true, count };
  }

  spentToday(now = Date.now()): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM events WHERE ts >= ? AND amount IS NOT NULL AND outcome IN ('done','approved')")
      .get(startOfToday(now)) as { s: number };
    return r.s;
  }

  callsSince(ts: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND decision != 'system'").get(ts) as { n: number }).n;
  }

  repeatsSince(ts: number, tool: string, argsHash: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND tool = ? AND args_hash = ? AND decision != 'system'").get(ts, tool, argsHash) as { n: number }).n;
  }

  createApproval(a: Pick<Approval, 'agent' | 'tool' | 'cls' | 'summary' | 'detail' | 'args'> & { amount?: number }): number {
    const r = this.db
      .prepare('INSERT INTO approvals(ts,agent,tool,cls,summary,detail,args,amount) VALUES(?,?,?,?,?,?,?,?)')
      .run(Date.now(), a.agent, a.tool, a.cls, a.summary, a.detail, a.args, a.amount ?? null);
    return Number(r.lastInsertRowid);
  }

  approval(id: number): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return r ? mapApproval(r) : undefined;
  }

  pending(): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as any[]).map(mapApproval);
  }

  /** Returns false when someone else already decided. */
  decide(id: number, status: 'approved' | 'denied' | 'timeout', always = false): boolean {
    const r = this.db
      .prepare("UPDATE approvals SET status = ?, decided_ts = ?, always = ? WHERE id = ? AND status = 'pending'")
      .run(status, Date.now(), always ? 1 : 0, id);
    return Number(r.changes) > 0;
  }

  /** Cheap change detector for live updates. */
  fingerprint(): string {
    const e = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM events').get() as { m: number };
    const a = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(SUM(status != 'pending'),0) AS d FROM approvals").get() as { n: number; m: number; d: number };
    return `${e.m}.${a.n}.${a.m}.${a.d}`;
  }
}
