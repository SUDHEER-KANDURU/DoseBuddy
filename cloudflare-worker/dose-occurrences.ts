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

function missingOccurrenceTimestamp(error: unknown, allowed: Set<string>): string | null {
  const e = error as { code?: unknown; message?: unknown; sqlMessage?: unknown };
  if (e.code !== "ER_BAD_FIELD_ERROR") return null;
  const message = [e.message, e.sqlMessage].filter(value => typeof value === "string").join(" ");
  for (const column of allowed) {
    if (new RegExp(`\\b${column}\\b`, "i").test(message)) return column;
  }
  return null;
}

async function updateOccurrenceState(
  db: SqlConnection,
  state: "TAKEN" | "MISSED",
  occurrenceId: number,
  timestamps: string[],
  predicate: string
): Promise<boolean> {
  // Older notification-era schemas can have dose_occurrences without all of
  // the later timestamp columns. Drop only the specifically missing optional
  // timestamp and retry; unrelated SQL failures remain visible to the caller.
  const remaining = new Set(timestamps);
  while (true) {
    const assignments = state === "TAKEN"
      ? [...remaining].map(column => column === "taken_at" ? "taken_at=NOW(3)" : column === "missed_at" ? "missed_at=NULL" : "updated_at=NOW(3)")
      : [...remaining].map(column => column === "missed_at" ? "missed_at=NOW(3)" : "updated_at=NOW(3)");
    const set = [`state='${state}'`, ...assignments].join(",");
    try {
      const [result] = await db.query(`UPDATE dose_occurrences SET ${set} WHERE id=? AND ${predicate}`, [occurrenceId]);
      return Number(result.affectedRows) === 1;
    } catch (error) {
      const missing = missingOccurrenceTimestamp(error, remaining);
      if (!missing) throw error;
      remaining.delete(missing);
    }
  }
}

export async function upsertOccurrence(db: SqlConnection, occurrence: OccurrenceIdentity): Promise<number> {
  // Hold the parent medication row while resolving/creating the natural dose
  // identity. This also prevents duplicate occurrences on older installations
  // that have the table but predate its unique schedule index.
  await db.query("SELECT id FROM medications WHERE id=? FOR UPDATE", [occurrence.medicationId]);
  const [existing] = await db.query(
    `SELECT id FROM dose_occurrences
     WHERE medication_id=? AND schedule_version=? AND local_date=? AND local_time=?
     ORDER BY id LIMIT 1 FOR UPDATE`,
    [occurrence.medicationId, occurrence.scheduleVersion, occurrence.localDate, occurrence.localTime]
  );
  if (existing?.length) {
    const id = Number(existing[0].id);
    await db.query("UPDATE dose_occurrences SET scheduled_at_utc=?,updated_at=NOW(3) WHERE id=?", [occurrence.scheduledAtUtc, id]);
    return id;
  }
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
  return updateOccurrenceState(db, "MISSED", occurrenceId, ["missed_at", "updated_at"], "state='PENDING'");
}

export async function markOccurrenceTaken(db: SqlConnection, occurrenceId: number): Promise<boolean> {
  return updateOccurrenceState(db, "TAKEN", occurrenceId, ["taken_at", "missed_at", "updated_at"], "state IN ('PENDING','MISSED')");
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
