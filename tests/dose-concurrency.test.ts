import test from "node:test";
import assert from "node:assert/strict";
import { markOccurrenceMissed, markOccurrenceTaken, transact, upsertOccurrence } from "../cloudflare-worker/dose-occurrences.ts";

test("occurrence upsert has a versioned identity", async () => {
  const calls: any[] = [];
  const db: any = { query: async (sql: string, values: unknown[]) => { calls.push([sql, values]); return [{ insertId: 42 }, undefined]; } };
  assert.equal(await upsertOccurrence(db, { medicationId: 1, userId: 2, scheduleVersion: 3, localDate: "2026-10-11", localTime: "08:00", scheduledAtUtc: new Date() }), 42);
  assert.match(calls[0][0], /ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID\(id\)/);
  assert.deepEqual(calls[0][1].slice(0, 5), [1, 2, 3, "2026-10-11", "08:00"]);
});

test("missed is conditional on PENDING while taken can correct MISSED", async () => {
  const sql: string[] = [];
  const db: any = { query: async (statement: string) => { sql.push(statement); return [{ affectedRows: 1 }, undefined]; } };
  assert.equal(await markOccurrenceMissed(db, 1), true);
  assert.equal(await markOccurrenceTaken(db, 1), true);
  assert.match(sql[0], /state='PENDING'/);
  assert.match(sql[1], /state IN \('PENDING','MISSED'\)/);
  assert.doesNotMatch(sql[0], /TAKEN/);
});

test("transaction commits or rolls back atomically", async () => {
  const events: string[] = [];
  const db: any = { beginTransaction: async () => events.push("begin"), commit: async () => events.push("commit"), rollback: async () => events.push("rollback") };
  assert.equal(await transact(db, async () => 7), 7);
  assert.deepEqual(events, ["begin", "commit"]);
  events.length = 0;
  await assert.rejects(transact(db, async () => { throw new Error("failure"); }));
  assert.deepEqual(events, ["begin", "rollback"]);
});

class AtomicOccurrenceAdapter {
  state: "PENDING" | "MISSED" | "TAKEN" = "PENDING";

  async query(statement: string) {
    if (statement.includes("state='MISSED'") && statement.includes("state='PENDING'")) {
      if (this.state !== "PENDING") return [{ affectedRows: 0 }, undefined];
      this.state = "MISSED";
      return [{ affectedRows: 1 }, undefined];
    }
    if (statement.includes("state='TAKEN'") && statement.includes("state IN")) {
      if (this.state === "TAKEN") return [{ affectedRows: 0 }, undefined];
      this.state = "TAKEN";
      return [{ affectedRows: 1 }, undefined];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

test("TAKEN remains terminal in both Cron race orders", async () => {
  const takenFirst = new AtomicOccurrenceAdapter();
  assert.equal(await markOccurrenceTaken(takenFirst as any, 1), true);
  assert.equal(await markOccurrenceMissed(takenFirst as any, 1), false);
  assert.equal(takenFirst.state, "TAKEN");

  const cronFirst = new AtomicOccurrenceAdapter();
  assert.equal(await markOccurrenceMissed(cronFirst as any, 1), true);
  assert.equal(await markOccurrenceTaken(cronFirst as any, 1), true);
  assert.equal(await markOccurrenceMissed(cronFirst as any, 1), false);
  assert.equal(cronFirst.state, "TAKEN");
});

test("duplicate Cron transitions produce one MISSED winner", async () => {
  const db = new AtomicOccurrenceAdapter();
  assert.deepEqual(await Promise.all([
    markOccurrenceMissed(db as any, 1),
    markOccurrenceMissed(db as any, 1)
  ]), [true, false]);
  assert.equal(db.state, "MISSED");
});
