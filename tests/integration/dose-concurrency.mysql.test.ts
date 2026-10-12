import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "mysql2/promise";

// Deliberately no DB_URL/Hyperdrive fallback: this release gate can only use a
// disposable, explicitly configured MySQL 8 database.
const url = process.env.DOSEBUDDY_TEST_MYSQL_URL;

const tick = () => new Promise(resolve => setTimeout(resolve, 50));

test("two-connection TAKEN versus MISSED race", { skip: !url }, async () => {
  const setup = await createConnection(url!);
  const taken = await createConnection(url!);
  const cron = await createConnection(url!);
  try {
    await setup.query("DROP TABLE IF EXISTS dose_occurrence_race_test");
    await setup.query("CREATE TABLE dose_occurrence_race_test (id BIGINT PRIMARY KEY, state ENUM('PENDING','TAKEN','MISSED') NOT NULL) ENGINE=InnoDB");
    await setup.query("INSERT INTO dose_occurrence_race_test (id,state) VALUES (1,'PENDING')");

    await taken.beginTransaction();
    const [takenResult]: any = await taken.query("UPDATE dose_occurrence_race_test SET state='TAKEN' WHERE id=1 AND state IN ('PENDING','MISSED')");
    const missedBlocked = cron.query("UPDATE dose_occurrence_race_test SET state='MISSED' WHERE id=1 AND state='PENDING'");
    await taken.commit();
    const [missedResult]: any = await missedBlocked;
    assert.equal(takenResult.affectedRows, 1);
    assert.equal(missedResult.affectedRows, 0);
    assert.equal((await setup.query<any[]>("SELECT state FROM dose_occurrence_race_test WHERE id=1"))[0][0].state, "TAKEN");

    await setup.query("UPDATE dose_occurrence_race_test SET state='PENDING' WHERE id=1");
    await cron.beginTransaction();
    const [cronResult]: any = await cron.query("UPDATE dose_occurrence_race_test SET state='MISSED' WHERE id=1 AND state='PENDING'");
    await cron.commit();
    const [correctResult]: any = await taken.query("UPDATE dose_occurrence_race_test SET state='TAKEN' WHERE id=1 AND state IN ('PENDING','MISSED')");
    assert.equal(cronResult.affectedRows, 1);
    assert.equal(correctResult.affectedRows, 1);
    assert.equal((await setup.query<any[]>("SELECT state FROM dose_occurrence_race_test WHERE id=1"))[0][0].state, "TAKEN");
  } finally {
    await setup.query("DROP TABLE IF EXISTS dose_occurrence_race_test");
    await Promise.all([setup.end(), taken.end(), cron.end()]);
  }
});

test("medication mutation serializes before the final dispatch boundary", { skip: !url }, async () => {
  const setup = await createConnection(url!);
  const mutation = await createConnection(url!);
  const sender = await createConnection(url!);
  try {
    await setup.query("DROP TABLE IF EXISTS delivery_lock_test,medication_lock_test");
    await setup.query("CREATE TABLE medication_lock_test (id BIGINT PRIMARY KEY, schedule_version BIGINT NOT NULL) ENGINE=InnoDB");
    await setup.query("CREATE TABLE delivery_lock_test (id BIGINT PRIMARY KEY, medication_id BIGINT NOT NULL, schedule_version BIGINT NOT NULL, outcome VARCHAR(16) NOT NULL, INDEX (medication_id), FOREIGN KEY (medication_id) REFERENCES medication_lock_test(id)) ENGINE=InnoDB");
    await setup.query("INSERT INTO medication_lock_test VALUES (1,4)");
    await setup.query("INSERT INTO delivery_lock_test VALUES (1,1,4,'CLAIMED')");

    // A medication edit that commits before final revalidation makes the claim
    // ineligible, so the provider must not be reached.
    await mutation.beginTransaction();
    await mutation.query("SELECT id FROM medication_lock_test WHERE id=1 FOR UPDATE");
    await mutation.query("UPDATE medication_lock_test SET schedule_version=schedule_version+1 WHERE id=1");
    await mutation.query("UPDATE delivery_lock_test SET outcome='OBSOLETE' WHERE medication_id=1 AND outcome='CLAIMED'");
    await sender.beginTransaction();
    const finalBoundary = sender.query<any[]>(`SELECT d.id FROM delivery_lock_test d
      JOIN medication_lock_test m ON m.id=d.medication_id
      WHERE d.id=1 AND d.outcome='CLAIMED' AND d.schedule_version=m.schedule_version FOR UPDATE`);
    await mutation.commit();
    const [eligible] = await finalBoundary;
    assert.equal(eligible.length, 0);
    assert.equal((await setup.query<any[]>("SELECT outcome FROM delivery_lock_test WHERE id=1"))[0][0].outcome, "OBSOLETE");
    await sender.commit();

    // After the durable start boundary, final revalidation retains the medication
    // lock through provider submission and final persistence. A concurrent edit
    // must wait, then see SENT rather than invalidate a push already submitted.
    await setup.query("UPDATE medication_lock_test SET schedule_version=4 WHERE id=1");
    await setup.query("UPDATE delivery_lock_test SET schedule_version=4,outcome='CLAIMED' WHERE id=1");
    await sender.beginTransaction();
    const [locked]: any = await sender.query(`SELECT d.id FROM delivery_lock_test d
      JOIN medication_lock_test m ON m.id=d.medication_id
      WHERE d.id=1 AND d.outcome='CLAIMED' AND d.schedule_version=m.schedule_version FOR UPDATE`);
    assert.equal(locked.length, 1);

    let mutationCompleted = false;
    const blockedMutation = (async () => {
      await mutation.beginTransaction();
      await mutation.query("SELECT id FROM medication_lock_test WHERE id=1 FOR UPDATE");
      await mutation.query("UPDATE medication_lock_test SET schedule_version=schedule_version+1 WHERE id=1");
      await mutation.query("UPDATE delivery_lock_test SET outcome='OBSOLETE' WHERE medication_id=1 AND outcome='CLAIMED'");
      mutationCompleted = true;
      await mutation.commit();
    })();
    await tick();
    assert.equal(mutationCompleted, false, "medication mutation must wait for final dispatch lock");

    await sender.query("UPDATE delivery_lock_test SET outcome='SENT' WHERE id=1 AND outcome='CLAIMED'");
    await sender.commit();
    await blockedMutation;
    const [finalRows]: any = await setup.query("SELECT m.schedule_version,d.outcome FROM medication_lock_test m JOIN delivery_lock_test d ON d.medication_id=m.id WHERE m.id=1");
    assert.equal(finalRows[0].schedule_version, 5);
    assert.equal(finalRows[0].outcome, "SENT");
  } finally {
    await setup.query("DROP TABLE IF EXISTS delivery_lock_test,medication_lock_test");
    await Promise.all([setup.end(), mutation.end(), sender.end()]);
  }
});
