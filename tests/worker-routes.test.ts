import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";
import { webPushFixture } from "./web-push-fixture.ts";

const patient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };
const caregiver = { id: 2, email: "caregiver@example.test", password_hash: "password123", name: "Caregiver", role: "CAREGIVER", patient_email: patient.email, time_zone: "UTC", accepted_terms: 1 };

class RouteDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  actor = patient;
  medication = { id: 7, user_id: 1, name: "Current med", dosage: "5mg", instructions: null, start_date: "2026-01-01", end_date: "2026-12-31", active: 1, schedule_version: 3 };
  failMedicationInsert?: Error;
  failTimeZoneUpdate?: Error;
  failIntakeLogInsert?: Error;
  medicationInsertFailures = 0;
  commits = 0;
  rollbacks = 0;
  activePushSubscriptions: any[] = [];
  missingPushSubscriptionTable = false;

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);
    if (statement.startsWith("INSERT INTO medications") && this.failMedicationInsert && this.medicationInsertFailures++ === 0) throw this.failMedicationInsert;
    if (statement.startsWith("UPDATE users SET time_zone") && this.failTimeZoneUpdate) throw this.failTimeZoneUpdate;
    if (statement.startsWith("INSERT INTO intake_logs") && this.failIntakeLogInsert) throw this.failIntakeLogInsert;
    if (statement.includes("FROM users WHERE email=?")) {
      const user = String(values[0]) === caregiver.email ? caregiver : patient;
      return [[user], undefined];
    }
    if (statement.includes("FROM users WHERE id=?")) {
      return [[Number(values[0]) === caregiver.id ? caregiver : patient], undefined];
    }
    if (statement.includes("SELECT id,endpoint,subscription_data FROM push_subscriptions") && this.missingPushSubscriptionTable) {
      throw Object.assign(new Error("Table 'dosebuddy_test.push_subscriptions' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    }
    if (statement.includes("SELECT id,endpoint,subscription_data FROM push_subscriptions")) return [this.activePushSubscriptions, undefined];
    if (statement.includes("COUNT(DISTINCT event_id)")) return [[{ c: 0 }], undefined];
    if (statement.includes("SELECT * FROM medications WHERE id=? FOR UPDATE")) return [[this.medication], undefined];
    if (statement.includes("SELECT m.* FROM medications m JOIN medication_times")) return [[this.medication], undefined];
    if (statement.includes("JSON_ARRAYAGG") && statement.includes("FROM medications")) {
      return [[{ ...this.medication, times: [{ id: 1, timeOfDay: "08:00:00" }] }], undefined];
    }
    if (statement.includes("FROM intake_logs l JOIN medications m")) {
      return [[{ id: 4, date: "2026-10-13", time: "09:00", medicationId: 7, medicineName: this.medication.name, dosage: this.medication.dosage, status: "MISSED" }], undefined];
    }
    if (statement.startsWith("INSERT INTO medications")) return [{ insertId: 8, affectedRows: 1 }, undefined];
    if (statement.startsWith("INSERT INTO dose_occurrences")) return [{ insertId: 9, affectedRows: 1 }, undefined];
    if (statement.startsWith("UPDATE dose_occurrences")) return [{ affectedRows: 1 }, undefined];
    if (statement.startsWith("INSERT INTO intake_logs")) return [{ insertId: 11, affectedRows: 1 }, undefined];
    return [{ affectedRows: 1, insertId: 12 }, undefined];
  }
  async beginTransaction() {}
  async commit() { this.commits++; }
  async rollback() { this.rollbacks++; }
  async end() {}
}

function env(db: RouteDbAdapter, additions: Record<string, unknown> = {}): any {
  return { ...additions, JWT_SECRET: "route-test-secret", TEST_DB_FACTORY: async () => db };
}

async function login(db: RouteDbAdapter, email = patient.email) {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" })
  }), env(db));
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

function authorized(path: string, token: string, method = "GET", body?: unknown) {
  return new Request(`https://dosebuddy.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("auth routes execute their existing response contracts", async () => {
  const db = new RouteDbAdapter();
  const invalidSignup = await worker.fetch(new Request("https://dosebuddy.test/api/auth/signup", { method: "POST", body: "{}" }), env(db));
  assert.equal(invalidSignup.status, 400);

  const session = await login(db);
  assert.equal(session.id, patient.id);
  assert.equal(session.timeZone, "UTC");
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);

  const refresh = await worker.fetch(new Request("https://dosebuddy.test/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken })
  }), env(db));
  assert.equal(refresh.status, 200);
  assert.ok((await refresh.json() as any).accessToken);
});

test("history route returns the medicineName field used by the UI", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/logs/history/1?page=0&size=100", accessToken), env(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    id: 4,
    date: "2026-10-13",
    time: "09:00",
    medicationId: 7,
    medicineName: "Current med",
    dosage: "5mg",
    status: "MISSED"
  }]);
});

test("medication, push, and TAKEN routes execute through the database adapter", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);

  const add = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", {
    name: "New med", dosage: "10mg", startDate: "2026-01-01", endDate: "2026-12-31", times: ["08:00"]
  }), env(db));
  assert.equal(add.status, 200);

  const today = await worker.fetch(authorized("/api/medications/today/1", accessToken), env(db));
  assert.equal(today.status, 200);
  assert.equal((await today.json() as any[])[0].id, 7);

  const update = await worker.fetch(authorized("/api/medications/7", accessToken, "PUT", { times: ["09:00"] }), env(db));
  assert.equal(update.status, 200);
  assert.ok(db.calls.some(([sql]) => sql.includes("schedule_version=schedule_version+1")));
  assert.ok(db.calls.some(([sql]) => sql.includes("outcome='OBSOLETE'")));

  const mark = await worker.fetch(authorized("/api/logs/mark", accessToken, "POST", { medicationId: 7, date: "2026-06-01", time: "09:00", status: "TAKEN" }), env(db));
  assert.equal(mark.status, 200);
  assert.equal((await mark.json() as any).success, true);

  const subscribe = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", { subscription: { endpoint: "https://push.example/1", keys: { p256dh: "BPXV", auth: "k9xO" } }, timeZone: "UTC" }), env(db));
  assert.equal(subscribe.status, 200);

  const remove = await worker.fetch(authorized("/api/medications/7", accessToken, "DELETE"), env(db));
  assert.equal(remove.status, 204);
});

test("Mark as Taken reports database persistence failures as server errors", async () => {
  const db = new RouteDbAdapter();
  db.failIntakeLogInsert = Object.assign(new Error("Unknown column 'occurrence_id' in 'field list'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/logs/mark", accessToken, "POST", {
    medicationId: 7, date: "2026-06-01", time: "09:00", status: "TAKEN"
  }), env(db));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: "Dose status could not be saved because of a server error. Please try again." });
});

test("background push test reports missing VAPID configuration without claiming delivery", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "VAPID_NOT_CONFIGURED",
    message: "Background push is unavailable because the Worker is missing its VAPID configuration."
  });
});

test("background push test identifies missing subscription storage before provider dispatch", async () => {
  const fixture = await webPushFixture();
  const db = new RouteDbAdapter();
  db.missingPushSubscriptionTable = true;
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "PUSH_STORAGE_NOT_CONFIGURED",
    message: "Push subscription storage is not installed. Apply the notification database migration."
  });
  assert.ok(db.calls.some(([sql]) => sql.includes("SELECT id,endpoint,subscription_data FROM push_subscriptions")));
});

test("background push test submits through VAPID and records provider acceptance separately", async () => {
  const fixture = await webPushFixture();
  const db = new RouteDbAdapter();
  db.activePushSubscriptions = [{ id: 23, endpoint: fixture.subscription.endpoint, subscription_data: JSON.stringify(fixture.subscription) }];
  const { accessToken } = await login(db);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (_input: any, init?: any) => {
    providerCalls++;
    assert.equal(init.method, "POST");
    return new Response(null, { status: 201 });
  };
  try {
    const response = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.providerAcceptedCount, 1);
    assert.equal(result.attempts[0].outcome, "SENT");
    assert.equal(result.attempts[0].providerStatus, 201);
    assert.equal(result.attempts[0].ledgerRecorded, true);
    assert.equal(providerCalls, 1);
    assert.ok(db.calls.some(([sql]) => sql.includes("INSERT INTO push_delivery_attempts") && sql.includes("'TEST'")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("today logs return a saved TAKEN dose for legacy schema without time_zone or medications.active", async () => {
  class LegacyDoseDb extends RouteDbAdapter {
    savedLog: any = null;

    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("FROM users WHERE id=?")) {
        this.calls.push([statement, values]);
        return [[{ ...patient, time_zone: null }], undefined];
      }
      if (statement.includes("FROM medications m JOIN medication_times") && statement.includes("m.active=1")) {
        this.calls.push([statement, values]);
        throw Object.assign(new Error("Unknown column 'm.active' in 'where clause'"), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
      }
      if (statement.includes("FROM medications m JOIN medication_times") && statement.includes("m.user_id=?")) {
        this.calls.push([statement, values]);
        return [[{ med_id: 7, med_name: this.medication.name, dosage: this.medication.dosage, time_of_day: "08:00:00" }], undefined];
      }
      if (statement.startsWith("INSERT INTO intake_logs")) {
        this.savedLog = { id: 11, medication_id: values[2], date: values[3], time: values[4], status: values[5] };
        return [{ insertId: 11, affectedRows: 1 }, undefined];
      }
      if (statement.startsWith("SELECT id, medication_id, DATE_FORMAT(date")) {
        this.calls.push([statement, values]);
        return [[this.savedLog && this.savedLog.date === values[1] ? this.savedLog : null].filter(Boolean), undefined];
      }
      return super.query(statement, values);
    }
  }

  const db = new LegacyDoseDb();
  const { accessToken } = await login(db);
  const mark = await worker.fetch(authorized("/api/logs/mark", accessToken, "POST", {
    medicationId: 7, date: "2026-06-01", time: "08:00", status: "TAKEN"
  }), env(db));
  assert.equal(mark.status, 200);
  assert.equal(db.savedLog?.status, "TAKEN");

  const today = await worker.fetch(authorized("/api/logs/today/1?date=2026-06-01", accessToken), env(db));
  assert.equal(today.status, 200);
  assert.deepEqual(await today.json(), [{
    id: 11,
    date: "2026-06-01",
    time: "08:00",
    medicationId: 7,
    medicationName: "Current med",
    dosage: "5mg",
    status: "TAKEN"
  }]);
});

test("medication ownership is enforced by the production update route", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db, caregiver.email);
  const response = await worker.fetch(authorized("/api/medications/7", accessToken, "PUT", { dosage: "changed" }), env(db));
  assert.equal(response.status, 403);
  assert.equal(db.calls.some(([sql]) => sql.startsWith("UPDATE medications SET")), false);
});
test("time-zone API saves valid zones and rejects invalid input", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const saved = await worker.fetch(authorized("/api/user/time-zone", accessToken, "PUT", { timeZone: "America/New_York" }), env(db));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as any).timeZone, "America/New_York");
  const invalid = await worker.fetch(authorized("/api/user/time-zone", accessToken, "PUT", { timeZone: "not/a-zone" }), env(db));
  assert.equal(invalid.status, 400);
});

test("time-zone synchronization is idempotent and accepts a later valid zone change", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const canonicalKolkata = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone;
  for (const timeZone of ["Asia/Kolkata", "Asia/Kolkata", "America/New_York"]) {
    const response = await worker.fetch(authorized("/api/user/time-zone", accessToken, "PUT", { timeZone }), env(db));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).timeZone, timeZone === "Asia/Kolkata" ? canonicalKolkata : timeZone);
  }
  const writes = db.calls.filter(([sql]) => sql.startsWith("UPDATE users SET time_zone"));
  assert.deepEqual(writes.map(([, values]) => values[0]), [canonicalKolkata, canonicalKolkata, "America/New_York"]);
  assert.ok(writes.every(([, values]) => values[1] === patient.id));
});

test("missed batch commits one transition and shares dispatch with duplicate Cron processing", async () => {
  const db = new RouteDbAdapter();
  db.actor = { ...patient, time_zone: "Asia/Kolkata" };
  let occurrenceState = "PENDING";
  const baseQuery = db.query.bind(db);
  db.query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) {
      if (occurrenceState !== "PENDING") return [{ affectedRows: 0 }, undefined];
      occurrenceState = "MISSED";
      return [{ affectedRows: 1 }, undefined];
    }
    if (sql.includes("FROM dose_occurrences o JOIN medications m") && sql.includes("o.state='PENDING'")) {
      return [occurrenceState === "PENDING" ? [{
        occurrence_id: 9, medication_id: 7, user_id: 1, schedule_version: 3,
        local_date: "2026-01-01", time_str: "08:00", scheduled_at_utc: "2026-01-01 02:30:00.000",
        medication_name: "Current med", dosage: "5mg"
      }] : [], undefined];
    }
    if (sql.includes("FROM push_delivery_attempts")) return [[], undefined];
    return baseQuery(sql, values);
  };
  const { accessToken } = await login(db);
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  let dispatches = 0;
  mutableWorker.sendDoseNotification = async (_env: unknown, _db: unknown, dose: any) => {
    assert.equal(occurrenceState, "MISSED");
    assert.equal(db.commits, 1, "dispatch must start after the transaction commits");
    assert.equal(dose.event_type, "MISSED");
    dispatches++;
  };
  const envWithDb: any = { JWT_SECRET: "route-test-secret", TEST_DB_FACTORY: async () => db };
  const request = () => authorized("/api/logs/mark-missed-batch", accessToken, "POST", [
    { medicationId: 7, date: "2026-01-01", time: "08:00" }
  ]);
  try {
    const first = await worker.fetch(request(), envWithDb);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { created: 1 });
    await worker.processMissedDoses(envWithDb, new Date("2026-01-01T02:31:00Z"));
    const duplicate = await worker.fetch(request(), envWithDb);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { created: 0 });
    assert.equal(dispatches, 1, "batch and repeated scheduler processing must produce one logical dispatch");
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});

test("missed batch does not transition before the server-side grace deadline", async () => {
  const db = new RouteDbAdapter();
  db.actor = { ...patient, time_zone: "Asia/Kolkata" };
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/logs/mark-missed-batch", accessToken, "POST", [
    { medicationId: 7, date: "2099-01-01", time: "08:00" }
  ]), env(db));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { created: 0 });
  assert.equal(db.calls.some(([sql]) => sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")), false);
});

test("concurrent missed batch and Cron race produce one committed transition and dispatch", async () => {
  const db = new RouteDbAdapter();
  let occurrenceState = "PENDING";
  const baseQuery = db.query.bind(db);
  db.query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("UPDATE dose_occurrences SET state='MISSED'")) {
      if (occurrenceState !== "PENDING") return [{ affectedRows: 0 }, undefined];
      occurrenceState = "MISSED";
      return [{ affectedRows: 1 }, undefined];
    }
    if (sql.includes("FROM dose_occurrences o JOIN medications m") && sql.includes("o.state='PENDING'")) {
      return [[{ occurrence_id: 9, medication_id: 7, user_id: 1, schedule_version: 3, local_date: "2026-01-01", time_str: "08:00", scheduled_at_utc: "2026-01-01 08:00:00.000", medication_name: "Current med", dosage: "5mg" }], undefined];
    }
    if (sql.includes("FROM push_delivery_attempts")) return [[], undefined];
    return baseQuery(sql, values);
  };
  const { accessToken } = await login(db);
  const mutableWorker: any = worker;
  const originalSend = mutableWorker.sendDoseNotification;
  let dispatches = 0;
  mutableWorker.sendDoseNotification = async (_env: unknown, _db: unknown, dose: any) => {
    assert.equal(occurrenceState, "MISSED");
    assert.ok(db.commits > 0, "notification must follow a commit");
    assert.equal(dose.event_type, "MISSED");
    dispatches++;
  };
  const envWithDb: any = { JWT_SECRET: "route-test-secret", TEST_DB_FACTORY: async () => db };
  try {
    const batch = worker.fetch(authorized("/api/logs/mark-missed-batch", accessToken, "POST", [
      { medicationId: 7, date: "2026-01-01", time: "08:00" }
    ]), envWithDb);
    const cron = worker.processMissedDoses(envWithDb, new Date("2026-01-01T08:01:00Z"));
    const [response] = await Promise.all([batch, cron]);
    assert.equal(response.status, 200);
    assert.equal(occurrenceState, "MISSED");
    assert.equal(dispatches, 1, "the conditional transition winner alone should initiate dispatch");
  } finally {
    mutableWorker.sendDoseNotification = originalSend;
  }
});

test("time-zone API reports missing schema without assigning a fallback zone", async () => {
  const db = new RouteDbAdapter();
  db.failTimeZoneUpdate = Object.assign(new Error("Unknown column 'time_zone' in 'field list'"), { code: "ER_BAD_FIELD_ERROR" });
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/user/time-zone", accessToken, "PUT", { timeZone: "Asia/Kolkata" }), env(db));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    timeZone: null, schedulingAvailable: false, needsTimeZoneSetup: true,
    message: "Time-zone storage is not available yet; medication reminders cannot be scheduled until setup is completed."
  });
});

test("time-zone API preserves unrelated database errors", async () => {
  const db = new RouteDbAdapter();
  db.failTimeZoneUpdate = Object.assign(new Error("Database unavailable"), { code: "ER_CON_COUNT_ERROR" });
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/user/time-zone", accessToken, "PUT", { timeZone: "UTC" }), env(db));
  assert.equal(response.status, 500);
});

test("protected routes reject missing authorization before database writes", async () => {
  const db = new RouteDbAdapter();
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/user/time-zone", { method: "PUT", body: JSON.stringify({ timeZone: "UTC" }) }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});

test("manual medication save accepts the browser payload and commits its schedule", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", {
    userId: 999, name: "test", dosage: "1231", instructions: "", startDate: "2026-10-12", endDate: "2026-10-12", times: ["19:07"]
  }), env(db));
  assert.equal(response.status, 200);
  const medicationInsert = db.calls.find(([sql]) => sql.startsWith("INSERT INTO medications"));
  assert.deepEqual(medicationInsert?.[1], [patient.id, "test", "1231", "", "2026-10-12", "2026-10-12"]);
  assert.deepEqual(db.calls.find(([sql]) => sql.startsWith("INSERT INTO medication_times"))?.[1], [8, "19:07"]);
  assert.equal(db.commits, 1);
});

test("prescription medication save accepts default and multi-slot schedules for the authenticated actor", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", {
    userId: 999, name: "Example (generic)", dosage: "10mg", instructions: "with food", startDate: "2026-10-12", endDate: "2026-11-11", times: ["08:00", "13:00", "18:00"]
  }), env(db));
  assert.equal(response.status, 200);
  assert.deepEqual(db.calls.find(([sql]) => sql.startsWith("INSERT INTO medications"))?.[1], [patient.id, "Example (generic)", "10mg", "with food", "2026-10-12", "2026-11-11"]);
  assert.deepEqual(db.calls.filter(([sql]) => sql.startsWith("INSERT INTO medication_times")).map(([, values]) => values), [[8, "08:00"], [8, "13:00"], [8, "18:00"]]);
});

test("medication create rejects malformed schedules before database writes", async () => {
  for (const payload of [
    { name: "test", dosage: "1", startDate: "2026-02-30", endDate: "2026-03-01", times: ["08:00"] },
    { name: "test", dosage: "1", startDate: "2026-03-02", endDate: "2026-03-01", times: ["08:00"] },
    { name: "test", dosage: "1", startDate: "2026-03-01", endDate: "2026-03-01", times: [] },
    { name: "test", dosage: "1", startDate: "2026-03-01", endDate: "2026-03-01", times: ["08:00", "08:00"] },
    { name: "test", dosage: "1", startDate: "2026-03-01", endDate: "2026-03-01", times: ["25:00"] }
  ]) {
    const db = new RouteDbAdapter();
    const { accessToken } = await login(db);
    const callsBeforeAdd = db.calls.length;
    const response = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", payload), env(db));
    assert.equal(response.status, 400);
    assert.equal(db.calls.slice(callsBeforeAdd).some(([sql]) => !sql.includes("FROM users WHERE id=?")), false);
  }
});

test("today route honors ?date= and no longer hides the list when time_zone is NULL", async () => {
  // Reproduces the production bug: a user whose stored time_zone is NULL used to get [].
  const nullZonePatient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: null, accepted_terms: 1 };
  class NullZoneAdapter extends RouteDbAdapter {
    medication = { id: 7, user_id: 1, name: "Current med", dosage: "5mg", instructions: null, start_date: "2026-10-13", end_date: "2026-10-13", active: 1, schedule_version: 3 };
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("FROM users WHERE email=?") || statement.includes("FROM users WHERE id=?")) {
        this.calls.push([statement, values]);
        return [[nullZonePatient], undefined];
      }
      if (statement.includes("JSON_ARRAYAGG") && statement.includes("FROM medications")) {
        this.calls.push([statement, values]);
        // Honor the date comparison the handler passes so an out-of-range date yields [].
        const compareDate = String(values[1]);
        const inRange = this.medication.start_date <= compareDate && compareDate <= this.medication.end_date;
        return [inRange ? [{ ...this.medication, times: [{ id: 1, timeOfDay: "08:00:00" }] }] : [], undefined];
      }
      return super.query(statement, values);
    }
  }

  const db = new NullZoneAdapter();
  const { accessToken } = await login(db);

  const inRange = await worker.fetch(authorized("/api/medications/today/1?date=2026-10-13", accessToken), env(db));
  assert.equal(inRange.status, 200);
  const inRangeBody = await inRange.json() as any[];
  assert.equal(inRangeBody.length, 1);
  assert.equal(inRangeBody[0].id, 7);
  // The date reached the SQL comparison params.
  const todayCall = db.calls.find(([sql]) => sql.includes("JSON_ARRAYAGG"));
  assert.deepEqual(todayCall?.[1], [1, "2026-10-13", "2026-10-13"]);

  const outOfRange = await worker.fetch(authorized("/api/medications/today/1?date=2026-10-12", accessToken), env(db));
  assert.equal(outOfRange.status, 200);
  assert.deepEqual(await outOfRange.json(), []);

  const badFormat = await worker.fetch(authorized("/api/medications/today/1?date=13-10-2026", accessToken), env(db));
  assert.equal(badFormat.status, 400);
});

test("today route falls back to legacy medication schema after a successful add", async () => {
  class LegacyMedicationSchemaAdapter extends RouteDbAdapter {
    createdMedication: any = null;
    createdTimes: string[] = [];
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("JSON_ARRAYAGG") && statement.includes("m.active=1")) {
        this.calls.push([statement, values]);
        throw Object.assign(new Error("Unknown column 'm.active' in 'where clause'"), { code: "ER_BAD_FIELD_ERROR" });
      }
      if (statement.startsWith("INSERT INTO medications") && statement.includes("schedule_version")) {
        this.calls.push([statement, values]);
        throw Object.assign(new Error("Unknown column 'schedule_version' in 'field list'"), { code: "ER_BAD_FIELD_ERROR" });
      }
      if (statement.startsWith("INSERT INTO medications")) {
        const result = await super.query(statement, values);
        this.createdMedication = {
          id: 8, user_id: values[0], name: values[1], dosage: values[2], instructions: values[3],
          start_date: values[4], end_date: values[5], times: []
        };
        return result;
      }
      if (statement.startsWith("INSERT INTO medication_times")) {
        this.createdTimes.push(String(values[1]));
        return super.query(statement, values);
      }
      if (statement.includes("JSON_ARRAYAGG") && !statement.includes("m.active=1")) {
        this.calls.push([statement, values]);
        const compareDate = String(values[1]);
        const baseInRange = this.medication.start_date <= compareDate && compareDate <= this.medication.end_date;
        const created = this.createdMedication && this.createdMedication.start_date <= compareDate && compareDate <= this.createdMedication.end_date
          ? [{ ...this.createdMedication, times: this.createdTimes.map((time, index) => ({ id: index + 2, timeOfDay: `${time}:00` })) }]
          : [];
        return [[...(baseInRange ? [{ ...this.medication, times: [{ id: 1, timeOfDay: "08:00:00" }] }] : []), ...created], undefined];
      }
      return super.query(statement, values);
    }
  }

  const db = new LegacyMedicationSchemaAdapter();
  const { accessToken } = await login(db);
  const add = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", {
    name: "Legacy test med", dosage: "1 tablet", startDate: "2026-10-14", endDate: "2026-10-14", times: ["23:59"]
  }), env(db));
  assert.equal(add.status, 200);
  const response = await worker.fetch(authorized("/api/medications/today/1?date=2026-10-14", accessToken), env(db));
  assert.equal(response.status, 200);
  const body = await response.json() as any[];
  assert.equal(body.filter(med => med.id === 8).length, 1);
  assert.equal(body.find(med => med.id === 8).times[0].timeOfDay, "23:59:00");
  assert.ok(db.calls.some(([sql]) => sql.startsWith("INSERT INTO medications") && sql.includes("schedule_version")));
  assert.ok(db.calls.some(([sql]) => sql.startsWith("INSERT INTO medications") && !sql.includes("schedule_version")));
  assert.ok(db.calls.some(([sql, values]) => sql.includes("JSON_ARRAYAGG") && !sql.includes("m.active=1") && values[1] === "2026-10-14"));
});

test("GET /api/user/time-zone returns the stored zone instead of a 500", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/user/time-zone", accessToken), env(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).timeZone, "UTC");
});

test("signup defaults time_zone to UTC and honors a valid body zone", async () => {
  // The signup path first checks for an existing email; this adapter reports none so the INSERT runs.
  class SignupAdapter extends RouteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("SELECT id FROM users WHERE email=?")) {
        this.calls.push([statement, values]);
        return [[], undefined];
      }
      if (statement.startsWith("SELECT * FROM users WHERE id=?")) {
        this.calls.push([statement, values]);
        return [[{ ...patient, id: 42, time_zone: String(values[0]) }], undefined];
      }
      return super.query(statement, values);
    }
  }

  const db = new SignupAdapter();
  const defaulted = await worker.fetch(new Request("https://dosebuddy.test/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "New", email: "new@example.test", password: "password123" })
  }), env(db));
  assert.equal(defaulted.status, 200);
  const defaultInsert = db.calls.find(([sql]) => sql.startsWith("INSERT INTO users"));
  assert.equal(defaultInsert?.[1][10], "UTC");

  const db2 = new SignupAdapter();
  const zoned = await worker.fetch(new Request("https://dosebuddy.test/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "New", email: "new2@example.test", password: "password123", timeZone: "America/New_York" })
  }), env(db2));
  assert.equal(zoned.status, 200);
  const zonedInsert = db2.calls.find(([sql]) => sql.startsWith("INSERT INTO users"));
  assert.equal(zonedInsert?.[1][10], "America/New_York");
});

test("medication create retries with the legacy schema after notification-column failure", async () => {
  const db = new RouteDbAdapter();
  db.failMedicationInsert = Object.assign(new Error("Unknown column 'active' in 'field list'"), { code: "ER_BAD_FIELD_ERROR" });
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/medications/add", accessToken, "POST", {
    name: "test", dosage: "1", startDate: "2026-03-01", endDate: "2026-03-01", times: ["08:00"]
  }), env(db));
  assert.equal(response.status, 200);
  assert.deepEqual(
    db.calls.filter(([sql]) => sql.startsWith("INSERT INTO medications")).map(([sql, values]) => [sql, values]),
    [
      ["INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date,active,schedule_version) VALUES (?,?,?,?,?,?,1,1)", [patient.id, "test", "1", null, "2026-03-01", "2026-03-01"]],
      ["INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date) VALUES (?,?,?,?,?,?)", [patient.id, "test", "1", null, "2026-03-01", "2026-03-01"]]
    ]
  );
  assert.equal(db.rollbacks, 1);
  assert.equal(db.commits, 1);
});

// ── FEAT-001: subscribe upsert, health endpoint, test rate limit, explainFailure ──

const validSubscription = {
  endpoint: "https://push.example/endpoint-A",
  keys: { p256dh: "BPXVabc123", auth: "k9xO_auth" }
};

test("push subscribe takes ownership via UPDATE and leaves other devices untouched", async () => {
  // Endpoint already exists (owned by another user); UPDATE matches one row, so no INSERT.
  class SubscribeAdapter extends RouteDbAdapter {
    updateValues: unknown[] | null = null;
    insertValues: unknown[] | null = null;
    deactivations: unknown[][] = [];
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("UPDATE push_subscriptions SET user_id=?")) {
        this.calls.push([statement, values]);
        this.updateValues = values;
        return [{ affectedRows: 1 }, undefined];
      }
      if (statement.startsWith("INSERT INTO push_subscriptions")) {
        this.calls.push([statement, values]);
        this.insertValues = values;
        return [{ insertId: 50, affectedRows: 1 }, undefined];
      }
      if (statement.startsWith("UPDATE push_subscriptions SET active = 0") || statement.includes("SET active=0")) {
        this.deactivations.push(values);
        return [{ affectedRows: 1 }, undefined];
      }
      return super.query(statement, values);
    }
  }
  const db = new SubscribeAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", {
    subscription: validSubscription, timeZone: "UTC"
  }), env(db));
  assert.equal(response.status, 200);
  // UPDATE took ownership for the authenticated actor by full-value endpoint equality.
  assert.deepEqual(db.updateValues, [patient.id, JSON.stringify(validSubscription), validSubscription.endpoint]);
  // A matched UPDATE means no INSERT and no deactivation of any other device/row.
  assert.equal(db.insertValues, null);
  assert.equal(db.deactivations.length, 0);
  assert.equal(db.commits, 1);
});

test("push subscribe inserts a new row when no endpoint matches", async () => {
  class SubscribeInsertAdapter extends RouteDbAdapter {
    insertValues: unknown[] | null = null;
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("UPDATE push_subscriptions SET user_id=?")) {
        this.calls.push([statement, values]);
        return [{ affectedRows: 0 }, undefined];
      }
      if (statement.startsWith("INSERT INTO push_subscriptions")) {
        this.calls.push([statement, values]);
        this.insertValues = values;
        return [{ insertId: 51, affectedRows: 1 }, undefined];
      }
      return super.query(statement, values);
    }
  }
  const db = new SubscribeInsertAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", {
    subscription: validSubscription
  }), env(db));
  assert.equal(response.status, 200);
  assert.deepEqual(db.insertValues, [patient.id, validSubscription.endpoint, JSON.stringify(validSubscription)]);
  assert.equal(db.commits, 1);
});

test("push subscribe rejects non-https endpoints and missing keys with a generic message", async () => {
  const bad = [
    { endpoint: "http://push.example/x", keys: { p256dh: "a", auth: "b" } },
    { endpoint: "not-a-url", keys: { p256dh: "a", auth: "b" } },
    { endpoint: "https://push.example/x" },
    { endpoint: "https://push.example/x", keys: { p256dh: "", auth: "b" } },
    { endpoint: "https://push.example/x", keys: { p256dh: "a", auth: "" } },
    { endpoint: "https://push.example/x", keys: { p256dh: "has space", auth: "b" } }
  ];
  for (const subscription of bad) {
    const db = new RouteDbAdapter();
    const { accessToken } = await login(db);
    const response = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", { subscription }), env(db));
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.message, "Invalid push subscription");
    // Nothing about the rejected value is echoed back, and no subscription row is written.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("push.example"), false);
    assert.equal(db.calls.some(([sql]) => sql.includes("INTO push_subscriptions") || sql.startsWith("UPDATE push_subscriptions SET user_id=?")), false);
  }
});

test("push subscribe rolls back and never trusts a client-supplied user id on failure", async () => {
  class SubscribeFailAdapter extends RouteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("UPDATE push_subscriptions SET user_id=?")) {
        this.calls.push([statement, values]);
        throw Object.assign(new Error("Deadlock mid-upsert"), { code: "ER_LOCK_DEADLOCK" });
      }
      return super.query(statement, values);
    }
  }
  const db = new SubscribeFailAdapter();
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", {
    userId: 999, subscription: validSubscription
  }), env(db));
  assert.equal(response.status, 500);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.commits, 0);
  // The ownership UPDATE always binds the authenticated actor.id, never a client value.
  const upsert = db.calls.find(([sql]) => sql.startsWith("UPDATE push_subscriptions SET user_id=?"));
  assert.equal(upsert?.[1][0], patient.id);
});

// ── Health endpoint ──────────────────────────────────────────────────────────

class HealthAdapter extends RouteDbAdapter {
  activeSubCount = 1;
  dispatchRows: any[] = [];
  testRows: any[] = [];
  failureRows: any[] = [];
  missingLedgerTable = false;
  async query(statement: string, values: unknown[] = []): Promise<any> {
    if (statement.includes("COUNT(*) AS c FROM push_subscriptions")) {
      this.calls.push([statement, values]);
      return [[{ c: this.activeSubCount }], undefined];
    }
    if (statement.includes("FROM push_delivery_attempts")) {
      this.calls.push([statement, values]);
      if (this.missingLedgerTable) {
        throw Object.assign(new Error("Table 'dosebuddy_test.push_delivery_attempts' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
      }
      if (statement.includes("event_type='TEST'")) return [this.testRows, undefined];
      if (statement.includes("outcome IN ('RETRY'")) return [this.failureRows, undefined];
      return [this.dispatchRows, undefined];
    }
    return super.query(statement, values);
  }
}

test("health endpoint returns evidence only with no status field and redacts sensitive data", async () => {
  const db = new HealthAdapter();
  db.activeSubCount = 2;
  db.dispatchRows = [{ outcome: "SENT", event_type: "REMINDER", attempted_at: "2026-01-01T08:00:00.000Z", provider_status: 201 }];
  db.testRows = [{ outcome: "SENT", attempted_at: "2026-01-01T07:59:00.000Z", provider_status: 201 }];
  db.failureRows = [{ outcome: "RETRY", error_category: "provider", attempted_at: "2026-01-01T07:50:00.000Z" }];
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db, { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_EMAIL: "a@b.c" }));
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal("status" in body, false, "server must not resolve the §5.2 enum");
  assert.deepEqual(body.subscription, { exists: true, active: true, count: 2 });
  assert.equal(body.vapidConfigured, true);
  assert.equal(body.lastDispatch.outcome, "SENT");
  assert.equal(body.lastDispatch.eventType, "REMINDER");
  assert.equal(body.lastTest.outcome, "SENT");
  assert.equal(body.recentFailures[0].explanation, "The push service was busy; DoseBuddy will try again shortly.");
  assert.equal(body.actionRequired, true);
  // No endpoint/token/key/medication detail anywhere in the payload.
  const serialized = JSON.stringify(body);
  for (const leak of ["endpoint", "subscription_data", "p256dh", "auth", "Current med"]) {
    assert.equal(serialized.includes(leak), false, `response leaked ${leak}`);
  }
});

test("health vapidConfigured uses the three-key predicate", async () => {
  const db = new HealthAdapter();
  const { accessToken } = await login(db);
  const partial = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db, { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }));
  assert.equal((await partial.json() as any).vapidConfigured, false);
  const full = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db, { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_EMAIL: "a@b.c" }));
  assert.equal((await full.json() as any).vapidConfigured, true);
});

test("health endpoint excludes TEST from lastDispatch/recentFailures but surfaces it in lastTest", async () => {
  const db = new HealthAdapter();
  db.activeSubCount = 1;
  db.dispatchRows = []; // the only recent real-reminder row is absent
  db.testRows = [{ outcome: "FAILED", attempted_at: "2026-01-01T09:00:00.000Z", provider_status: 400 }];
  db.failureRows = []; // TEST failures never populate recentFailures
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db));
  const body = await response.json() as any;
  assert.equal(body.lastDispatch, null);
  assert.deepEqual(body.recentFailures, []);
  assert.equal(body.lastTest.outcome, "FAILED");
  // The dispatch/failure queries filter to REMINDER/MISSED only.
  assert.ok(db.calls.some(([sql]) => sql.includes("event_type IN ('REMINDER','MISSED') ORDER BY")));
  assert.ok(db.calls.some(([sql]) => sql.includes("outcome IN ('RETRY','EXPIRED','FAILED','UNCERTAIN')")));
});

test("health endpoint returns 403 for a non-owner and for a missing target (indistinguishable)", async () => {
  // A second patient (id 3) the caregiver fixture is NOT linked to.
  class OtherUserAdapter extends HealthAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("FROM users WHERE id=?") && Number(values[0]) === 3) {
        this.calls.push([statement, values]);
        return [[{ id: 3, email: "other@example.test", role: "PATIENT", time_zone: "UTC" }], undefined];
      }
      if (statement.includes("FROM users WHERE id=?") && Number(values[0]) === 404) {
        this.calls.push([statement, values]);
        return [[], undefined]; // missing target
      }
      return super.query(statement, values);
    }
  }
  const db = new OtherUserAdapter();
  const { accessToken } = await login(db);
  const nonOwner = await worker.fetch(authorized("/api/notifications/health/3", accessToken), env(db));
  assert.equal(nonOwner.status, 403);
  assert.deepEqual(await nonOwner.json(), { message: "Access denied" });
  const missing = await worker.fetch(authorized("/api/notifications/health/404", accessToken), env(db));
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { message: "Access denied" });
});

test("health endpoint authorizes the caregiver branch through the reused accessible helper", async () => {
  const db = new HealthAdapter();
  const { accessToken } = await login(db, caregiver.email);
  // caregiver.patient_email === patient.email, so accessible(caregiver, patient) is true.
  const response = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db, { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_EMAIL: "a@b.c" }));
  assert.equal(response.status, 200);
  assert.equal("status" in (await response.json() as any), false);
});

test("health endpoint tolerates a legacy schema missing the delivery-attempts table", async () => {
  const db = new HealthAdapter();
  db.missingLedgerTable = true;
  const { accessToken } = await login(db);
  const response = await worker.fetch(authorized("/api/notifications/health/1", accessToken), env(db));
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.lastDispatch, null);
  assert.equal(body.lastTest, null);
  assert.deepEqual(body.recentFailures, []);
});

// ── /api/push/test rate limit ─────────────────────────────────────────────────

class RateLimitAdapter extends RouteDbAdapter {
  presses = 0;              // distinct event_id count reported by the rate-count query
  ledgerWrites = 0;
  subs: any[];
  constructor(subs: any[]) { super(); this.subs = subs; }
  async query(statement: string, values: unknown[] = []): Promise<any> {
    if (statement.includes("SELECT id,endpoint,subscription_data FROM push_subscriptions")) {
      return [this.subs, undefined];
    }
    if (statement.includes("COUNT(DISTINCT event_id)")) {
      return [[{ c: this.presses }], undefined];
    }
    if (statement.startsWith("INSERT INTO push_delivery_attempts")) {
      this.ledgerWrites++;
      return [{ insertId: 1, affectedRows: 1 }, undefined];
    }
    return super.query(statement, values);
  }
}

test("push test allows 3 presses then rejects the 4th with RATE_LIMITED and no ledger row", async () => {
  const fixture = await webPushFixture();
  const db = new RateLimitAdapter([{ id: 23, endpoint: fixture.subscription.endpoint, subscription_data: JSON.stringify(fixture.subscription) }]);
  const { accessToken } = await login(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 201 });
  try {
    // Presses 1-3: the in-window distinct count seen is 0,1,2 — all < 3.
    for (let seen = 0; seen < 3; seen++) {
      db.presses = seen;
      const ok = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
      assert.equal(ok.status, 200);
    }
    assert.equal(db.ledgerWrites, 3);
    // 4th press: distinct count is now 3 -> 429, no send, no ledger row.
    db.presses = 3;
    const limited = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as any).code, "RATE_LIMITED");
    assert.equal(db.ledgerWrites, 3, "a rejected press must not write a ledger row");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("push test rate limit counts presses not rows for a multi-device user", async () => {
  const fixture = await webPushFixture();
  const db = new RateLimitAdapter([
    { id: 23, endpoint: fixture.subscription.endpoint, subscription_data: JSON.stringify(fixture.subscription) },
    { id: 24, endpoint: fixture.subscription.endpoint, subscription_data: JSON.stringify(fixture.subscription) }
  ]);
  const { accessToken } = await login(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 201 });
  try {
    // Each press writes >=2 ledger rows sharing one event_id, but presses==distinct count.
    for (let seen = 0; seen < 3; seen++) {
      db.presses = seen;
      const ok = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
      assert.equal(ok.status, 200);
    }
    assert.equal(db.ledgerWrites, 6, "two active subs means two rows per allowed press");
    db.presses = 3;
    const limited = await worker.fetch(authorized("/api/push/test", accessToken, "POST"), env(db, fixture.env));
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as any).code, "RATE_LIMITED");
    assert.equal(db.ledgerWrites, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── explainFailure pure mapping (§4.2) ────────────────────────────────────────

test("explainFailure maps every §4.2 pair and falls back without leaking raw codes", async () => {
  const explainFailure = (worker as any).explainFailure as (o: string | null, c: string | null) => string;
  const cases: Array<[string | null, string | null, string]> = [
    ["RETRY", "provider", "The push service was busy; DoseBuddy will try again shortly."],
    ["RETRY", "provider-retryable", "The push service was busy; DoseBuddy will try again shortly."],
    ["RETRY", "pre-dispatch", "DoseBuddy couldn't start sending the last reminder and will try again."],
    ["RETRY", "push-preparation-failed", "DoseBuddy had trouble preparing the last reminder and will try again."],
    ["RETRY", "lease-expired-before-dispatch", "A reminder attempt timed out before sending; DoseBuddy will try again."],
    ["EXPIRED", "expired-subscription", "This device's reminder registration expired. Re-enable reminders on this device."],
    ["EXPIRED", null, "This device's reminder registration expired. Re-enable reminders on this device."],
    ["FAILED", "provider", "The push service rejected the last reminder. Try a test notification."],
    ["FAILED", "provider-rejected", "The push service rejected the last reminder. Try a test notification."],
    ["FAILED", "push-preparation-failed", "DoseBuddy repeatedly failed to prepare the last reminder."],
    ["UNCERTAIN", "dispatch-uncertain", "A reminder was sent but delivery couldn't be confirmed."],
    ["UNCERTAIN", "lease-expired-after-dispatch", "A reminder may have been sent; delivery couldn't be confirmed."]
  ];
  const fallback = "A recent reminder had a problem DoseBuddy is still checking on.";
  for (const [outcome, category, expected] of cases) {
    assert.equal(explainFailure(outcome, category), expected);
  }
  // Unmapped pairs and nulls resolve to the fallback, never an empty string or raw code.
  for (const [outcome, category] of [["RETRY", "mystery-code"], ["SENT", null], [null, null], ["WEIRD", "500"]] as Array<[string | null, string | null]>) {
    assert.equal(explainFailure(outcome, category), fallback);
  }
  // No raw status/code text leaks for an unmapped numeric category.
  assert.equal(explainFailure("FAILED", "503").includes("503"), false);
});

// -- Prescription upload regression tests (FEAT-002) --------------------------
// These tests guard against the 15s frontend timeout regression: the Worker must
// respond with a structured result before the frontend's 60s authFetch timeout.
const GEMINI_MOCK_RESPONSE = {
  candidates: [{
    content: {
      parts: [{
        text: JSON.stringify({
          medicines: [{
            name: "TestMed",
            dosage: "10mg",
            form: "Tablet",
            morning: true,
            afternoon: false,
            evening: false,
            night: false,
            strength: "10mg",
            startDate: "",
            durationDays: 30,
            foodInstruction: "After meal",
            confidence: 0.95
          }]
        })
      }]
    }
  }]
};

test("prescription upload with JSON image body returns extraction shape", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, _init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify(GEMINI_MOCK_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(null, { status: 200 });
  };
  try {
    const response = await worker.fetch(
      authorized("/api/prescription/upload", accessToken, "POST", {
        images: [{ image: "dGVzdA==", mimeType: "image/jpeg", fileName: "test.jpg" }],
        userId: 1
      }),
      env(db, { GEMINI_API_KEY: "test-key" })
    );
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.medicines), "medicines should be an array");
    assert.ok(body.medicines.length > 0, "medicines array should be non-empty");
    assert.ok(typeof body.medicines[0].name === "string" && body.medicines[0].name.length > 0, "first medicine should have a non-empty name");
    assert.ok(typeof body.disclaimer === "string" && body.disclaimer.toLowerCase().includes("verify"), "disclaimer should contain 'verify'");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prescription upload with multipart form data returns extraction shape", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, _init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify(GEMINI_MOCK_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(null, { status: 200 });
  };
  try {
    const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // minimal PDF header bytes
    const formData = new FormData();
    formData.append("file", new File([fileBytes], "test.pdf", { type: "application/pdf" }));
    const request = new Request("https://dosebuddy.test/api/prescription/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      body: formData
    });
    const response = await worker.fetch(request, env(db, { GEMINI_API_KEY: "test-key" }));
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.medicines), "medicines should be an array");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prescription upload with empty multipart form returns 400", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const formData = new FormData();
  formData.append("userId", "1");
  const request = new Request("https://dosebuddy.test/api/prescription/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: formData
  });
  const response = await worker.fetch(request, env(db));
  assert.equal(response.status, 400);
  const body = await response.json() as any;
  assert.equal(body.message, "No file uploaded");
});

test("prescription upload with unsupported content type returns 400", async () => {
  const db = new RouteDbAdapter();
  const { accessToken } = await login(db);
  const request = new Request("https://dosebuddy.test/api/prescription/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "text/plain"
    },
    body: "hello"
  });
  const response = await worker.fetch(request, env(db));
  assert.equal(response.status, 400);
  const body = await response.json() as any;
  assert.equal(body.message, "Unsupported content type");
});

test("ai chat returns a successful response", async () => {
  const db = new RouteDbAdapter();
  const e = env(db, { GEMINI_API_KEY: "test-key" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, _init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello from the assistant" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { accessToken } = await login(db);
    const response = await worker.fetch(
      authorized("/api/ai/chat", accessToken, "POST", { message: "hello", conversationId: "t1", conversationState: {} }),
      e
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.success, true);
    assert.ok(typeof payload.message === "string" && payload.message.length > 0, "message should be a non-empty string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ai chat rejects a request with no auth token", async () => {
  const db = new RouteDbAdapter();
  const request = new Request("https://dosebuddy.test/api/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" })
  });
  const response = await worker.fetch(request, env(db, {}));
  assert.equal(response.status, 401);
  const body = await response.json() as any;
  assert.ok(
    body.message === "Unauthorized" || body.error === "Unauthorized" || /unauthorized/i.test(JSON.stringify(body)),
    `expected an Unauthorized body, got: ${JSON.stringify(body)}`
  );
});

test("ai chat surfaces a recoverable error when all providers fail", async () => {
  const db = new RouteDbAdapter();
  const e = env(db, { GEMINI_API_KEY: "k", GROQ_API_KEY: "k" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: any, _init?: any) => {
    return new Response("upstream error", { status: 500 });
  };
  try {
    const { accessToken } = await login(db);
    const response = await worker.fetch(
      authorized("/api/ai/chat", accessToken, "POST", { message: "hello", conversationId: "t3", conversationState: {} }),
      e
    );
    assert.equal(response.status, 200, "Worker should return 200 with a recoverable error, not propagate 500");
    const payload = await response.json() as any;
    assert.equal(payload.success, false, "success should be false when all providers fail");
    assert.ok(typeof payload.error === "string" && payload.error.length > 0, "error should be a non-empty string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ai chat includes the authenticated user medication context in the provider prompt", async () => {
  const db = new RouteDbAdapter();
  // medication.name is "Current med" (from RouteDbAdapter.medication)
  const e = env(db, { GEMINI_API_KEY: "test-key" });
  const originalFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    captured = String(init?.body ?? "");
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { accessToken } = await login(db);
    // "interact" + "medicines" → INTERACTION intent, which always includes
    // "Current medications: <name> <dosage>" in the prompt sent to the provider.
    await worker.fetch(
      authorized("/api/ai/chat", accessToken, "POST", {
        message: "Can these medicines interact with each other?",
        conversationId: "t4",
        conversationState: {}
      }),
      e
    );
    assert.ok(captured.includes("Current med"), `Expected provider prompt to include 'Current med', got: ${captured.slice(0, 200)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ai chat personal-phrase MEDICINE_INFO returns QUESTION/MEDICINE_SELECTION without calling AI provider", async () => {
  const db = new RouteDbAdapter();
  // RouteDbAdapter.medication.name is "Current med"; it is returned by the
  // JSON_ARRAYAGG query so userMedications will contain one entry.
  const e = env(db, { GEMINI_API_KEY: "test-key" });
  const originalFetch = globalThis.fetch;
  let providerCalled = false;
  globalThis.fetch = async (input: any, _init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (url.includes("generativelanguage.googleapis.com") || url.includes("api.groq.com")) {
      providerCalled = true;
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { accessToken } = await login(db);
    const response = await worker.fetch(
      authorized("/api/ai/chat", accessToken, "POST", {
        message: "Tell me about one of my medicines",
        conversationId: "t5",
        conversationState: {}
      }),
      e
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.success, true, `expected success:true, got: ${JSON.stringify(payload)}`);
    assert.equal(payload.messageType, "QUESTION", `expected QUESTION, got messageType=${payload.messageType}`);
    assert.equal(payload.questionType, "MEDICINE_SELECTION", `expected MEDICINE_SELECTION, got questionType=${payload.questionType}`);
    assert.ok(Array.isArray(payload.questions) && payload.questions.length > 0, "expected non-empty questions array");
    const firstOption = payload.questions[0];
    assert.ok(firstOption.value === "Current med" || firstOption.text.includes("Current med"), `expected 'Current med' in first option, got: ${JSON.stringify(firstOption)}`);
    assert.equal(providerCalled, false, "AI provider should NOT be called for a personal-phrase MEDICINE_INFO request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
