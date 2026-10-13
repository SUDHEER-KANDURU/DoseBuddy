import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

const patient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };
const caregiver = { id: 2, email: "caregiver@example.test", password_hash: "password123", name: "Caregiver", role: "CAREGIVER", patient_email: patient.email, time_zone: "UTC", accepted_terms: 1 };

class RouteDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  actor = patient;
  medication = { id: 7, user_id: 1, name: "Current med", dosage: "5mg", instructions: null, start_date: "2026-01-01", end_date: "2026-12-31", active: 1, schedule_version: 3 };
  failMedicationInsert?: Error;
  failTimeZoneUpdate?: Error;
  medicationInsertFailures = 0;
  commits = 0;
  rollbacks = 0;

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);
    if (statement.startsWith("INSERT INTO medications") && this.failMedicationInsert && this.medicationInsertFailures++ === 0) throw this.failMedicationInsert;
    if (statement.startsWith("UPDATE users SET time_zone") && this.failTimeZoneUpdate) throw this.failTimeZoneUpdate;
    if (statement.includes("FROM users WHERE email=?")) {
      const user = String(values[0]) === caregiver.email ? caregiver : patient;
      return [[user], undefined];
    }
    if (statement.includes("FROM users WHERE id=?")) {
      return [[Number(values[0]) === caregiver.id ? caregiver : patient], undefined];
    }
    if (statement.includes("SELECT * FROM medications WHERE id=? FOR UPDATE")) return [[this.medication], undefined];
    if (statement.includes("SELECT m.* FROM medications m JOIN medication_times")) return [[this.medication], undefined];
    if (statement.includes("JSON_ARRAYAGG") && statement.includes("FROM medications")) {
      return [[{ ...this.medication, times: [{ id: 1, timeOfDay: "08:00:00" }] }], undefined];
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

function env(db: RouteDbAdapter): any {
  return { JWT_SECRET: "route-test-secret", TEST_DB_FACTORY: async () => db };
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

  const subscribe = await worker.fetch(authorized("/api/push/subscribe", accessToken, "POST", { subscription: { endpoint: "https://push.example/1" }, timeZone: "UTC" }), env(db));
  assert.equal(subscribe.status, 200);

  const remove = await worker.fetch(authorized("/api/medications/7", accessToken, "DELETE"), env(db));
  assert.equal(remove.status, 204);
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
