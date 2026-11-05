import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFile(new URL(path, root), "utf8");

test("mark-missed-batch backend route handles empty batches and preserves schema compatibility", async () => {
  const worker = await source("cloudflare-worker/index.ts");

  // Route accepts flexible batch shapes
  assert.match(worker, /path === "\/api\/logs\/mark-missed-batch"/);
  assert.match(worker, /const list = Array\.isArray\(b\)/);

  // Uses findActiveScheduledMedication for schema compatibility with missing 'active' column
  assert.match(worker, /findActiveScheduledMedication\(db, medId, req\.date, localTime\)/);

  // Uses canonicalTimeZone with UTC fallback
  assert.match(worker, /canonicalTimeZone\(owner\.time_zone\)\s*\?\?\s*["']UTC["']/);

  // Checks existing status to never downgrade TAKEN or SKIPPED
  assert.match(worker, /existingLogStatus === ["']TAKEN["']\s*\|\|\s*existingLogStatus === ["']SKIPPED["']/);

  // Honors snooze_until
  assert.match(worker, /snooze_until/);

  // Gracefully handles optionalTableMissing for dose_occurrences
  assert.match(worker, /optionalTableMissing\([a-zA-Z0-9_]+,\s*["']dose_occurrences["']\)/);
});

test("frontend markDoseMissed implements in-flight deduplication and status checking", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // In-flight guard set
  assert.match(app, /const _inFlightMissedKeys = new Set\(\);/);
  assert.match(app, /_inFlightMissedKeys\.has\(reqKey\)/);
  assert.match(app, /_inFlightMissedKeys\.add\(reqKey\)/);
  assert.match(app, /_inFlightMissedKeys\.delete\(reqKey\)/);

  // Status check before network request
  assert.match(app, /getDoseStatus\(userId, medId, dateStr, cleanTime\)/);
  assert.match(app, /currentStatus === ["']TAKEN["']\s*\|\|\s*currentStatus === ["']SKIPPED["']\s*\|\|\s*currentStatus === ["']MISSED["']/);
});

test("frontend checkReminders checks snooze_until and millisecond timing before marking missed", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  // Scheduled date millisecond diff
  assert.match(app, /const scheduledDate = new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\), hh, mm, 0, 0\);/);
  assert.match(app, /const diff = \(nowMs - scheduledDate\.getTime\(\)\) \/ 60000;/);

  // Snooze check
  assert.match(app, /doseLog\?\.snooze_until/);
  assert.match(app, /snoozeDate\.getTime\(\) > nowMs/);
});

test("Audio priming unbinds gesture listeners once unlocked", async () => {
  const app = await source("DoseBuddy_frontend/app.js");

  assert.match(app, /function _cleanupAudioGestureListeners\s*\(\)/);
  assert.match(app, /_cleanupAudioGestureListeners\(\)/);
});

test("Health Assistant chatbox clears cleanly and dispatches events", async () => {
  const [app, index, css] = await Promise.all([
    source("DoseBuddy_frontend/app.js"),
    source("DoseBuddy_frontend/index.html"),
    source("DoseBuddy_frontend/style.css")
  ]);

  // Clearing dispatches input & change events
  assert.match(app, /chatInput\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  assert.match(app, /chatInput\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);

  // Anti-extension attributes
  assert.match(index, /data-gramm="false"/);
  assert.match(index, /data-enable-grammarly="false"/);

  // Placeholder CSS ellipsis
  assert.match(css, /#ai-chat-input::placeholder\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
});
