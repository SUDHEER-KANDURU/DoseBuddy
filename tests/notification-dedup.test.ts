import test from "node:test";
import assert from "node:assert/strict";
import { canonicalDoseTag as workerTag, buildDoseNotificationPayload } from "../cloudflare-worker/notification-delivery.ts";

const { canonicalDoseTag: frontendTag } = await import("../DoseBuddy_frontend/dose-tag.js");

const dose = { medicationName: "Medicine", dosage: "5mg" };
const base = { occurrenceId: 1, medicationId: 2, userId: 3, localDate: "2026-10-11", localTime: "08:00" };

test("foreground and background paths produce a byte-identical canonical tag (case 8)", () => {
  const tag = workerTag(3, 2, "2026-10-11", "08:00");
  assert.equal(tag, "dose-3-2-2026-10-11-0800");
  assert.equal(frontendTag(3, 2, "2026-10-11", "08:00"), tag);
});

test("canonical tag is schedule-version independent", () => {
  const v7 = buildDoseNotificationPayload({ ...base, scheduleVersion: 7, eventType: "REMINDER" }, dose);
  const v9 = buildDoseNotificationPayload({ ...base, scheduleVersion: 9, eventType: "REMINDER" }, dose);
  assert.equal(v7.tag, v9.tag);
  assert.equal(v7.tag, frontendTag(3, 2, "2026-10-11", "08:00"));
});

test("canonical tag is event-type independent", () => {
  const reminder = buildDoseNotificationPayload({ ...base, scheduleVersion: 7, eventType: "REMINDER" }, dose);
  const missed = buildDoseNotificationPayload({ ...base, scheduleVersion: 7, eventType: "MISSED" }, dose);
  assert.equal(reminder.tag, missed.tag);
  assert.equal(reminder.tag, frontendTag(3, 2, "2026-10-11", "08:00"));
});

test("ledger identity (doseId) still carries the schedule-version event id", () => {
  const reminder = buildDoseNotificationPayload({ ...base, scheduleVersion: 7, eventType: "REMINDER" }, dose);
  const missed = buildDoseNotificationPayload({ ...base, scheduleVersion: 7, eventType: "MISSED" }, dose);
  assert.equal(reminder.data.doseId, "REMINDER:3:2:7:2026-10-11:08:00");
  assert.equal(missed.data.doseId, "MISSED:3:2:7:2026-10-11:08:00");
  // The internal event id keeps scheduleVersion; only the OS tag dropped it.
  assert.ok(reminder.data.doseId.includes(":7:"));
  assert.ok(!reminder.tag.includes("7"));
});

test("colon is stripped from HH:MM regardless of a passed-in longer time string", () => {
  assert.equal(workerTag(3, 2, "2026-10-11", "08:00:00"), "dose-3-2-2026-10-11-0800");
  assert.equal(frontendTag(3, 2, "2026-10-11", "08:00:00"), "dose-3-2-2026-10-11-0800");
});
