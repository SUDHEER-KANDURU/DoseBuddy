import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";
import { webPushFixture } from "./web-push-fixture.ts";

// A due REMINDER dose shaped like the rows sendDoseNotification receives.
const dose = {
  occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 7,
  local_date: "2026-10-11", time_str: "08:00", event_type: "REMINDER",
  medication_name: "Medicine", dosage: "5mg", scheduled_at_utc: "2026-10-11 08:00:00.000"
};

// Fake connection honoring INSERT IGNORE claim semantics. `claimed` is shared so a
// second concurrent caller sees the row already claimed and cannot re-claim it.
function deliveryDb(fixture: any, shared: { claimed: boolean }) {
  const outcomes: string[] = [];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM push_subscriptions")) {
        return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
      }
      if (sql.startsWith("INSERT IGNORE")) {
        // First caller wins (affectedRows 1); later callers get 0.
        if (shared.claimed) return [{ affectedRows: 0 }, undefined];
        shared.claimed = true;
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("FROM dose_occurrences")) return [[{ id: 1 }], undefined];
      if (sql.includes("SET dispatch_started_at")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("SET outcome=?")) { outcomes.push(String(values[0])); return [{ affectedRows: 1 }, undefined]; }
      if (sql.startsWith("UPDATE push_delivery_attempts")) {
        // The reclaim UPDATE: never reclaimable in this test (not a RETRY / not lease-expired).
        return [{ affectedRows: 0 }, undefined];
      }
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
  };
  return { db, outcomes };
}

test("server discovers and dispatches a due reminder with no inbound frontend request", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  const fetchTargets: string[] = [];
  globalThis.fetch = async (input: any) => {
    // A genuine inbound HTTP Request into the Worker would be a Request object; the
    // only fetch here must be the outbound provider POST to the push endpoint.
    const url = typeof input === "string" ? input : (input?.url ?? "");
    fetchTargets.push(url);
    return new Response(null, { status: 201 });
  };
  try {
    const { db, outcomes } = deliveryDb(fixture, { claimed: false });
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetchTargets.length, 1, "exactly one outbound provider POST");
    assert.ok(fetchTargets[0].startsWith(fixture.subscription.endpoint.slice(0, 20)) || fetchTargets[0].includes("push.example.test"),
      "the fetch targets the push provider endpoint, not an inbound app request");
    assert.deepEqual(outcomes, ["SENT"], "delivered only on a provider 2xx");
  } finally { globalThis.fetch = originalFetch; }
});

test("processDueReminders finds due occurrences from the database alone (no HTTP request)", async () => {
  const fixture = await webPushFixture();
  // A due row at exactly the instant we evaluate. occurrencesThroughInstant decides
  // REMINDER vs MISSED; we only need to prove discovery reaches sendDoseNotification.
  const dueRow = {
    medication_id: 2, user_id: 3, medication_name: "Medicine", dosage: "5mg",
    start_date: "2026-10-11", end_date: "2026-10-11", schedule_version: 7,
    time_zone: "UTC", time_str: "08:00"
  };
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM medications m JOIN medication_times")) return [[dueRow], undefined];
      // upsertOccurrence / intake_logs / recordMissed queries during per-dose transact.
      if (sql.includes("FROM intake_logs")) return [[], undefined];
      return [{ affectedRows: 1, insertId: 1 }, undefined];
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, end: async () => {}
  };
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  let sends = 0;
  let sentDose: any;
  mutableWorker.sendDoseNotification = async (_env: unknown, _db: unknown, d: any) => { sends++; sentDose = d; };
  try {
    const env = { TEST_DB_FACTORY: async () => db } as any;
    await worker.processDueReminders(env, new Date("2026-10-11T08:00:30Z"));
    assert.equal(sends, 1, "a due occurrence is discovered and dispatched from the DB with no frontend request");
    assert.equal(Number(sentDose.user_id), 3);
    assert.equal(Number(sentDose.medication_id), 2);
  } finally { mutableWorker.sendDoseNotification = originalSend; }
});

test("two concurrent sends for the same occurrence yield exactly one provider POST and one SENT", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const shared = { claimed: false };
    const a = deliveryDb(fixture, shared);
    const b = deliveryDb(fixture, shared);
    await Promise.all([
      worker.sendDoseNotification(fixture.env as any, a.db, dose),
      worker.sendDoseNotification(fixture.env as any, b.db, dose)
    ]);
    assert.equal(fetches, 1, "the concurrent loser performs no provider POST");
    const allOutcomes = [...a.outcomes, ...b.outcomes];
    assert.deepEqual(allOutcomes, ["SENT"], "exactly one SENT; the loser writes no outcome row");
  } finally { globalThis.fetch = originalFetch; }
});

test("a mid-dispatch medication edit obsoletes the claim instead of sending (OBSOLETE, not loser)", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const outcomes: string[] = [];
    const db: any = {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes("FROM push_subscriptions")) return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
        if (sql.startsWith("INSERT IGNORE")) return [{ affectedRows: 1 }, undefined];
        // Revalidation finds the occurrence no longer current (edited mid-dispatch).
        if (sql.includes("FROM dose_occurrences")) return [[], undefined];
        if (sql.includes("SET outcome=?")) { outcomes.push(String(values[0])); return [{ affectedRows: 1 }, undefined]; }
        throw new Error(`Unexpected SQL ${sql}`);
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
    };
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetches, 0, "an obsoleted occurrence is never sent");
    assert.deepEqual(outcomes, ["OBSOLETE"]);
  } finally { globalThis.fetch = originalFetch; }
});
