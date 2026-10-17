import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalDoseTag } from "../cloudflare-worker/notification-delivery.ts";

// The OS-level coalescing tag is the schedule-version- and event-type-independent
// `canonicalDoseTag` (see tests/notification-dedup.test.ts for the cross-runtime
// byte-identity contract). The frontend keeps a separate `doseEventId(...)` identity
// used ONLY as the in-tab `firedReminderKeys` / `firedMissedAlertKeys` guard key so a
// single open tab does not re-fire the same dose across the exact-time timer, the 15s
// checkReminders sweep, and the visibilitychange reconciler. This test pins both facts:
// (1) app.js routes every dose notification `tag` through the shared canonicalDoseTag,
// (2) doseEventId remains the in-tab guard identity.

async function loadAppSource(): Promise<string> {
  return readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
}

async function loadDoseEventId(): Promise<(...a: any[]) => string> {
  const source = await loadAppSource();
  const start = source.indexOf("function doseEventId(");
  assert.ok(start >= 0, "doseEventId helper must exist in app.js");
  const end = source.indexOf("\n}", start) + 2;
  return new Function(`${source.slice(start, end)}; return doseEventId;`)();
}

test("app.js imports the shared canonicalDoseTag and uses no obsolete per-type OS tag", async () => {
  const source = await loadAppSource();
  assert.match(source, /import\s*\{\s*canonicalDoseTag\s*\}\s*from\s*["']\.\/dose-tag\.js["']/,
    "app.js must import the shared canonicalDoseTag from dose-tag.js");
  // Every dose notification tag must go through canonicalDoseTag(...). The obsolete
  // schedule-version-dependent per-type tags must be gone.
  assert.doesNotMatch(source, /tag:\s*`reminder-\$\{/, "no obsolete reminder-${...} OS tag");
  assert.doesNotMatch(source, /tag:\s*`missed-\$\{/, "no obsolete missed-${...} OS tag");
  const tagUses = source.match(/tag:\s*canonicalDoseTag\(/g) ?? [];
  assert.ok(tagUses.length >= 3,
    `all dose notification tags must use canonicalDoseTag (found ${tagUses.length}, expected >= 3: reminder + two missed paths)`);
});

test("frontend canonicalDoseTag matches the server OS tag byte-for-byte", async () => {
  // dose-tag.js is the frontend copy; cross-runtime equality is asserted here and in
  // tests/notification-dedup.test.ts. Keep this as a second guard against drift.
  const { canonicalDoseTag: frontendTag } = await import("../DoseBuddy_frontend/dose-tag.js");
  const tag = frontendTag(3, 2, "2026-10-11", "08:00");
  assert.equal(tag, canonicalDoseTag(3, 2, "2026-10-11", "08:00"));
  assert.equal(tag, "dose-3-2-2026-10-11-0800");
});

test("doseEventId remains the in-tab guard identity (schedule-version-sensitive, one identity)", async () => {
  const doseEventId = await loadDoseEventId();
  const a = doseEventId("REMINDER", 3, 2, 7, "2026-10-11", "08:00");
  const b = doseEventId("REMINDER", 3, 2, 8, "2026-10-11", "08:00"); // different scheduleVersion
  // The in-tab guard stays schedule-version-sensitive so a mid-day edit re-fires once
  // for the new schedule even though the OS coalescing tag is version-independent.
  assert.notEqual(a, b, "a schedule-version bump must produce a new in-tab guard identity");
  assert.equal(a, "REMINDER:3:2:7:2026-10-11:08:00");

  const source = await loadAppSource();
  // The guard key feeds firedReminderKeys / firedMissedAlertKeys, not the OS tag.
  assert.match(source, /firedReminderKeys\.add\(key\)/, "doseEventId key must drive the in-tab reminder guard");
  assert.match(source, /firedMissedAlertKeys\.add\(missedKey\)/, "doseEventId key must drive the in-tab missed guard");
});
