import test from "node:test";
import assert from "node:assert/strict";
import { buildDoseNotificationPayload, notificationEventId, type DeliveryOccurrence } from "../cloudflare-worker/notification-delivery.ts";

test("dose event identity includes date, time, revision, and event type", () => {
  const base = { occurrenceId: 1, medicationId: 2, userId: 3, scheduleVersion: 4, localDate: "2026-10-11", localTime: "08:00", eventType: "REMINDER" as const };
  assert.notEqual(notificationEventId(base), notificationEventId({ ...base, localDate: "2026-10-12" }));
  assert.notEqual(notificationEventId(base), notificationEventId({ ...base, eventType: "MISSED" }));
});

test("reminder and missed push payloads leave icons to the service worker fallback", () => {
  const event: DeliveryOccurrence = { occurrenceId: 8, medicationId: 2, userId: 3, scheduleVersion: 4, localDate: "2026-10-11", localTime: "08:00", eventType: "MISSED" };
  const missed = buildDoseNotificationPayload(event, { medicationName: "Medicine", dosage: "5mg" });
  assert.equal(missed.title, "DoseBuddy - Missed Dose");
  // OS-facing tag is the schedule-version-independent canonical dose tag, not the
  // internal event id. The internal event id stays on data.doseId for the ledger.
  assert.equal(missed.tag, "dose-3-2-2026-10-11-0800");
  assert.equal(missed.data.doseId, notificationEventId(event));
  assert.equal("icon" in missed, false);
  assert.equal("badge" in missed, false);

  const reminder = buildDoseNotificationPayload({ ...event, eventType: "REMINDER" }, { medicationName: "Medicine", dosage: "5mg" });
  assert.equal(reminder.title, "DoseBuddy - Medication Reminder");
  assert.equal("icon" in reminder, false);
  assert.equal("badge" in reminder, false);
});
