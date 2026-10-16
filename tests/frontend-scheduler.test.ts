import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function schedulerHelpers() {
  const source = await readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function medicationCalendarDate(");
  const end = source.indexOf("async function renderDashboard", start);
  assert.ok(start >= 0 && end > start, "scheduler calendar helpers must remain loadable");
  return new Function(`${source.slice(start, end)}; return { medicationCalendarDate, isMedicationActiveToday };`)();
}

test("scheduler treats a UTC-midnight API date as the same local medication date", async () => {
  const { isMedicationActiveToday, medicationCalendarDate } = await schedulerHelpers();
  assert.equal(medicationCalendarDate("2026-10-16T00:00:00.000Z"), "2026-10-16");
  assert.equal(isMedicationActiveToday({ name: "future reminder", startDate: "2026-10-16T00:00:00.000Z", endDate: "2026-10-16T00:00:00.000Z" }, "2026-10-16"), true);
});

test("scheduler still excludes a medication that starts on a later calendar date", async () => {
  const { isMedicationActiveToday } = await schedulerHelpers();
  assert.equal(isMedicationActiveToday({ name: "not started", startDate: "2026-10-17T00:00:00.000Z", endDate: "2026-10-18T00:00:00.000Z" }, "2026-10-16"), false);
});
