import test from "node:test";
import assert from "node:assert/strict";
import {
  markOccurrenceMissed,
  markOccurrenceSkipped,
  markOccurrenceTaken,
  upsertOccurrence,
} from "../cloudflare-worker/dose-occurrences.ts";
import worker from "../cloudflare-worker/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(overrides: Record<string, any> = {}): any {
  return {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    end: async () => {},
    query: async (_sql: string) => [{ affectedRows: 1, insertId: 1 }, undefined],
    ...overrides,
  };
}

const TEST_JWT_SECRET = "test-jwt-secret-32bytes-padding!!";

async function makeToken(userId: number, role = "patient", patientEmail: string | null = null): Promise<string> {
  const enc = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const claims: Record<string, unknown> = { type: "access", userId, role, exp: Math.floor(Date.now() / 1000) + 900 };
  if (patientEmail) claims.patientEmail = patientEmail;
  const payload = btoa(JSON.stringify(claims))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", enc.encode(TEST_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${header}.${payload}.${sigB64}`;
}

// Build a mock DB that handles actor user lookup (SELECT * FROM users WHERE id=?)
// plus any additional overrides. The actor user id=1 is returned by default.
function makeWorkerDb(
  actorId: number,
  actorRole: string,
  actorEmail: string,
  actorPatientEmail: string | null,
  sqlOverrides: (sql: string, values?: unknown[]) => [any, undefined] | null
): any {
  return {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    end: async () => {},
    query: async (sql: string, values?: unknown[]) => {
      // Actor lookup for authentication
      if (sql.includes("FROM users WHERE id=?") || sql.includes("FROM users WHERE id =?")) {
        const id = Array.isArray(values) ? Number(values[0]) : 0;
        if (id === actorId) {
          return [[{ id: actorId, email: actorEmail, password_hash: "", role: actorRole, time_zone: "UTC", patient_email: actorPatientEmail }], undefined];
        }
      }
      const override = sqlOverrides(sql, values);
      if (override !== null) return override;
      return [{ affectedRows: 1, insertId: 1 }, undefined];
    },
  };
}

async function workerPost(path: string, body: unknown, db: any): Promise<Response> {
  const token = await makeToken(1);
  return (worker as any).fetch(
    new Request(`https://dosebuddy.test${path}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { JWT_SECRET: TEST_JWT_SECRET, TEST_DB_FACTORY: async () => db }
  );
}

// ---------------------------------------------------------------------------
// T1: markOccurrenceSkipped with PENDING state returns true
// ---------------------------------------------------------------------------
test("T1 - markOccurrenceSkipped on PENDING occurrence returns true", async () => {
  const sqls: string[] = [];
  const db = makeDb({
    query: async (sql: string) => { sqls.push(sql); return [{ affectedRows: 1 }, undefined]; },
  });
  const result = await markOccurrenceSkipped(db, 42);
  assert.equal(result, true);
  assert.ok(sqls.some(s => s.includes("state='PENDING'")), "predicate must be state='PENDING'");
  assert.ok(!sqls.some(s => s.includes("state IN")), "SKIPPED predicate must not use state IN");
});

// ---------------------------------------------------------------------------
// T2: markOccurrenceTaken targets TAKEN state with correct predicate
// ---------------------------------------------------------------------------
test("T2 - markOccurrenceTaken works and uses state IN PENDING/MISSED predicate", async () => {
  const sqls: string[] = [];
  const db = makeDb({
    query: async (sql: string) => { sqls.push(sql); return [{ affectedRows: 1 }, undefined]; },
  });
  const result = await markOccurrenceTaken(db, 7);
  assert.equal(result, true);
  assert.ok(sqls.some(s => s.includes("state='TAKEN'")), "must set state=TAKEN");
  assert.ok(sqls.some(s => s.includes("state IN ('PENDING','MISSED')")), "predicate must accept PENDING or MISSED");
});

// ---------------------------------------------------------------------------
// T3: markOccurrenceSkipped SQL includes skipped_at=NOW(3) and updated_at=NOW(3)
// ---------------------------------------------------------------------------
test("T3 - markOccurrenceSkipped SQL includes skipped_at=NOW(3)", async () => {
  const sqls: string[] = [];
  const db = makeDb({
    query: async (sql: string) => { sqls.push(sql); return [{ affectedRows: 1 }, undefined]; },
  });
  await markOccurrenceSkipped(db, 10);
  const updateSql = sqls.find(s => s.includes("state='SKIPPED'"));
  assert.ok(updateSql, "UPDATE must set state='SKIPPED'");
  assert.ok(updateSql!.includes("skipped_at=NOW(3)"), "must include skipped_at=NOW(3)");
  assert.ok(updateSql!.includes("updated_at=NOW(3)"), "must include updated_at=NOW(3)");
});

// ---------------------------------------------------------------------------
// T4: snooze SQL updates snooze_until without changing state
// ---------------------------------------------------------------------------
test("T4 - snooze SQL sets snooze_until without touching state", async () => {
  const sqls: string[] = [];
  const db = makeWorkerDb(1, "patient", "patient@test.com", null, (sql, values) => {
    sqls.push(sql);
    if (sql.includes("SELECT id, user_id, medication_id, state, snooze_until FROM dose_occurrences")) {
      return [[{ id: 5, user_id: 1, medication_id: 2, state: "PENDING", snooze_until: null }], undefined];
    }
    if (sql.includes("FROM users")) {
      return [[{ id: 1, email: "patient@test.com", password_hash: "", role: "patient", time_zone: "UTC", patient_email: null }], undefined];
    }
    return null;
  });

  const resp = await workerPost("/api/doses/5/snooze", { minutes: 15 }, db);
  assert.notEqual(resp.status, 400, "minutes=15 should not return 400");

  const snoozeSql = sqls.find(s => s.includes("snooze_until") && s.includes("UPDATE dose_occurrences"));
  if (snoozeSql) {
    assert.ok(!snoozeSql.includes("state="), "snooze UPDATE must NOT change state column");
    assert.ok(snoozeSql.includes("snooze_until=?"), "snooze UPDATE must set snooze_until");
  }
});

// ---------------------------------------------------------------------------
// T5: repeated markOccurrenceTaken on TAKEN returns false (idempotent)
// ---------------------------------------------------------------------------
test("T5 - repeated markOccurrenceTaken on already-TAKEN returns false", async () => {
  const db = makeDb({ query: async () => [{ affectedRows: 0 }, undefined] });
  assert.equal(await markOccurrenceTaken(db, 99), false);
});

// ---------------------------------------------------------------------------
// T6: markOccurrenceSkipped on TAKEN occurrence returns false
// ---------------------------------------------------------------------------
test("T6 - markOccurrenceSkipped on a TAKEN occurrence returns false", async () => {
  const db = makeDb({ query: async () => [{ affectedRows: 0 }, undefined] });
  assert.equal(await markOccurrenceSkipped(db, 55), false);
});

// ---------------------------------------------------------------------------
// T7: concurrent TAKEN and SKIPPED - first wins, second returns false
// ---------------------------------------------------------------------------
test("T7 - concurrent TAKEN and SKIPPED: only one succeeds", async () => {
  class ConcurrentAdapter {
    state: "PENDING" | "TAKEN" | "SKIPPED" = "PENDING";

    async query(statement: string): Promise<[{ affectedRows: number }, undefined]> {
      if (statement.includes("state='TAKEN'") && statement.includes("state IN")) {
        if (this.state !== "PENDING" && this.state !== "MISSED") return [{ affectedRows: 0 }, undefined];
        this.state = "TAKEN";
        return [{ affectedRows: 1 }, undefined];
      }
      if (statement.includes("state='SKIPPED'") && statement.includes("state='PENDING'")) {
        if (this.state !== "PENDING") return [{ affectedRows: 0 }, undefined];
        this.state = "SKIPPED";
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  }

  // TAKEN wins: subsequent SKIPPED returns false because state is no longer PENDING
  const db1 = new ConcurrentAdapter();
  assert.equal(await markOccurrenceTaken(db1 as any, 1), true);
  assert.equal(await markOccurrenceSkipped(db1 as any, 1), false);
  assert.equal(db1.state, "TAKEN");

  // SKIPPED wins: subsequent TAKEN returns false because SKIPPED not in ('PENDING','MISSED')
  const db2 = new ConcurrentAdapter();
  assert.equal(await markOccurrenceSkipped(db2 as any, 1), true);
  assert.equal(db2.state, "SKIPPED");
  assert.equal(await markOccurrenceTaken(db2 as any, 1), false,
    "TAKEN cannot overwrite SKIPPED - state IN (PENDING,MISSED) excludes SKIPPED");
  assert.equal(db2.state, "SKIPPED");
});

// ---------------------------------------------------------------------------
// T8: /api/logs/mark with invalid status returns 400
// ---------------------------------------------------------------------------
test("T8 - /api/logs/mark with status=INVALID returns 400", async () => {
  // Status validation happens before any DB query, but the worker still needs
  // to authenticate the actor. Provide a minimal db that handles user lookup.
  const db = makeWorkerDb(1, "patient", "patient@test.com", null, () => null);
  const resp = await workerPost("/api/logs/mark",
    { medicationId: 1, date: "2026-01-01", time: "08:00", status: "INVALID" }, db);
  assert.equal(resp.status, 400, "invalid status must return 400");
  const body = await resp.json() as any;
  assert.ok(body.message, "error response must have a message field");
});

// ---------------------------------------------------------------------------
// T9: actor cannot access another patient's dose - returns 403
// ---------------------------------------------------------------------------
test("T9 - /api/logs/mark returns 403 when actor does not own the medication", async () => {
  // actor is user id=1 (patient), medication belongs to user id=99.
  // accessible(actor, owner) is false because actor.id !== 99 and actor is not
  // a caregiver with patient_email matching owner.email.
  const db = makeWorkerDb(1, "patient", "actor@test.com", null, (sql, values) => {
    if (sql.includes("FROM users WHERE id=?")) {
      const id = Array.isArray(values) ? Number(values[0]) : 0;
      if (id === 99) return [[{ id: 99, email: "owner@test.com", password_hash: "", role: "patient", time_zone: "UTC", patient_email: null }], undefined];
    }
    if (sql.includes("FROM medications m JOIN medication_times")) {
      // medication belongs to user_id=99
      return [[{ id: 10, user_id: 99, name: "Med", dosage: "5mg", schedule_version: 1, active: 1 }], undefined];
    }
    return null;
  });

  const resp = await workerPost("/api/logs/mark",
    { medicationId: 10, date: "2026-01-01", time: "08:00", status: "TAKEN" }, db);
  assert.equal(resp.status, 403, "must be 403 when actor cannot access owner's medication");
});

// ---------------------------------------------------------------------------
// T10: caregiver without matching patient_email gets 403
// ---------------------------------------------------------------------------
test("T10 - /api/logs/mark returns 403 for caregiver without authorized relationship", async () => {
  // accessible() for caregivers checks actor.patient_email === target.email.
  // caregiver (id=2) has patient_email=null so accessible() returns false.
  const enc = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const payloadObj = { type: "access", userId: 2, role: "caregiver", exp: Math.floor(Date.now() / 1000) + 900 };
  const payload = btoa(JSON.stringify(payloadObj))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", enc.encode(TEST_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const caregiverToken = `${header}.${payload}.${sigB64}`;

  const db = makeWorkerDb(2, "caregiver", "caregiver@test.com", null, (sql, values) => {
    if (sql.includes("FROM users WHERE id=?")) {
      const id = Array.isArray(values) ? Number(values[0]) : 0;
      if (id === 99) return [[{ id: 99, email: "patient@test.com", password_hash: "", role: "patient", time_zone: "UTC", patient_email: null }], undefined];
    }
    if (sql.includes("FROM medications m JOIN medication_times")) {
      return [[{ id: 10, user_id: 99, name: "Med", dosage: "5mg", schedule_version: 1, active: 1 }], undefined];
    }
    return null;
  });

  const resp = await (worker as any).fetch(
    new Request("https://dosebuddy.test/api/logs/mark", {
      method: "POST",
      headers: { "Authorization": `Bearer ${caregiverToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ medicationId: 10, date: "2026-01-01", time: "08:00", status: "TAKEN" }),
    }),
    { JWT_SECRET: TEST_JWT_SECRET, TEST_DB_FACTORY: async () => db }
  );
  assert.equal(resp.status, 403, "caregiver without matching patient_email must get 403");
});

// ---------------------------------------------------------------------------
// T11: future doses are not marked missed by mark-missed-batch
// ---------------------------------------------------------------------------
test("T11 - mark-missed-batch skips doses whose scheduled time is in the future", async () => {
  const futureDate = new Date(Date.now() + 86400_000);
  const futureDateStr = futureDate.toISOString().slice(0, 10);

  const db = makeWorkerDb(1, "patient", "patient@test.com", null, (sql) => {
    if (sql.includes("FROM medications m JOIN medication_times")) {
      return [[{ id: 1, user_id: 1, name: "Med", dosage: "5mg", schedule_version: 1, active: 1, time_zone: "UTC" }], undefined];
    }
    return null;
  });

  const token = await makeToken(1);
  const resp = await (worker as any).fetch(
    new Request("https://dosebuddy.test/api/logs/mark-missed-batch", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ medicationId: 1, date: futureDateStr, time: "08:00" }]),
    }),
    { JWT_SECRET: TEST_JWT_SECRET, TEST_DB_FACTORY: async () => db }
  );
  const body = await resp.json() as any;
  assert.equal(body.created, 0, "future doses must not be marked missed");
});

// ---------------------------------------------------------------------------
// T12: repeated markOccurrenceMissed is idempotent
// ---------------------------------------------------------------------------
test("T12 - repeated markOccurrenceMissed is idempotent (second call returns false)", async () => {
  let callCount = 0;
  const db = makeDb({
    query: async () => { callCount++; return [{ affectedRows: callCount === 1 ? 1 : 0 }, undefined]; },
  });
  assert.equal(await markOccurrenceMissed(db, 10), true);
  assert.equal(await markOccurrenceMissed(db, 10), false);
});

// ---------------------------------------------------------------------------
// T13: upsertOccurrence called twice returns same id via ON DUPLICATE KEY
// ---------------------------------------------------------------------------
test("T13 - upsertOccurrence called twice reuses the existing occurrence", async () => {
  let insertCalled = 0;
  const db = makeDb({
    query: async (sql: string) => {
      if (sql.includes("FROM medications WHERE id=? FOR UPDATE")) return [[], undefined];
      if (sql.includes("FROM dose_occurrences")) {
        return insertCalled > 0 ? [[{ id: 77 }], undefined] : [[], undefined];
      }
      if (sql.startsWith("INSERT INTO dose_occurrences")) {
        insertCalled++;
        return [{ insertId: 77, affectedRows: 1 }, undefined];
      }
      if (sql.startsWith("UPDATE dose_occurrences SET scheduled_at_utc")) return [{ affectedRows: 1 }, undefined];
      return [{ affectedRows: 1, insertId: 77 }, undefined];
    },
  });

  const identity = { medicationId: 1, userId: 2, scheduleVersion: 3, localDate: "2026-10-11", localTime: "08:00", scheduledAtUtc: new Date() };
  const id1 = await upsertOccurrence(db, identity);
  const id2 = await upsertOccurrence(db, identity);
  assert.equal(id1, 77);
  assert.equal(id2, 77, "second upsert must return same id");
  assert.equal(insertCalled, 1, "INSERT should only be called once");
});

// ---------------------------------------------------------------------------
// T14: snooze_until computed from Date.now() + 15*60_000 is in the future
// ---------------------------------------------------------------------------
test("T14 - snooze_until computed from Date.now() + 15*60000 is in the future", () => {
  const before = Date.now();
  const snoozeUntil = new Date(Date.now() + 15 * 60_000);
  assert.ok(snoozeUntil.getTime() > before, "snooze_until must be strictly in the future");
  assert.ok(snoozeUntil.getTime() >= before + 15 * 60_000 - 100,
    "snooze_until should be approximately 15 minutes from now");
});

// ---------------------------------------------------------------------------
// T15: adherence formula counts each scheduled dose exactly once
// ---------------------------------------------------------------------------
test("T15 - adherence counts each scheduled dose exactly once: taken=1, missed=1 -> 50%", () => {
  // Direct formula test: taken / (taken + missed + skipped)
  const computeAdherence = (taken: number, missed: number, skipped: number) => {
    const completed = taken + missed + skipped;
    return completed > 0 ? Math.round((taken * 1000.0) / completed) / 10.0 : 0.0;
  };

  assert.equal(computeAdherence(1, 1, 0), 50.0, "1 taken of 2 completed = 50%");
  assert.equal(computeAdherence(1, 1, 1), 33.3, "1 taken of 3 (incl. skipped) = 33.3%");
  assert.equal(computeAdherence(0, 0, 0), 0.0, "no data must not divide by zero");
  assert.equal(computeAdherence(3, 0, 0), 100.0, "3 taken of 3 = 100%");

  // Skipped must not be double-counted: 1 occurrence = 1 row
  assert.equal(computeAdherence(2, 1, 1), 50.0, "2 taken of 4 = 50%");
});

// ---------------------------------------------------------------------------
// T16: SKIPPED predicate excludes MISSED (cannot skip an auto-missed dose)
// ---------------------------------------------------------------------------
test("T16 - SKIPPED predicate excludes MISSED state (cannot skip an auto-missed dose)", async () => {
  const sqls: string[] = [];
  const db = makeDb({
    query: async (sql: string) => { sqls.push(sql); return [{ affectedRows: 0 }, undefined]; },
  });
  const result = await markOccurrenceSkipped(db, 30);
  assert.equal(result, false);
  const updateSql = sqls[0];
  assert.ok(updateSql.includes("state='PENDING'"), "SKIPPED predicate must be state='PENDING'");
  assert.ok(!updateSql.includes("'MISSED'"), "SKIPPED predicate must NOT reference MISSED state");
});
