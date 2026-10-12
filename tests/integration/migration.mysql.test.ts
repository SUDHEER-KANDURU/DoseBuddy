import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import bcrypt from "bcryptjs";
import worker from "../../cloudflare-worker/index.ts";
import { markOccurrenceMissed, markOccurrenceTaken } from "../../cloudflare-worker/dose-occurrences.ts";

const url = process.env.DOSEBUDDY_TEST_MYSQL_URL;

test("notification migration converges twice from the legacy ledger", { skip: !url }, async () => {
  const db = await createConnection({ uri: url!, multipleStatements: true });
  const migration = await readFile(new URL("../../database-migrations.sql", import.meta.url), "utf8");
  try {
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,activities,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.query(`
      CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50), email VARCHAR(255) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role VARCHAR(32) NOT NULL, time_zone VARCHAR(64) NULL, accepted_terms TINYINT NOT NULL DEFAULT 1);
      CREATE TABLE medications (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, name VARCHAR(255) NOT NULL, dosage VARCHAR(255) NOT NULL, instructions TEXT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL);
      CREATE TABLE medication_times (id INT PRIMARY KEY AUTO_INCREMENT, medication_id INT NOT NULL, time_of_day TIME NOT NULL);
      CREATE TABLE activities (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, type VARCHAR(64) NOT NULL, message TEXT NOT NULL, related_entity_type VARCHAR(64) NOT NULL, related_entity_id INT NOT NULL, created_at DATETIME NOT NULL);
      CREATE TABLE dose_occurrences (
        id BIGINT PRIMARY KEY AUTO_INCREMENT, medication_id INT NOT NULL, user_id INT NOT NULL, schedule_version BIGINT NOT NULL,
        local_date DATE NOT NULL, local_time TIME NOT NULL, scheduled_at_utc DATETIME(3) NOT NULL, state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      );
      CREATE TABLE intake_logs (id BIGINT PRIMARY KEY AUTO_INCREMENT, marker_user_id INT, medication_id INT, date DATE, time TIME);
      CREATE TABLE push_subscriptions (id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, endpoint TEXT NOT NULL, subscription_data TEXT NOT NULL, active BOOLEAN, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
      CREATE TABLE push_delivery_attempts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,event_id VARCHAR(191) NOT NULL,user_id INT NOT NULL,subscription_id INT NOT NULL,
        event_created_at DATETIME(3) NULL,scheduled_at DATETIME(3) NULL,attempted_at DATETIME(3) NOT NULL,
        provider_status SMALLINT NULL,outcome VARCHAR(32) NOT NULL,processing_lag_ms INT NOT NULL,
        delivery_latency_ms INT NOT NULL,retry_count INT NOT NULL DEFAULT 0,error_category VARCHAR(100) NULL
      );
      INSERT INTO users (id,name,email,password_hash,role,time_zone) VALUES (1,'fixture','fixture@example.test','${await bcrypt.hash("legacy-fixture-password", 10)}','PATIENT','UTC');
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
      TEST_DB_FACTORY: () => createConnection(url!)
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
    const [legacyMeds]: any = await db.query("SELECT user_id,name,dosage,instructions,start_date,end_date FROM medications WHERE id > 1 ORDER BY id");
    assert.deepEqual(legacyMeds, [
      { user_id: 1, name: "test", dosage: "1231", instructions: "", start_date: "2026-10-12", end_date: "2026-10-12" },
      { user_id: 1, name: "Example (generic)", dosage: "10mg", instructions: "with food", start_date: "2026-10-12", end_date: "2026-11-11" }
    ]);
    const [legacyTimes]: any = await db.query("SELECT mt.time_of_day FROM medication_times mt JOIN medications m ON m.id=mt.medication_id WHERE m.id > 1 ORDER BY mt.medication_id,mt.id");
    assert.deepEqual(legacyTimes.map((row: any) => String(row.time_of_day).slice(0, 5)), ["19:07", "08:00", "13:00", "18:00"]);

    await db.query(migration);
    await db.query(migration);

    const [columns]: any = await db.query("SELECT COLUMN_NAME AS column_name,IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='push_delivery_attempts' AND column_name IN ('schedule_version','event_type')");
    assert.deepEqual(new Map(columns.map((row: any) => [row.column_name, row.is_nullable])), new Map([["event_type", "NO"], ["schedule_version", "NO"]]));
    const [occurrenceColumns]: any = await db.query("SELECT COLUMN_NAME AS column_name,IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dose_occurrences' AND column_name IN ('taken_at','missed_at')");
    assert.deepEqual(new Map(occurrenceColumns.map((row: any) => [row.column_name, row.is_nullable])), new Map([["missed_at", "YES"], ["taken_at", "YES"]]));
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
    const [constraints]: any = await db.query("SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='push_delivery_attempts'");
    const names = new Set(constraints.map((row: any) => row.constraint_name));
    for (const name of ["uq_delivery_event_subscription", "fk_delivery_occurrence", "fk_delivery_medication", "fk_delivery_user", "fk_delivery_subscription"]) assert.ok(names.has(name), name);
    const [events]: any = await db.query("SELECT event_id FROM push_delivery_attempts ORDER BY id");
    assert.equal(new Set(events.map((row: any) => row.event_id)).size, 2);
  } finally {
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,activities,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.end();
  }
});
