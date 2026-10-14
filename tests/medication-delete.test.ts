import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare-worker/index.ts";

const patient = { id: 1, email: "patient@example.test", password_hash: "password123", name: "Patient", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };
const otherUser = { id: 2, email: "other@example.test", password_hash: "password123", name: "Other", role: "PATIENT", time_zone: "UTC", accepted_terms: 1 };
const JWT = "delete-test-secret";

// Base adapter: the medication id=7 is owned by `patient`. Every deletion
// query reports success unless a subclass overrides it to simulate a schema
// problem. Mirrors the fake-DB pattern in worker-routes.test.ts.
class DeleteDbAdapter {
  calls: Array<[string, unknown[]]> = [];
  medication: any = { id: 7, user_id: 1, name: "Target med", dosage: "5mg", instructions: null, start_date: "2026-01-01", end_date: "2026-12-31", active: 1, schedule_version: 1 };
  commits = 0;
  rollbacks = 0;
  began = 0;
  ended = 0;

  async query(statement: string, values: unknown[] = []): Promise<any> {
    this.calls.push([statement, values]);
    if (statement.includes("FROM users WHERE email=?")) {
      const user = String(values[0]) === otherUser.email ? otherUser : patient;
      return [[user], undefined];
    }
    if (statement.includes("FROM users WHERE id=?")) {
      return [[Number(values[0]) === otherUser.id ? otherUser : patient], undefined];
    }
    if (statement.includes("SELECT * FROM medications WHERE id=? FOR UPDATE")) {
      return [[this.medication ? { ...this.medication } : undefined], undefined];
    }
    // Mark-as-taken schedule lookup (both the modern "m.active=1" form and the
    // legacy fallback form).
    if (statement.includes("SELECT m.* FROM medications m JOIN medication_times")) {
      return [[this.medication ? { ...this.medication } : undefined], undefined];
    }
    return [{ affectedRows: 1, insertId: 1 }, undefined];
  }
  async beginTransaction() { this.began++; }
  async commit() { this.commits++; }
  async rollback() { this.rollbacks++; }
  async end() { this.ended++; }
}

function env(db: DeleteDbAdapter): any {
  return { JWT_SECRET: JWT, TEST_DB_FACTORY: async () => db };
}

async function login(db: DeleteDbAdapter, email = patient.email): Promise<string> {
  const response = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" })
  }), env(db));
  assert.equal(response.status, 200);
  return (await response.json() as any).accessToken as string;
}

function del(token: string, id = 7) {
  return new Request(`https://dosebuddy.test/api/medications/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
}

// MySQL-style error objects.
function noSuchTable(table: string) {
  return Object.assign(new Error(`Table 'dosebuddy.${table}' doesn't exist`), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
}
function badField(column: string) {
  return Object.assign(new Error(`Unknown column '${column}' in 'field list'`), { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
}
function connLost() {
  return Object.assign(new Error("Lost connection to MySQL server during query"), { code: "PROTOCOL_CONNECTION_LOST", errno: 2013 });
}

test("DELETE on the modern schema removes the medicine and its dependents, returns 204", async () => {
  const db = new DeleteDbAdapter();
  const token = await login(db);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 204);
  assert.equal(db.commits, 1);
  assert.equal(db.rollbacks, 0);
  const ran = (needle: string) => db.calls.some(([sql]) => sql.includes(needle));
  assert.ok(ran("DELETE FROM intake_logs WHERE medication_id=?"));
  assert.ok(ran("DELETE FROM medication_times WHERE medication_id=?"));
  assert.ok(ran("DELETE FROM medications WHERE id=?"));
  assert.ok(ran("UPDATE push_delivery_attempts"));
});

test("DELETE succeeds on a legacy schema missing push_delivery_attempts (was HTTP 500)", async () => {
  class LegacyNoAttempts extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("UPDATE push_delivery_attempts")) {
        this.calls.push([statement, values]);
        throw noSuchTable("push_delivery_attempts");
      }
      return super.query(statement, values);
    }
  }
  const db = new LegacyNoAttempts();
  const token = await login(db);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 204);
  assert.equal(db.commits, 1);
  assert.equal(db.rollbacks, 0);
  // The medication was still deleted despite the missing auxiliary table.
  assert.ok(db.calls.some(([sql]) => sql.includes("DELETE FROM medications WHERE id=?")));
});

test("DELETE tolerates a missing dose_occurrences table", async () => {
  class LegacyNoOccurrences extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("DELETE FROM dose_occurrences")) {
        this.calls.push([statement, values]);
        throw noSuchTable("dose_occurrences");
      }
      return super.query(statement, values);
    }
  }
  const db = new LegacyNoOccurrences();
  const token = await login(db);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 204);
  assert.equal(db.commits, 1);
});

test("DELETE of a nonexistent medicine returns 404 and never commits", async () => {
  const db = new DeleteDbAdapter();
  db.medication = null;
  const token = await login(db);
  const res = await worker.fetch(del(token, 999), env(db));
  assert.equal(res.status, 404);
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.calls.some(([sql]) => sql.includes("DELETE FROM medications")), false);
});

test("DELETE of another user's medicine returns 403 with no destructive writes", async () => {
  const db = new DeleteDbAdapter();
  // medication id=7 is owned by patient(1); authenticate as otherUser(2).
  const token = await login(db, otherUser.email);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 403);
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  const destructive = db.calls.some(([sql]) =>
    sql.startsWith("DELETE FROM medications") ||
    sql.startsWith("DELETE FROM intake_logs") ||
    sql.startsWith("DELETE FROM medication_times") ||
    sql.startsWith("DELETE FROM dose_occurrences") ||
    sql.startsWith("UPDATE push_delivery_attempts"));
  assert.equal(destructive, false);
});

test("DELETE propagates an unrelated database error as 500 and rolls back", async () => {
  class CoreDeleteFails extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("DELETE FROM medications")) {
        this.calls.push([statement, values]);
        throw connLost();
      }
      return super.query(statement, values);
    }
  }
  const db = new CoreDeleteFails();
  const token = await login(db);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 500);
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
});

test("DELETE does NOT swallow a bad-field error disguised as a push_delivery_attempts call", async () => {
  // A missing COLUMN (not a missing table) on push_delivery_attempts is a real
  // error, not an optional-schema gap, so it must propagate.
  class AttemptsBadField extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.startsWith("UPDATE push_delivery_attempts")) {
        this.calls.push([statement, values]);
        throw badField("outcome");
      }
      return super.query(statement, values);
    }
  }
  const db = new AttemptsBadField();
  const token = await login(db);
  const res = await worker.fetch(del(token), env(db));
  assert.equal(res.status, 500);
  assert.equal(db.rollbacks, 1);
});

test("repeated DELETE of the same medicine is idempotent: first 204, second 404", async () => {
  const db = new DeleteDbAdapter();
  const token = await login(db);
  const first = await worker.fetch(del(token), env(db));
  assert.equal(first.status, 204);
  // Simulate the row being gone on the second attempt.
  db.medication = null;
  const second = await worker.fetch(del(token), env(db));
  assert.equal(second.status, 404);
});

test("DELETE scopes every destructive statement to the target medication id only", async () => {
  const db = new DeleteDbAdapter();
  const token = await login(db);
  const res = await worker.fetch(del(token, 7), env(db));
  assert.equal(res.status, 204);
  // Every DELETE/UPDATE that touches history or dependents is bound to id 7.
  for (const [sql, values] of db.calls) {
    if (sql.includes("FROM intake_logs") || sql.includes("FROM medication_times") || sql.includes("FROM dose_occurrences") || (sql.includes("push_delivery_attempts") && sql.startsWith("UPDATE"))) {
      assert.deepEqual(values, ["7"], `expected ${sql} to be scoped to med 7`);
    }
    if (sql.startsWith("DELETE FROM medications")) {
      assert.deepEqual(values, ["7"]);
    }
  }
});

// ── Mark as Taken ─────────────────────────────────────────────────────────
function mark(token: string, body: unknown) {
  return new Request("https://dosebuddy.test/api/logs/mark", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
const MARK_BODY = { medicationId: 7, date: "2026-06-01", time: "08:00", status: "TAKEN" };

test("Mark as Taken on the modern schema records the occurrence and intake log", async () => {
  const db = new DeleteDbAdapter();
  const token = await login(db);
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).success, true);
  assert.ok(db.calls.some(([sql]) => sql.includes("INSERT INTO dose_occurrences")));
  assert.ok(db.calls.some(([sql]) => sql.includes("INSERT INTO intake_logs")));
  assert.equal(db.commits, 1);
});

test("Mark as Taken falls back to intake_logs when dose_occurrences is missing (was silent fail)", async () => {
  class LegacyNoOccurrences extends DeleteDbAdapter {
    intakeInsert: unknown[] | null = null;
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("dose_occurrences")) {
        this.calls.push([statement, values]);
        throw noSuchTable("dose_occurrences");
      }
      if (statement.startsWith("INSERT INTO intake_logs")) {
        this.intakeInsert = values;
      }
      return super.query(statement, values);
    }
  }
  const db = new LegacyNoOccurrences();
  const token = await login(db);
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).success, true);
  assert.equal(db.commits, 1);
  // The adherence row was still written, with a NULL occurrence_id.
  assert.ok(db.intakeInsert, "intake_logs insert must still run on legacy schema");
  assert.equal(db.intakeInsert![0], null);
});

test("Mark as Taken retries the medication lookup without the active column on a legacy schema", async () => {
  class LegacyNoActive extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("SELECT m.* FROM medications m JOIN medication_times") && statement.includes("m.active=1")) {
        this.calls.push([statement, values]);
        throw badField("active");
      }
      if (statement.includes("SELECT m.* FROM medications m JOIN medication_times") && !statement.includes("m.active=1")) {
        this.calls.push([statement, values]);
        return [[{ ...this.medication }], undefined];
      }
      return super.query(statement, values);
    }
  }
  const db = new LegacyNoActive();
  const token = await login(db);
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.equal(res.status, 200);
  assert.ok(db.calls.some(([sql]) => sql.includes("JOIN medication_times") && !sql.includes("m.active=1")));
  assert.equal(db.commits, 1);
});

test("Mark as Taken denies marking another user's dose (403) and writes nothing", async () => {
  const db = new DeleteDbAdapter();
  const token = await login(db, otherUser.email); // actor is otherUser(2), med owned by patient(1)
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.equal(res.status, 403);
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.calls.some(([sql]) => sql.startsWith("INSERT INTO intake_logs")), false);
});

test("Mark as Taken returns 400 when no active scheduled dose matches", async () => {
  class NoSchedule extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("SELECT m.* FROM medications m JOIN medication_times")) {
        this.calls.push([statement, values]);
        return [[], undefined];
      }
      return super.query(statement, values);
    }
  }
  const db = new NoSchedule();
  const token = await login(db);
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.equal(res.status, 400);
  assert.equal(db.commits, 0);
});

test("Mark as Taken does NOT report success when dose_occurrences fails for an unrelated reason", async () => {
  // A genuine failure (not a missing table) on the occurrence upsert must roll
  // back and surface an error, never a false success.
  class OccurrenceConnLost extends DeleteDbAdapter {
    async query(statement: string, values: unknown[] = []): Promise<any> {
      if (statement.includes("INSERT INTO dose_occurrences")) {
        this.calls.push([statement, values]);
        throw connLost();
      }
      return super.query(statement, values);
    }
  }
  const db = new OccurrenceConnLost();
  const token = await login(db);
  const res = await worker.fetch(mark(token, MARK_BODY), env(db));
  assert.notEqual(res.status, 200);
  assert.equal(db.commits, 0);
  assert.equal(db.rollbacks, 1);
  assert.equal(db.calls.some(([sql]) => sql.startsWith("INSERT INTO intake_logs")), false);
});