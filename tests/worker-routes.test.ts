import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

const patient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };
const caregiver = { id: 2, email: "caregiver@example.test", password_hash: "password123", name: "Caregiver", role: "CAREGIVER", patient_email: patient.email, time_zone: "UTC", accepted_terms: 1 };

class RouteDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  actor = patient;
  medication = { id: 7, user_id: 1, name: "Current med", dosage: "5mg", instructions: null, start_date: "2026-01-01", end_date: "2026-12-31", active: 1, schedule_version: 3 };

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);
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
  async commit() {}
  async rollback() {}
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

test("protected routes reject missing authorization before database writes", async () => {
  const db = new RouteDbAdapter();
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/user/time-zone", { method: "PUT", body: JSON.stringify({ timeZone: "UTC" }) }), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});
