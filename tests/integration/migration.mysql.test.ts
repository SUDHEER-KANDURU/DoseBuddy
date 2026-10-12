import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { markOccurrenceMissed, markOccurrenceTaken } from "../../cloudflare-worker/dose-occurrences.ts";

const url = process.env.DOSEBUDDY_TEST_MYSQL_URL;

test("notification migration converges twice from the legacy ledger", { skip: !url }, async () => {
  const db = await createConnection({ uri: url!, multipleStatements: true });
  const migration = await readFile(new URL("../../database-migrations.sql", import.meta.url), "utf8");
  try {
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.query(`
      CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));
      CREATE TABLE medications (id INT PRIMARY KEY, user_id INT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL);
      CREATE TABLE medication_times (id INT PRIMARY KEY, medication_id INT NOT NULL, time_of_day TIME NOT NULL);
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
      INSERT INTO users VALUES (1,'fixture');
      INSERT INTO medications VALUES (1,1,'2026-01-01','2026-12-31');
      INSERT INTO medication_times VALUES (1,1,'08:00:00');
      INSERT INTO push_subscriptions (id,user_id,endpoint,subscription_data,active) VALUES (1,1,'https://push.example/1','{}',1);
      INSERT INTO push_delivery_attempts (event_id,user_id,subscription_id,attempted_at,outcome,processing_lag_ms,delivery_latency_ms)
      VALUES ('duplicate',1,1,NOW(3),'old-success',0,0),('duplicate',1,1,NOW(3),'old-success',0,0);
    `);

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
    await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
    await db.end();
  }
});
