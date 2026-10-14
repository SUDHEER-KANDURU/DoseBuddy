import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import bcrypt from "bcryptjs";
import worker from "../../cloudflare-worker/index.ts";
import { markOccurrenceMissed, markOccurrenceTaken } from "../../cloudflare-worker/dose-occurrences.ts";
import { canonicalTimeZone } from "../../cloudflare-worker/scheduling.ts";
import { resolveLocalOccurrence, zonedParts } from "../../cloudflare-worker/scheduling.ts";
import { disposableMysqlConfig, disposableMysqlUrl } from "./safe-db.ts";
import { webPushFixture } from "../web-push-fixture.ts";

const url = disposableMysqlUrl();
const mysqlConfig = disposableMysqlConfig();

test("notification migration converges twice from the legacy ledger", { skip: !url }, async () => {
  const db = await createConnection({ ...mysqlConfig!, multipleStatements: true });
  const migration = await readFile(new URL("../../database-migrations.sql", import.meta.url), "utf8");
  try {
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,activities,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.query(`
      CREATE TABLE users (id BIGINT PRIMARY KEY, name VARCHAR(50), email VARCHAR(255) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role VARCHAR(32) NOT NULL, accepted_terms TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
      CREATE TABLE medications (id BIGINT PRIMARY KEY AUTO_INCREMENT, user_id BIGINT NOT NULL, name VARCHAR(255) NOT NULL, dosage VARCHAR(255) NOT NULL, instructions TEXT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL);
      CREATE TABLE medication_times (id BIGINT PRIMARY KEY AUTO_INCREMENT, medication_id BIGINT NOT NULL, time_of_day TIME NOT NULL);
      CREATE TABLE activities (id BIGINT PRIMARY KEY AUTO_INCREMENT, user_id BIGINT NOT NULL, type VARCHAR(64) NOT NULL, message TEXT NOT NULL, related_entity_type VARCHAR(64) NOT NULL, related_entity_id BIGINT NOT NULL, created_at DATETIME NOT NULL);
      CREATE TABLE dose_occurrences (
        id BIGINT PRIMARY KEY AUTO_INCREMENT, medication_id INT NOT NULL, user_id INT NOT NULL, schedule_version BIGINT NOT NULL,
        local_date DATE NOT NULL, local_time TIME NOT NULL, scheduled_at_utc DATETIME(3) NOT NULL, state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      );
      CREATE TABLE intake_logs (id BIGINT PRIMARY KEY AUTO_INCREMENT, marker_user_id BIGINT, medication_id BIGINT, date DATE, time TIME, status VARCHAR(16), scheduled_time DATETIME, taken_time DATETIME, missed_time DATETIME, email_reminder_sent BOOLEAN DEFAULT FALSE, created_at DATETIME, updated_at DATETIME);
      CREATE TABLE push_subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, endpoint TEXT NOT NULL, subscription_data TEXT NOT NULL, active BOOLEAN, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
      CREATE TABLE push_delivery_attempts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,event_id VARCHAR(191) NOT NULL,user_id INT NOT NULL,subscription_id INT NOT NULL,medication_id INT NULL,
        event_created_at DATETIME(3) NULL,scheduled_at DATETIME(3) NULL,attempted_at DATETIME(3) NOT NULL,
        provider_status SMALLINT NULL,outcome VARCHAR(32) NOT NULL,processing_lag_ms INT NOT NULL,
        delivery_latency_ms INT NOT NULL,retry_count INT NOT NULL DEFAULT 0,error_category VARCHAR(100) NULL
      );
      INSERT INTO users (id,name,email,password_hash,role) VALUES (1,'fixture','fixture@example.test','${await bcrypt.hash("legacy-fixture-password", 10)}','PATIENT');
      INSERT INTO medications (id,user_id,name,dosage,instructions,start_date,end_date) VALUES (1,1,'Existing','1mg',NULL,'2026-01-01','2026-12-31');
      INSERT INTO medication_times VALUES (1,1,'08:00:00');
      INSERT INTO push_subscriptions (id,user_id,endpoint,subscription_data,active) VALUES (1,1,'https://push.example/1','{}',1);
      INSERT INTO push_delivery_attempts (event_id,user_id,subscription_id,attempted_at,outcome,processing_lag_ms,delivery_latency_ms)
      VALUES ('duplicate',1,1,NOW(3),'old-success',0,0),('duplicate',1,1,NOW(3),'old-success',0,0);
    `);

    let legacyInsertError: any;
    try {
      await db.query(
        "INSERT INTO medications (user_id,name,dosage,instructions,start_date,end_date,active,schedule_version) VALUES (?,?,?,?,?,?,1,1)",
        [1, "signature probe", "1mg", null, "2026-10-12", "2026-10-12"]
      );
      assert.fail("legacy schema unexpectedly accepted notification columns");
    } catch (error) {
      legacyInsertError = error;
    }
    assert.equal(legacyInsertError?.code, "ER_BAD_FIELD_ERROR");
    assert.match(String(legacyInsertError?.message), /active/);

    const workerEnv = {
      JWT_SECRET: "legacy-fixture-secret",
      TEST_DB_FACTORY: () => createConnection(mysqlConfig!)
    };
    const login = await worker.fetch(new Request("https://dosebuddy.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fixture@example.test", password: "legacy-fixture-password" })
    }), workerEnv as any);
    assert.equal(login.status, 200);
    const { accessToken } = await login.json() as any;
    const save = (body: unknown) => worker.fetch(new Request("https://dosebuddy.test/api/medications/add", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    }), workerEnv as any);

    assert.equal((await save({
      userId: 999, name: "test", dosage: "1231", instructions: "", startDate: "2026-10-12", endDate: "2026-10-12", times: ["19:07"]
    })).status, 200);
    assert.equal((await save({
      userId: 999, name: "Example (generic)", dosage: "10mg", instructions: "with food", startDate: "2026-10-12", endDate: "2026-11-11", times: ["08:00", "13:00", "18:00"]
    })).status, 200);
    const [legacyMeds]: any = await db.query("SELECT user_id,name,dosage,instructions,DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date,DATE_FORMAT(end_date,'%Y-%m-%d') AS end_date FROM medications WHERE id > 1 ORDER BY id");
    assert.deepEqual(legacyMeds, [
      { user_id: 1, name: "test", dosage: "1231", instructions: "", start_date: "2026-10-12", end_date: "2026-10-12" },
      { user_id: 1, name: "Example (generic)", dosage: "10mg", instructions: "with food", start_date: "2026-10-12", end_date: "2026-11-11" }
    ]);
    const [legacyTimes]: any = await db.query("SELECT mt.time_of_day FROM medication_times mt JOIN medications m ON m.id=mt.medication_id WHERE m.id > 1 ORDER BY mt.medication_id,mt.id");
    assert.deepEqual(legacyTimes.map((row: any) => String(row.time_of_day).slice(0, 5)), ["19:07", "08:00", "13:00", "18:00"]);

    await db.query(migration);
    await db.query(migration);

    // Reproduce the production 409 condition: the legacy users table had no
    // time_zone column. The migration must add it and the authenticated Worker
    // route must persist the selected IANA zone rather than masking the error.
    const [timeZoneColumns]: any = await db.query("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='time_zone'");
    assert.equal(timeZoneColumns.length, 1);
    const timeZoneResponse = await worker.fetch(new Request("https://dosebuddy.test/api/user/time-zone", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ timeZone: "Asia/Kolkata" })
    }), workerEnv as any);
    const expectedTimeZone = canonicalTimeZone("Asia/Kolkata");
    assert.equal(timeZoneResponse.status, 200);
    assert.equal((await timeZoneResponse.json() as any).timeZone, expectedTimeZone);
    const repeatedTimeZoneResponse = await worker.fetch(new Request("https://dosebuddy.test/api/user/time-zone", {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ timeZone: "Asia/Kolkata" })
    }), workerEnv as any);
    assert.equal(repeatedTimeZoneResponse.status, 200);
    assert.equal((await repeatedTimeZoneResponse.json() as any).timeZone, expectedTimeZone);
    const readTimeZoneResponse = await worker.fetch(new Request("https://dosebuddy.test/api/user/time-zone", {
      headers: { authorization: `Bearer ${accessToken}` }
    }), workerEnv as any);
    assert.equal(readTimeZoneResponse.status, 200);
    assert.equal((await readTimeZoneResponse.json() as any).timeZone, expectedTimeZone);
    const [savedZones]: any = await db.query("SELECT time_zone FROM users WHERE id=1");
    assert.equal(savedZones[0].time_zone, expectedTimeZone);

    const [columns]: any = await db.query("SELECT COLUMN_NAME AS column_name,IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name IN ('schedule_version','event_type')");
    assert.deepEqual(new Map(columns.map((row: any) => [row.column_name, row.is_nullable])), new Map([["event_type", "NO"], ["schedule_version", "NO"]]));
    const [foreignKeyTypes]: any = await db.query(`
      SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type
      FROM information_schema.columns
      WHERE table_schema=DATABASE() AND (
        (TABLE_NAME='push_subscriptions' AND COLUMN_NAME='user_id') OR
        (TABLE_NAME='dose_occurrences' AND COLUMN_NAME IN ('medication_id','user_id')) OR
        (TABLE_NAME='push_delivery_attempts' AND COLUMN_NAME IN ('medication_id','user_id'))
      )
    `);
    for (const row of foreignKeyTypes) assert.equal(row.column_type, "bigint", `${row.table_name}.${row.column_name} must match the existing BIGINT ids`);
    const [occurrenceColumns]: any = await db.query("SELECT COLUMN_NAME AS column_name,IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name IN ('taken_at','missed_at')");
    assert.deepEqual(new Map(occurrenceColumns.map((row: any) => [row.column_name, row.is_nullable])), new Map([["missed_at", "YES"], ["taken_at", "YES"]]));
    const [intakeOccurrenceColumns]: any = await db.query("SELECT COLUMN_NAME AS column_name,IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='intake_logs' AND column_name='occurrence_id'");
    assert.deepEqual(intakeOccurrenceColumns, [{ column_name: "occurrence_id", is_nullable: "YES" }]);
    const [inserted]: any = await db.query("INSERT INTO dose_occurrences (medication_id,user_id,schedule_version,local_date,local_time,scheduled_at_utc,state) VALUES (1,1,1,'2026-06-01','08:00:00','2026-06-01 08:00:00.000','PENDING')");
    assert.equal(await markOccurrenceMissed(db as any, inserted.insertId), true);
    const [missed]: any = await db.query("SELECT state,taken_at,missed_at FROM dose_occurrences WHERE id=?", [inserted.insertId]);
    assert.equal(missed[0].state, "MISSED");
    assert.equal(missed[0].taken_at, null);
    assert.notEqual(missed[0].missed_at, null);
    assert.equal(await markOccurrenceTaken(db as any, inserted.insertId), true);
    const [taken]: any = await db.query("SELECT state,taken_at,missed_at FROM dose_occurrences WHERE id=?", [inserted.insertId]);
    assert.equal(taken[0].state, "TAKEN");
    assert.notEqual(taken[0].taken_at, null);
    assert.equal(taken[0].missed_at, null);
    const [constraints]: any = await db.query("SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS constraint_name FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND TABLE_NAME IN ('push_subscriptions','dose_occurrences','push_delivery_attempts','intake_logs')");
    const names = new Set(constraints.map((row: any) => `${row.table_name}.${row.constraint_name}`));
    for (const key of [
      "push_delivery_attempts.uq_delivery_event_subscription",
      "push_delivery_attempts.fk_delivery_occurrence",
      "push_delivery_attempts.fk_delivery_medication",
      "push_delivery_attempts.fk_delivery_user",
      "push_delivery_attempts.fk_delivery_subscription",
      "push_subscriptions.fk_push_subscriptions_user",
      "dose_occurrences.fk_occurrence_medication",
      "dose_occurrences.fk_occurrence_user",
      "intake_logs.fk_intake_logs_occurrence"
    ]) assert.ok(names.has(key), key);
    const [intakeIndexes]: any = await db.query("SELECT NON_UNIQUE AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='intake_logs' AND index_name='uq_intake_logs_occurrence'");
    assert.ok(intakeIndexes.length > 0 && intakeIndexes.every((row: any) => Number(row.non_unique) === 0), "intake occurrence link must be unique for idempotent history writes");
    // Exercise the production scheduler and real Web Push crypto against MySQL.
    // The provider is intercepted locally, so this proves transition/ledger and
    // provider-response handling, not receipt by a browser or push service.
    const push = await webPushFixture();
    await db.query("UPDATE push_subscriptions SET endpoint=?,subscription_data=?,active=1 WHERE id=1", [push.subscription.endpoint, JSON.stringify(push.subscription)]);
    const schedulerNow = new Date();
    const localSlot = zonedParts(new Date(schedulerNow.getTime() - 3 * 60_000), expectedTimeZone!);
    const scheduledAt = resolveLocalOccurrence(localSlot.date, localSlot.time, expectedTimeZone!);
    await db.query("INSERT INTO medication_times (medication_id,time_of_day) VALUES (1,?)", [`${localSlot.time}:00`]);
    const [scheduledOccurrence]: any = await db.query(
      "INSERT INTO dose_occurrences (medication_id,user_id,schedule_version,local_date,local_time,scheduled_at_utc,state) VALUES (1,1,1,?,?,?,'PENDING')",
      [localSlot.date, `${localSlot.time}:00`, scheduledAt.toISOString().slice(0, 23).replace("T", " ")]
    );
    const schedulerEnv = { ...workerEnv, ...push.env } as any;
    const originalFetch = globalThis.fetch;
    const providerResponses = [503, 201];
    let providerCalls = 0;
    globalThis.fetch = async () => {
      const checkDb = await createConnection(mysqlConfig!);
      try {
        const [committed]: any = await checkDb.query("SELECT state FROM dose_occurrences WHERE id=?", [scheduledOccurrence.insertId]);
        assert.equal(committed[0]?.state, "MISSED", "provider dispatch must occur after the MISSED commit");
      } finally { await checkDb.end(); }
      const status = providerResponses[Math.min(providerCalls, providerResponses.length - 1)];
      providerCalls++;
      return new Response(null, { status });
    };
    try {
      await worker.processMissedDoses(schedulerEnv, schedulerNow);
      const [firstAttempt]: any = await db.query("SELECT outcome,provider_status,retry_count FROM push_delivery_attempts WHERE occurrence_id=? AND event_type='MISSED'", [scheduledOccurrence.insertId]);
      assert.deepEqual(firstAttempt, [{ outcome: "RETRY", provider_status: 503, retry_count: 1 }]);
      await db.query("UPDATE push_delivery_attempts SET next_attempt_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE occurrence_id=? AND event_type='MISSED'", [scheduledOccurrence.insertId]);
      await worker.processMissedDoses(schedulerEnv, new Date(schedulerNow.getTime() + 60_000));
      await worker.processMissedDoses(schedulerEnv, new Date(schedulerNow.getTime() + 120_000));
      const [finalAttempts]: any = await db.query("SELECT outcome,provider_status,retry_count FROM push_delivery_attempts WHERE occurrence_id=? AND event_type='MISSED'", [scheduledOccurrence.insertId]);
      assert.deepEqual(finalAttempts, [{ outcome: "SENT", provider_status: 201, retry_count: 1 }]);
      assert.equal(providerCalls, 2, "retry must reuse the logical ledger entry and duplicate scheduler runs must not dispatch again");
    } finally { globalThis.fetch = originalFetch; }

    const [events]: any = await db.query("SELECT event_id FROM push_delivery_attempts WHERE event_id LIKE 'duplicate%' ORDER BY id");
    assert.equal(new Set(events.map((row: any) => row.event_id)).size, 2);
  } finally {
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,activities,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.end();
  }
});
