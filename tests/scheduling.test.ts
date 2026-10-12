import test from "node:test";
import assert from "node:assert/strict";
import { addLocalDays, canonicalTimeZone, dueOccurrencesAtInstant, isDateInMedicationRange, occurrenceForInstant, resolveLocalOccurrence, zonedParts } from "../cloudflare-worker/scheduling.ts";
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

test("Worker dispatch path sends a shifted spring-forward occurrence", async () => {
  const fixture = await webPushFixture();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(null, { status: 201 }); };
  const db: any = {
    query: async (sql: string) => {
      if (sql.includes("FROM medications m JOIN medication_times")) return [[{
        medication_id: 1, user_id: 2, medication_name: "Medicine", dosage: "5mg",
        start_date: "2026-01-01", end_date: "2026-12-31", schedule_version: 1,
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
