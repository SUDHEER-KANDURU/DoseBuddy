import test from "node:test";
import assert from "node:assert/strict";
import { addLocalDays, canonicalTimeZone, dueOccurrencesAtInstant, isDateInMedicationRange, occurrenceForInstant, occurrencesThroughInstant, resolveLocalOccurrence, zonedParts } from "../cloudflare-worker/scheduling.ts";
import worker from "../cloudflare-worker/index.ts";
import { webPushFixture } from "./web-push-fixture.ts";

test("local and UTC dates remain explicit across midnight", () => {
  assert.equal(zonedParts(new Date("2026-10-10T23:59:00Z"), "Asia/Kolkata").date, "2026-10-11");
  assert.equal(zonedParts(new Date("2026-10-11T00:01:00Z"), "America/Los_Angeles").date, "2026-10-10");
  assert.equal(zonedParts(new Date("2026-01-01T10:00:00Z"), "Pacific/Kiritimati").date, "2026-01-02");
});

test("medication range uses the user's local calendar", () => {
  const occurrence = occurrenceForInstant(new Date("2026-10-10T18:31:00Z"), "Asia/Kolkata", "08:00", "2026-10-11", "2026-10-11");
  assert.equal(occurrence?.localDate, "2026-10-11");
  assert.equal(occurrence?.scheduledAtUtc.toISOString(), "2026-10-11T02:30:00.000Z");
  assert.equal(isDateInMedicationRange("2026-10-10", "2026-10-11", "2026-10-12"), false);
  assert.equal(isDateInMedicationRange("2026-10-12", "2026-10-11", "2026-10-12"), true);
  assert.equal(addLocalDays("2026-12-31", 1), "2027-01-01");
});

test("22:00 local scheduling converts across UTC date boundaries", () => {
  assert.equal(resolveLocalOccurrence("2026-01-15", "22:00", "America/New_York").toISOString(), "2026-01-16T03:00:00.000Z");
  assert.equal(dueOccurrencesAtInstant([{
    medication_id: 1, time_zone: "America/New_York", time_str: "22:00", start_date: "2026-01-15", end_date: "2026-01-15"
  }], new Date("2026-01-16T03:00:20Z")).length, 1);
});

test("DST gap shifts forward and repeated time chooses earlier instant", () => {
  assert.equal(resolveLocalOccurrence("2026-03-08", "02:30", "America/New_York").toISOString(), "2026-03-08T07:00:00.000Z");
  assert.equal(resolveLocalOccurrence("2026-11-01", "01:30", "America/New_York").toISOString(), "2026-11-01T05:30:00.000Z");
});

test("production due selection dispatches DST gaps and only the earlier overlap", () => {
  const row = {
    medication_id: 1,
    time_zone: "America/New_York",
    time_str: "02:30",
    start_date: "2026-01-01",
    end_date: "2026-12-31"
  };
  const gap = dueOccurrencesAtInstant([row], new Date("2026-03-08T07:00:20Z"));
  assert.equal(gap.length, 1);
  assert.equal(gap[0].localDate, "2026-03-08");
  assert.equal(gap[0].scheduledAtUtc.toISOString(), "2026-03-08T07:00:00.000Z");

  const overlapRow = { ...row, time_str: "01:30" };
  assert.equal(dueOccurrencesAtInstant([overlapRow], new Date("2026-11-01T05:30:30Z")).length, 1);
  assert.equal(dueOccurrencesAtInstant([overlapRow], new Date("2026-11-01T06:30:30Z")).length, 0);
  assert.equal(dueOccurrencesAtInstant([{ ...row, start_date: "2026-03-09" }], new Date("2026-03-08T07:00:00Z")).length, 0);
});

test("scheduler reconciliation catches a missed exact Cron minute and respects the grace boundary", () => {
  const row = {
    medication_id: 1,
    time_zone: "Asia/Kolkata",
    time_str: "07:30",
    start_date: "2026-10-14",
    end_date: "2026-10-15"
  };
  const withinGrace = occurrencesThroughInstant([row], new Date("2026-10-14T02:00:59Z"));
  assert.equal(withinGrace.length, 1);
  assert.equal(withinGrace[0].eventType, "REMINDER");
  assert.equal(withinGrace[0].scheduledAtUtc.toISOString(), "2026-10-14T02:00:00.000Z");

  const pastGrace = occurrencesThroughInstant([row], new Date("2026-10-14T02:01:00Z"));
  assert.equal(pastGrace.length, 1);
  assert.equal(pastGrace[0].eventType, "MISSED");
  assert.equal(pastGrace[0].localDate, "2026-10-14");

  const afterMidnight = occurrencesThroughInstant([{
    ...row, time_str: "23:30", start_date: "2026-10-13", end_date: "2026-10-13"
  }], new Date("2026-10-14T00:05:00Z"));
  assert.equal(afterMidnight.length, 1);
  assert.equal(afterMidnight[0].eventType, "MISSED");
  assert.equal(afterMidnight[0].localDate, "2026-10-13");
});

test("scheduled Worker creates and dispatches a MISSED occurrence after a delayed Cron run", async () => {
  let committed = false;
  const sent: any[] = [];
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM medications m JOIN medication_times")) return [[{
        medication_id: 11, user_id: 22, medication_name: "Medicine", dosage: "1 tablet",
        start_date: "2026-10-14", end_date: "2026-10-14", schedule_version: 1,
        time_zone: "Asia/Kolkata", time_str: "07:30"
      }], undefined];
      if (sql.startsWith("INSERT INTO dose_occurrences")) return [{ insertId: 55, affectedRows: 1 }, undefined];
      if (sql.includes("SELECT status FROM intake_logs")) return [[], undefined];
      if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) return [{ affectedRows: 1 }, undefined];
      if (sql.startsWith("INSERT INTO intake_logs")) return [{ insertId: 56, affectedRows: 1 }, undefined];
      return [{ affectedRows: 1 }, undefined];
    },
    beginTransaction: async () => { committed = false; },
    commit: async () => { committed = true; },
    rollback: async () => {},
    end: async () => {}
  };
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  mutableWorker.sendDoseNotification = async (_env: unknown, _db: unknown, dose: any) => {
    assert.equal(committed, true, "push dispatch must follow the committed MISSED transition");
    sent.push(dose);
  };
  try {
    await worker.processDueReminders({ TEST_DB_FACTORY: async () => db } as any, new Date("2026-10-14T02:01:00Z"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].occurrence_id, 55);
    assert.equal(sent[0].event_type, "MISSED");
    assert.equal(sent[0].local_date, "2026-10-14");
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});

test("Worker dispatch path sends a shifted spring-forward occurrence", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM medications m JOIN medication_times")) return [[{
        medication_id: 1, user_id: 2, medication_name: "Medicine", dosage: "5mg",
        start_date: "2026-03-08", end_date: "2026-03-08", schedule_version: 1,
        time_zone: "America/New_York", time_str: "02:30"
      }], undefined];
      if (sql.startsWith("INSERT INTO dose_occurrences")) return [{ insertId: 10, affectedRows: 1 }, undefined];
      if (sql.includes("FROM push_subscriptions")) return [[{ id: 3, subscription_data: JSON.stringify(fixture.subscription) }], undefined];
      if (sql.startsWith("INSERT IGNORE")) return [{ affectedRows: 1 }, undefined];
      if (sql.includes("FROM dose_occurrences")) return [[{ id: 10 }], undefined];
      if (sql.startsWith("SELECT id FROM push_delivery_attempts")) return [[{ id: 20 }], undefined];
      return [{ affectedRows: 1 }, undefined];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    end: async () => {}
  };
  try {
    await worker.processDueReminders({ ...fixture.env, TEST_DB_FACTORY: async () => db } as any, new Date("2026-03-08T07:00:20Z"));
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduler work stays bounded for a representative same-zone schedule volume", () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    medication_id: index + 1,
    time_zone: "UTC",
    time_str: `${String(Math.floor(index % 1_440 / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
    start_date: "2026-01-01",
    end_date: "2026-12-31"
  }));
  const started = performance.now();
  const due = dueOccurrencesAtInstant(rows, new Date("2026-06-01T12:00:20Z"));
  const elapsed = performance.now() - started;
  assert.equal(due.length, 7);
  assert.ok(elapsed < 1_000, `10,000 schedules took ${elapsed.toFixed(1)}ms`);
});

test("IANA zones are validated and canonicalized", () => {
  assert.equal(canonicalTimeZone("Asia/Kolkata"), "Asia/Calcutta");
  assert.equal(canonicalTimeZone("not/a-zone"), null);
  assert.equal(canonicalTimeZone(""), null);
});
