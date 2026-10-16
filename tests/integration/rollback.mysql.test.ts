import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { disposableMysqlConfig, disposableMysqlUrl } from "./safe-db.ts";

const url = disposableMysqlUrl();
const config = disposableMysqlConfig();
const migrationPath = new URL("../../database-migrations.sql", import.meta.url);
const rollbackPath = new URL("../../.agents/tasks/db-migration-aiven/10-rollback-tier1-corrected.sql", import.meta.url);

async function fingerprint(db: any) {
  const [tables]: any = await db.query("SELECT table_name,table_rows,auto_increment FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name");
  const [indexes]: any = await db.query("SELECT table_name,index_name,non_unique,seq_in_index,column_name FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index");
  const [fks]: any = await db.query("SELECT table_name,constraint_name,column_name,referenced_table_name,referenced_column_name FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL ORDER BY table_name,constraint_name,ordinal_position");
  const [counts]: any = await db.query("SELECT 'users' t,COUNT(*) n,SUM(CRC32(JSON_ARRAY(id,email,name))) h FROM users UNION ALL SELECT 'medications',COUNT(*),SUM(CRC32(JSON_ARRAY(id,user_id,name,dosage))) FROM medications UNION ALL SELECT 'medication_times',COUNT(*),SUM(CRC32(JSON_ARRAY(id,medication_id,time_of_day))) FROM medication_times UNION ALL SELECT 'intake_logs',COUNT(*),SUM(CRC32(JSON_ARRAY(id,marker_user_id,medication_id,date,time))) FROM intake_logs");
  return JSON.stringify({ tables, indexes, fks, counts });
}

async function fixture(db: any, explicitIndexes: boolean) {
  await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
  const key = explicitIndexes ? ", KEY FKsae8ns7nscnqntu61xu8xxwl3(user_id)" : "";
  const mtKey = explicitIndexes ? ", KEY FK8sec1hxe2jf4ie0qcs6vpgrjt(medication_id)" : "";
  const iuKey = explicitIndexes ? ", KEY FKgyt5k1iyy35ivvm9850382hbb(marker_user_id), KEY FKqpa3kmkalq9trlq8jxrmj9rwq(medication_id)" : "";
  await db.query(`CREATE TABLE users(id BIGINT PRIMARY KEY,name VARCHAR(50),email VARCHAR(255) UNIQUE,password_hash VARCHAR(255),role VARCHAR(20),accepted_terms TINYINT DEFAULT 1);
    CREATE TABLE medications(id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id BIGINT NOT NULL,name VARCHAR(255),dosage VARCHAR(50),instructions TEXT,start_date DATE,end_date DATE${key}, CONSTRAINT FKsae8ns7nscnqntu61xu8xxwl3 FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE medication_times(id BIGINT AUTO_INCREMENT PRIMARY KEY,medication_id BIGINT NOT NULL,time_of_day TIME${mtKey}, CONSTRAINT FK8sec1hxe2jf4ie0qcs6vpgrjt FOREIGN KEY(medication_id) REFERENCES medications(id));
    CREATE TABLE intake_logs(id BIGINT AUTO_INCREMENT PRIMARY KEY,marker_user_id BIGINT,medication_id BIGINT,date DATE,time TIME,status VARCHAR(16),scheduled_time DATETIME,taken_time DATETIME,missed_time DATETIME,email_reminder_sent TINYINT,created_at DATETIME,updated_at DATETIME${iuKey}, CONSTRAINT FKgyt5k1iyy35ivvm9850382hbb FOREIGN KEY(marker_user_id) REFERENCES users(id), CONSTRAINT FKqpa3kmkalq9trlq8jxrmj9rwq FOREIGN KEY(medication_id) REFERENCES medications(id));
    INSERT INTO users VALUES(1,'fixture','fixture@example.test','hash','PATIENT',1);
    INSERT INTO medications(user_id,name,dosage,start_date,end_date) VALUES(1,'Fixture','1mg','2026-01-01','2026-12-31');
    INSERT INTO medication_times(medication_id,time_of_day) VALUES(1,'08:00:00');
    INSERT INTO intake_logs(marker_user_id,medication_id,date,time,status) VALUES(1,1,'2026-01-01','08:00:00','TAKEN')`);
}

for (const explicitIndexes of [false, true]) test(`rollback cycle preserves legacy schema (${explicitIndexes ? "explicit" : "implicit"} FK indexes)`, { skip: !url }, async () => {
  const db = await createConnection({ ...config!, multipleStatements: true });
  const migration = await readFile(migrationPath, "utf8");
  const rollback = await readFile(rollbackPath, "utf8");
  try {
    const [prior]: any = await db.query("SHOW TABLES"); assert.equal(prior.length, 0, "disposable test schema must start empty");
    await fixture(db, explicitIndexes); const before = await fingerprint(db);
    await db.query(migration); await db.query(rollback); assert.equal(await fingerprint(db), before, "migrate then rollback must restore legacy state");
    await db.query(rollback); assert.equal(await fingerprint(db), before, "repeated rollback must converge");
    await db.query(migration); await db.query(rollback); assert.equal(await fingerprint(db), before, "migrate rollback migrate rollback must restore legacy state");
    const [unsupported]: any = await db.query("SELECT f.table_name,f.constraint_name FROM information_schema.key_column_usage f WHERE f.table_schema=DATABASE() AND f.referenced_table_name IS NOT NULL AND NOT EXISTS(SELECT 1 FROM information_schema.statistics s WHERE s.table_schema=f.table_schema AND s.table_name=f.table_name AND s.column_name=f.column_name AND s.seq_in_index=1)");
    assert.deepEqual(unsupported, [], "every legacy foreign key must retain a supporting index");
  } finally { await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1"); await db.end(); }
});

function rollbackStatements(sql: string) {
  return sql.split(/;\s*(?:\r?\n|$)/).map(part => part.trim()).filter(Boolean);
}

for (const explicitIndexes of [false, true]) test(`every rollback statement recovers after interruption (${explicitIndexes ? "explicit" : "implicit"} FK indexes)`, { skip: !url }, async () => {
  const migration = await readFile(migrationPath, "utf8");
  const rollback = await readFile(rollbackPath, "utf8");
  const statements = rollbackStatements(rollback);
  assert.ok(statements.length >= 20, `rollback statement sequence unexpectedly shortened: ${statements.length}`);
  let executed = 0;
  for (let interruption = 0; interruption < statements.length; interruption++) {
    const db = await createConnection({ ...config!, multipleStatements: true });
    try {
      const [prior]: any = await db.query("SHOW TABLES");
      assert.equal(prior.length, 0, `case ${interruption}: disposable schema must start empty`);
      await fixture(db, explicitIndexes);
      const legacy = await fingerprint(db);
      await db.query(migration);
      for (let index = 0; index <= interruption; index++) await db.query(statements[index]);
      const partial = await fingerprint(db);
      assert.ok(partial.length > 0, `case ${interruption}: partial state inspection must run`);
      await db.query(rollback);
      assert.equal(await fingerprint(db), legacy, `case ${interruption}: retry must restore legacy state after ${statements[interruption].slice(0, 60)}`);
      const [unsupported]: any = await db.query("SELECT f.constraint_name FROM information_schema.key_column_usage f WHERE f.table_schema=DATABASE() AND f.referenced_table_name IS NOT NULL AND NOT EXISTS(SELECT 1 FROM information_schema.statistics s WHERE s.table_schema=f.table_schema AND s.table_name=f.table_name AND s.column_name=f.column_name AND s.seq_in_index=1)");
      assert.deepEqual(unsupported, [], `case ${interruption}: recovery left an unsupported foreign key`);
      executed++;
    } finally {
      await db.query("SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS push_delivery_attempts,dose_occurrences,push_subscriptions,intake_logs,medication_times,medications,users; SET FOREIGN_KEY_CHECKS=1");
      await db.end();
    }
  }
  assert.equal(executed, statements.length, "every statement interruption must execute");
});
