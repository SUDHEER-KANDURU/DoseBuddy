import test from "node:test";
import assert from "node:assert/strict";
import { notificationEventId } from "../cloudflare-worker/notification-delivery.ts";

test("dose event identity includes date, time, revision, and event type", () => {
  const base = { occurrenceId: 1, medicationId: 2, userId: 3, scheduleVersion: 4, localDate: "2026-10-11", localTime: "08:00", eventType: "REMINDER" as const };
  assert.notEqual(notificationEventId(base), notificationEventId({ ...base, localDate: "2026-10-12" }));
  assert.notEqual(notificationEventId(base), notificationEventId({ ...base, eventType: "MISSED" }));
});
