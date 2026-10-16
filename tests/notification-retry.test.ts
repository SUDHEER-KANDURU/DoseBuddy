import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";
import { claimDeliveryAttempt, finalizeDelivery, notificationEventId, releaseUnstartedClaim, revalidationSql, DELIVERY_MAX_RETRIES } from "../cloudflare-worker/notification-delivery.ts";
import { webPushFixture } from "./web-push-fixture.ts";

const event = { occurrenceId: 1, medicationId: 2, userId: 3, scheduleVersion: 7, localDate: "2026-10-11", localTime: "08:00", eventType: "MISSED" as const };
const dose = { occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 7, local_date: "2026-10-11", time_str: "08:00", event_type: "MISSED", medication_name: "Medicine", dosage: "5mg", scheduled_at_utc: "2026-10-11 08:00:00.000" };

test("retry reuses the exact occurrence and schedule identity", () => {
  assert.equal(notificationEventId(event), notificationEventId({ ...event }));
  assert.notEqual(notificationEventId(event), notificationEventId({ ...event, localTime: "09:00" }));
});

function deliveryDb(fixture: any, options: { current?: boolean; failRevalidation?: boolean; failSentPersistence?: boolean } = {}) {
  const outcomes: string[] = [];
  const finalizeCalls: { errorCategory: unknown }[] = [];
  const deactivatedSubscriptions: unknown[] = [];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM push_subscriptions")) return [[{ id: 12, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
      if (sql.startsWith("UPDATE push_subscriptions SET active=0")) { deactivatedSubscriptions.push(values[0]); return [{ affectedRows: 1 }, undefined]; }
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
        finalizeCalls.push({ errorCategory: values[2] });
        if (options.failSentPersistence && outcome === "SENT") throw new Error("final persistence failure");
        return [{ affectedRows: 1 }, undefined];
      }
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
  };
  return { db, outcomes, finalizeCalls, deactivatedSubscriptions };
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

test("missing VAPID configuration is recorded as a safe retry, not uncertain delivery", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const { db, outcomes } = deliveryDb(fixture);
    const env = { ...fixture.env, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_EMAIL: undefined };
    await worker.sendDoseNotification(env as any, db, dose);
    assert.equal(fetches, 0, "no provider request is possible without VAPID credentials");
    assert.deepEqual(outcomes, ["RETRY"], "pre-dispatch configuration failures must remain retryable");
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

test("scheduled handler runs due discovery before missed-dose processing", async () => {
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

test("scheduled handler still processes persisted missed occurrences when due discovery fails", async () => {
  const mutableWorker: any = worker;
  const originalDue = mutableWorker.processDueReminders;
  const originalMissed = mutableWorker.processMissedDoses;
  let missedRuns = 0;
  mutableWorker.processDueReminders = async () => { throw new Error("missing users.time_zone"); };
  mutableWorker.processMissedDoses = async () => { missedRuns++; };
  try {
    await worker.scheduled({ scheduledTime: Date.parse("2026-01-01T00:00:00Z"), cron: "*/1 * * * *" }, {} as any, {} as any);
    assert.equal(missedRuns, 1);
  } finally {
    mutableWorker.processDueReminders = originalDue;
    mutableWorker.processMissedDoses = originalMissed;
  }
});

test("one-minute missed selection preserves TAKEN occurrences", async () => {
  const queries: Array<[string, unknown[]]> = [];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push([sql, values]);
      if (sql.includes("FROM dose_occurrences o JOIN medications") && sql.includes("o.state='PENDING'")) return [[{
        occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 1,
        local_date: "2026-01-01", time_str: "10:00", scheduled_at_utc: "2026-01-01 10:00:00.000", medication_name: "Medicine", dosage: "5mg"
      }], undefined];
      if (sql.includes("FROM dose_occurrences o JOIN medications") && sql.includes("o.state='MISSED'")) return [[], undefined];
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
    await mutableWorker.processMissedDoses({ TEST_DB_FACTORY: async () => db } as any, new Date("2026-01-01T10:01:00Z"));
    assert.equal(queries[0][1][0], "2026-01-01 10:00:00.000");
    assert.equal(sends, 0);
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});

test("missed-dose processing dispatches one MISSED push only after the atomic transition", async () => {
  let state = "PENDING";
  let committed = false;
  let sends = 0;
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM dose_occurrences o JOIN medications m") && sql.includes("o.state='PENDING'")) {
        return [state === "PENDING" ? [{
          occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 1,
          local_date: "2026-01-01", time_str: "10:00", scheduled_at_utc: "2026-01-01 10:00:00.000",
          medication_name: "Medicine", dosage: "5mg"
        }] : [], undefined];
      }
      if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) {
        if (state !== "PENDING") return [{ affectedRows: 0 }, undefined];
        state = "MISSED";
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("SELECT id FROM intake_logs")) return [[], undefined];
      if (sql.startsWith("INSERT INTO intake_logs")) return [{ insertId: 11 }, undefined];
      if (sql.startsWith("INSERT INTO activities")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("FROM push_delivery_attempts")) return [[], undefined];
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => { committed = false; },
    commit: async () => { committed = true; },
    rollback: async () => {},
    end: async () => {}
  };
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  mutableWorker.sendDoseNotification = async (_env: unknown, _db: unknown, notification: any) => {
    assert.equal(committed, true, "push dispatch must follow the committed MISSED transition");
    assert.equal(state, "MISSED");
    assert.equal(notification.event_type, "MISSED");
    sends++;
  };
  try {
    const env = { TEST_DB_FACTORY: async () => db } as any;
    const now = new Date("2026-01-01T10:01:00Z");
    await worker.processMissedDoses(env, now);
    await worker.processMissedDoses(env, now);
    assert.equal(sends, 1, "duplicate scheduler runs must not repeat the missed push");
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});

test("scheduler reconciles a committed MISSED occurrence when first dispatch never creates a claim", async () => {
  let state = "PENDING";
  let committed = false;
  let claimExists = false;
  let dispatchCalls = 0;
  const row = {
    occurrence_id: 4, medication_id: 5, user_id: 6, schedule_version: 2,
    local_date: "2026-01-01", time_str: "10:00", scheduled_at_utc: "2026-01-01 10:00:00.000",
    medication_name: "Medicine", dosage: "5mg", event_type: "MISSED"
  };
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM dose_occurrences o JOIN medications m") && sql.includes("o.state='PENDING'")) {
        return [state === "PENDING" ? [row] : [], undefined];
      }
      if (sql.includes("FROM dose_occurrences o JOIN medications m") && sql.includes("o.state='MISSED'")) {
        return [state === "MISSED" && !claimExists ? [row] : [], undefined];
      }
      if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) {
        if (state !== "PENDING") return [{ affectedRows: 0 }, undefined];
        state = "MISSED";
        return [{ affectedRows: 1 }, undefined];
      }
      if (sql.includes("SELECT id FROM intake_logs")) return [[], undefined];
      if (sql.startsWith("INSERT INTO intake_logs")) return [{ insertId: 17 }, undefined];
      if (sql.startsWith("INSERT INTO activities")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("FROM push_delivery_attempts")) return [[], undefined];
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => { committed = false; },
    commit: async () => { committed = true; }, rollback: async () => {}, end: async () => {}
  };
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  mutableWorker.sendDoseNotification = async () => {
    assert.equal(committed, true, "reconciliation must observe the committed transition");
    dispatchCalls++;
    if (dispatchCalls === 1) throw new Error("subscription lookup failed before claim creation");
    claimExists = true;
  };
  try {
    const env = { TEST_DB_FACTORY: async () => db } as any;
    await worker.processMissedDoses(env, new Date("2026-01-01T10:01:00Z"));
    assert.equal(state, "MISSED");
    assert.equal(dispatchCalls, 2, "reconciliation should retry work that has no ledger claim");
    await worker.processMissedDoses(env, new Date("2026-01-01T10:02:00Z"));
    assert.equal(dispatchCalls, 2, "a created ledger claim prevents duplicate reconciliation");
  } finally { mutableWorker.sendDoseNotification = originalSend; }
});

// ── Case 5 — provider failure → RETRY, bounded by DELIVERY_MAX_RETRIES ──────────
test("provider 429/500 responses finalize RETRY (case 5)", async () => {
  for (const status of [429, 500]) {
    const fixture = await webPushFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status });
    try {
      const { db, outcomes, finalizeCalls } = deliveryDb(fixture);
      await worker.sendDoseNotification(fixture.env as any, db, dose);
      assert.deepEqual(outcomes, ["RETRY"], `status ${status} must be retryable`);
      assert.equal(finalizeCalls[0].errorCategory, "provider");
    } finally { globalThis.fetch = originalFetch; }
  }
});

test("releaseUnstartedClaim flips to FAILED once the retry bound is reached (case 5 bound)", async () => {
  const calls: unknown[][] = [];
  const db: any = { query: async (_sql: string, values: unknown[]) => { calls.push(values); return [{ affectedRows: 1 }, undefined]; } };
  assert.equal(DELIVERY_MAX_RETRIES, 3);
  await releaseUnstartedClaim(db, { eventId: "e", subscriptionId: 12, token: "t", version: 1 }, "pre-dispatch");
  const [sql, values] = [calls.length ? "" : "", calls[0]];
  // The SQL encodes the bound as IF(retry_count+1>=?,'FAILED','RETRY') and binds
  // DELIVERY_MAX_RETRIES for both the outcome and next_attempt_at branches.
  assert.equal(values[0], DELIVERY_MAX_RETRIES);
  assert.equal(values[2], DELIVERY_MAX_RETRIES);
  void sql;
});

test("the SQL that bounds retries references FAILED at the max-retry threshold (case 5 bound)", async () => {
  let captured = "";
  const db: any = { query: async (sql: string) => { captured = sql; return [{ affectedRows: 1 }, undefined]; } };
  await releaseUnstartedClaim(db, { eventId: "e", subscriptionId: 12, token: "t", version: 1 }, "pre-dispatch");
  assert.ok(captured.includes("IF(retry_count+1>=?,'FAILED','RETRY')"));
});

// ── Case 6 — expired/invalid subscription (404/410) → EXPIRED + deactivate ──────
test("provider 410/404 responses finalize EXPIRED and deactivate the subscription (case 6)", async () => {
  for (const status of [410, 404]) {
    const fixture = await webPushFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status });
    try {
      const { db, outcomes, deactivatedSubscriptions } = deliveryDb(fixture);
      await worker.sendDoseNotification(fixture.env as any, db, dose);
      assert.deepEqual(outcomes, ["EXPIRED"], `status ${status} is a dead subscription`);
      assert.deepEqual(deactivatedSubscriptions, [12], "the exact subscription id is deactivated");
      assert.ok(!outcomes.includes("RETRY"), "an expired subscription is never retried");
    } finally { globalThis.fetch = originalFetch; }
  }
});

// ── Case 7 — racing schedulers → only one claim wins ────────────────────────────
test("claimDeliveryAttempt lets only one racing scheduler win (case 7)", async () => {
  let captured = "";
  let insertCount = 0;
  const db: any = {
    query: async (sql: string) => {
      if (sql.startsWith("INSERT IGNORE")) {
        captured = sql;
        insertCount++;
        // First racer wins the INSERT IGNORE; second sees a duplicate (0 rows).
        return [{ affectedRows: insertCount === 1 ? 1 : 0 }, undefined];
      }
      if (sql.startsWith("UPDATE push_delivery_attempts")) return [{ affectedRows: 0 }, undefined];
      throw new Error(`Unexpected SQL ${sql}`);
    }
  };
  const first = await claimDeliveryAttempt(db, event, 12, "2026-10-11 08:00:00.000");
  const second = await claimDeliveryAttempt(db, event, 12, "2026-10-11 08:00:00.000");
  assert.ok(first, "the first scheduler claims the lease");
  assert.equal(second, null, "the second scheduler gets no claim → single send");
  assert.ok(captured.includes("INSERT IGNORE INTO push_delivery_attempts"), "claim keys on the unique event_id + subscription_id row");
});

// ── Case 9 — inactive / superseded / out-of-range meds are filtered ─────────────
test("revalidationSql keeps the authorization and currency filters (case 9 contract)", () => {
  for (const [eventType, requiredState] of [["REMINDER", "PENDING"], ["MISSED", "MISSED"]] as const) {
    const sql = revalidationSql(eventType);
    assert.ok(sql.includes("m.active=1"), `${eventType}: active filter`);
    assert.ok(sql.includes("m.user_id=?"), `${eventType}: owner filter`);
    assert.ok(sql.includes("m.schedule_version=?"), `${eventType}: schedule-version bind`);
    assert.ok(sql.includes("o.schedule_version=m.schedule_version"), `${eventType}: occurrence version match`);
    assert.ok(sql.includes("o.local_date BETWEEN m.start_date AND m.end_date"), `${eventType}: date range`);
    assert.ok(sql.includes(`o.state='${requiredState}'`), `${eventType}: required state`);
  }
  assert.ok(revalidationSql("REMINDER", true).includes("FOR UPDATE"));
});

test("a stale occurrence is marked OBSOLETE and never sent (case 9 behavior)", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  try {
    const { db, outcomes } = deliveryDb(fixture, { current: false });
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.equal(fetches, 0, "no provider request for a superseded occurrence");
    assert.deepEqual(outcomes, ["OBSOLETE"]);
    assert.ok(!outcomes.includes("SENT") && !outcomes.includes("RETRY"));
  } finally { globalThis.fetch = originalFetch; }
});

// ── Case 11 — recovery after the dispatch boundary / expired claims ─────────────
test("a crash after the dispatch boundary records UNCERTAIN with the dispatch-uncertain category (case 11)", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 201 });
  try {
    const { db, outcomes, finalizeCalls } = deliveryDb(fixture, { failSentPersistence: true });
    await worker.sendDoseNotification(fixture.env as any, db, dose);
    assert.deepEqual(outcomes, ["SENT", "UNCERTAIN"]);
    assert.equal(finalizeCalls.at(-1)!.errorCategory, "dispatch-uncertain");
    assert.ok(!outcomes.includes("RETRY"));
  } finally { globalThis.fetch = originalFetch; }
});

test("a pre-dispatch crash releases the claim as a retry with zero provider requests (case 11)", async () => {
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

test("recoverExpiredClaims finalizes a dispatched lease UNCERTAIN and recovers an undispatched one (case 11)", async () => {
  const captured: { outcome?: string; errorCategory?: unknown; released?: boolean } = {};
  const rows = [
    { event_id: "MISSED:3:2:7:2026-10-11:08:00", subscription_id: 12, claim_token: "t1", claim_version: 1, dispatch_started_at: "2026-10-11 08:00:00.000",
      occurrence_id: 1, medication_id: 2, user_id: 3, schedule_version: 7, local_date: "2026-10-11", time_str: "08:00", event_type: "MISSED" },
    { event_id: "MISSED:3:2:7:2026-10-11:09:00", subscription_id: 13, claim_token: "t2", claim_version: 1, dispatch_started_at: null,
      occurrence_id: 2, medication_id: 2, user_id: 3, schedule_version: 7, local_date: "2026-10-11", time_str: "09:00", event_type: "MISSED" }
  ];
  const db: any = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM push_delivery_attempts a JOIN dose_occurrences")) return [rows, undefined];
      if (sql.includes("FROM dose_occurrences")) return [[{ id: 2 }], undefined]; // revalidation → current
      if (sql.includes("SET outcome=IF")) { captured.released = true; return [{ affectedRows: 1 }, undefined]; }
      if (sql.includes("SET outcome=?")) { captured.outcome = String(values[0]); captured.errorCategory = values[2]; return [{ affectedRows: 1 }, undefined]; }
      throw new Error(`Unexpected SQL ${sql}`);
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, end: async () => {}
  };
  await worker.recoverExpiredClaims({ TEST_DB_FACTORY: async () => db } as any);
  assert.equal(captured.outcome, "UNCERTAIN", "a dispatched lease is never re-sent, only marked UNCERTAIN");
  assert.equal(captured.errorCategory, "lease-expired-after-dispatch");
  assert.equal(captured.released, true, "the undispatched lease is released for retry");
});
