import test from "node:test";
import assert from "node:assert/strict";
import { doseReminderAllowed, missedNotificationEligible, scheduleDate, scheduleInstant } from "../cloudflare-worker/scheduler-time.ts";

test("dose scheduling resolves local time and date boundaries", () => {
  const utc = scheduleInstant("2026-02-01", "00:10", "Asia/Kolkata");
  assert.equal(new Date(utc).toISOString(), "2026-01-31T18:40:00.000Z");
  assert.equal(scheduleDate(utc, "Asia/Kolkata"), "2026-02-01");
});

test("DST spring gaps resolve to the next valid wall time", () => {
  const instant = scheduleInstant("2026-03-08", "02:30", "America/New_York");
  assert.equal(new Date(instant).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(scheduleDate(instant, "America/New_York"), "2026-03-08");
});

test("DST fall repeated times resolve deterministically to the earlier occurrence", () => {
  const instant = scheduleInstant("2026-11-01", "01:30", "America/New_York");
  assert.equal(new Date(instant).toISOString(), "2026-11-01T05:30:00.000Z");
});

test("dose status gates reminder and missed notification actions", () => {
  assert.equal(doseReminderAllowed(null), true);
  assert.equal(doseReminderAllowed("PENDING"), true);
  assert.equal(doseReminderAllowed("TAKEN"), false);
  assert.equal(doseReminderAllowed("MISSED"), false);
  assert.equal(missedNotificationEligible("TAKEN"), false);
  assert.equal(missedNotificationEligible("PENDING"), true);
  assert.equal(missedNotificationEligible("MISSED"), true);
});
