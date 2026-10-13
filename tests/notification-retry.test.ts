import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";
import { finalizeDelivery, notificationEventId } from "../cloudflare-worker/notification-delivery.ts";
import { webPushFixture } from "./web-push-fixture.ts";

const event = { occurrenceId: 1, medicationId: 2, userId: 3, scheduleVersion: 7, localDate: "2026-10-11", localTime: "08:00", eventType: "MISSED" as const };
const dose = { occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 7, local_date: "2026-10-11", time_str: "08:00", event_type: "MISSED", medication_name: "Medicine", dosage: "5mg", scheduled_at_utc: "2026-10-11 08:00:00.000" };

test("retry reuses the exact occurrence and schedule identity", () => {
  assert.equal(notificationEventId(event), notificationEventId({ ...event }));
  assert.notEqual(notificationEventId(event), notificationEventId({ ...event, localTime: "09:00" }));
});

function deliveryDb(fixture: any, options: { current?: boolean; failRevalidation?: boolean; failSentPersistence?: boolean } = {}) {
  const outcomes: string[] = [];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM push_subscriptions")) return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
      if (sql.startsWith("INSERT IGNORE")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("FROM dose_occurrences")) {
        if (options.failRevalidation) throw new Error("crash before dispatch");
        if (options.current === false) return [[], undefined];
        return [[{ id: 1 }], undefined];
      }
      if (sql.includes("SET dispatch_started_at")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("SET outcome=IF")) { outcomes.push("RETRY"); return [{ affectedRows: 1 }, undefined]; }
      if (sql.includes("SET outcome=?")) {
        const outcome = String(values[0]);
        outcomes.push(outcome);
        if (options.failSentPersistence && outcome === "SENT") throw new Error("final persistence failure");
        return [{ affectedRows: 1 }, undefined];
      }
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
  };
  return { db, outcomes };
}

test("pre-dispatch failure releases the lease without sending", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const { db, outcomes } = deliveryDb(fixture, { failRevalidation: true });
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetches, 0);
    assert.deepEqual(outcomes, ["RETRY"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("provider acceptance followed by final persistence failure becomes uncertain without resend", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const { db, outcomes } = deliveryDb(fixture, { failSentPersistence: true });
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetches, 1);
    assert.deepEqual(outcomes, ["SENT", "UNCERTAIN"]);
    assert.ok(!outcomes.includes("RETRY"));
  } finally { globalThis.fetch = originalFetch; }
});

test("stale-token completion cannot overwrite a reclaimed delivery", async () => {
  const calls: unknown[][] = [];
  const db: any = { query: async (_sql: string, values: unknown[]) => { calls.push(values); return [{ affectedRows: 0 }, undefined]; } };
  assert.equal(await finalizeDelivery(db, { eventId: "event", subscriptionId: 12, token: "stale", version: 1 }, "SENT", 201), false);
  assert.deepEqual(calls[0].slice(-4), ["event", 12, "stale", 1]);
});

test("scheduled handler runs due discovery before one-hour overdue processing", async () => {
  const mutableWorker: any = worker;
  const originalDue = mutableWorker.processDueReminders;
  const originalMissed = mutableWorker.processMissedDoses;
  const calls: string[] = [];
  mutableWorker.processDueReminders = async () => { calls.push("due"); };
  mutableWorker.processMissedDoses = async () => { calls.push("missed"); };
  try {
    await mutableWorker.scheduled({ scheduledTime: Date.parse("2026-01-01T00:00:00Z"), cron: "*/1 * * * *" }, {} as any, {} as any);
    assert.deepEqual(calls, ["due", "missed"]);
  } finally {
    mutableWorker.processDueReminders = originalDue;
    mutableWorker.processMissedDoses = originalMissed;
  }
});

test("one-hour missed selection preserves TAKEN occurrences", async () => {
  const queries: Array<[string, unknown[]]> = [];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push([sql, values]);
      if (sql.includes("FROM dose_occurrences o JOIN medications")) return [[{
        occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 1,
        local_date: "2026-01-01", time_str: "10:00", scheduled_at_utc: "2026-01-01 10:00:00.000", medication_name: "Medicine", dosage: "5mg"
      }], undefined];
      if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) return [{ affectedRows: 0 }, undefined];
      if (sql.includes("FROM push_delivery_attempts")) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, end: async () => {}
  };
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  let sends = 0;
  mutableWorker.sendDoseNotification = async () => { sends++; };
  try {
    await mutableWorker.processMissedDoses({ TEST_DB_FACTORY: async () => db } as any, new Date("2026-01-01T11:00:00Z"));
    assert.equal(queries[0][1][0], "2026-01-01 10:00:00.000");
    assert.equal(sends, 0);
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});
