export interface SqlConnection {
  query(statement: string, values?: unknown[]): Promise<[any, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface OccurrenceIdentity {
  medicationId: number;
  userId: number;
  scheduleVersion: number;
  localDate: string;
  localTime: string;
  scheduledAtUtc: Date | string;
}

export async function upsertOccurrence(db: SqlConnection, occurrence: OccurrenceIdentity): Promise<number> {
  const [result] = await db.query(
    `INSERT INTO dose_occurrences
      (medication_id,user_id,schedule_version,local_date,local_time,scheduled_at_utc,state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'PENDING',NOW(),NOW())
     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),scheduled_at_utc=VALUES(scheduled_at_utc),updated_at=NOW()`,
    [occurrence.medicationId, occurrence.userId, occurrence.scheduleVersion, occurrence.localDate, occurrence.localTime, occurrence.scheduledAtUtc]
  );
  return Number(result.insertId);
}

export async function markOccurrenceMissed(db: SqlConnection, occurrenceId: number): Promise<boolean> {
  const [result] = await db.query(
    "UPDATE dose_occurrences SET state='MISSED',missed_at=NOW(),updated_at=NOW() WHERE id=? AND state='PENDING'",
    [occurrenceId]
  );
  return Number(result.affectedRows) === 1;
}

export async function markOccurrenceTaken(db: SqlConnection, occurrenceId: number): Promise<boolean> {
  const [result] = await db.query(
    "UPDATE dose_occurrences SET state='TAKEN',taken_at=NOW(),missed_at=NULL,updated_at=NOW() WHERE id=? AND state IN ('PENDING','MISSED')",
    [occurrenceId]
  );
  return Number(result.affectedRows) === 1;
}

export async function transact<T>(db: SqlConnection, operation: () => Promise<T>): Promise<T> {
  await db.beginTransaction();
  try {
    const result = await operation();
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
