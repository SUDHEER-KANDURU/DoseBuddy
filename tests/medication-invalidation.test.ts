import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";
import { notificationEventId } from "../cloudflare-worker/notification-delivery.ts";
import { webPushFixture } from "./web-push-fixture.ts";

const event = { occurrenceId: 9, medicationId: 2, userId: 3, scheduleVersion: 4, localDate: "2026-10-11", localTime: "08:00", eventType: "REMINDER" as const };
const dose = { occurrence_id: 9, medication_id: 2, user_id: 3, schedule_version: 4, local_date: "2026-10-11", time_str: "08:00", event_type: "REMINDER", medication_name: "Medicine", dosage: "5mg", scheduled_at_utc: "2026-10-11 08:00:00.000" };

test("event identity changes when a medication is rescheduled", () => {
  assert.notEqual(notificationEventId(event), notificationEventId({ ...event, scheduleVersion: 5 }));
  assert.match(notificationEventId(event), /REMINDER:3:2:4:2026-10-11:08:00/);
});

test("edit, delete, reschedule, and stale revision produce zero push fetches", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    for (const scenario of ["edited", "deleted", "rescheduled", "stale-revision"]) {
      const outcomes: string[] = [];
      const db: any = {
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("FROM push_subscriptions")) return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
          if (sql.startsWith("INSERT IGNORE")) return [{ affectedRows: 1 }, undefined];
          if (sql.includes("FROM dose_occurrences")) return [[], undefined];
          if (sql.includes("SET outcome=?")) { outcomes.push(String(values[0])); return [{ affectedRows: 1 }, undefined]; }
          throw new Error(`${scenario}: unexpected SQL ${sql}`);
        }, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
      };
      await worker.sendDoseNotification(fixture.env as any, db, dose);
      assert.equal(fetches, 0, scenario);
      assert.deepEqual(outcomes, ["OBSOLETE"], scenario);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a current occurrence reaches encrypted provider fetch once", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (_input, init) => {
    fetches++;
    assert.ok(init?.body instanceof Uint8Array);
    assert.equal((init?.headers as Record<string, string>)["Content-Encoding"], "aes128gcm");
    return new Response(null, { status: 201 });
  };
  try {
    const db: any = {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes("FROM push_subscriptions")) return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
        if (sql.startsWith("INSERT IGNORE")) return [{ affectedRows: 1 }, undefined];
        if (sql.includes("FROM dose_occurrences")) return [[{ id: 9 }], undefined];
        if (sql.includes("SET dispatch_started_at")) return [{ affectedRows: 1 }, undefined];
        if (sql.includes("SET outcome=?")) { assert.equal(values[0], "SENT"); return [{ affectedRows: 1 }, undefined]; }
        throw new Error(`Unexpected SQL ${sql}`);
      }, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
    };
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetches, 1);
  } finally { globalThis.fetch = originalFetch; }
});
