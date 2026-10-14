export type NotificationEventType = "REMINDER" | "MISSED";
export type DeliveryOutcome = "CLAIMED" | "SENT" | "RETRY" | "EXPIRED" | "OBSOLETE" | "FAILED" | "UNCERTAIN";

export interface DeliveryOccurrence {
  occurrenceId: number;
  medicationId: number;
  userId: number;
  scheduleVersion: number;
  localDate: string;
  localTime: string;
  eventType: NotificationEventType;
}

export interface DeliveryClaim {
  eventId: string;
  subscriptionId: number;
  token: string;
  version: number;
}

export interface DeliveryAttempt extends DeliveryClaim {
  occurrenceId: number;
  medicationId: number;
  userId: number;
  scheduleVersion: number;
  localDate: string;
  localTime: string;
  eventType: NotificationEventType;
}

export interface DoseNotificationDetails {
  medicationName: string;
  dosage: string;
}

export const DELIVERY_LEASE_SECONDS = 120;
export const DELIVERY_MAX_RETRIES = 3;

type QueryDb = { query(sql: string, values: unknown[]): Promise<[any, unknown]> };

export function notificationEventId(event: DeliveryOccurrence): string {
  return [event.eventType, event.userId, event.medicationId, event.scheduleVersion, event.localDate, event.localTime].join(":");
}

/** Build the Web Push payload without asset URLs the frontend does not ship.
 * The service worker supplies its bundled fallback icon and badge when omitted.
 */
export function buildDoseNotificationPayload(event: DeliveryOccurrence, dose: DoseNotificationDetails) {
  const eventId = notificationEventId(event);
  if (event.eventType === "REMINDER") {
    return {
      title: "DoseBuddy - Medication Reminder",
      body: `Time to take ${dose.medicationName} (${dose.dosage})`,
      tag: `reminder-${eventId}`,
      data: { type: "dose-reminder", doseId: eventId, userId: event.userId, medicationId: event.medicationId, url: "/" },
      timestamp: Date.now(),
      requireInteraction: true
    };
  }
  return {
    title: "DoseBuddy - Missed Dose",
    body: `You missed ${dose.medicationName} (${dose.dosage}) scheduled for ${event.localTime}`,
    tag: `missed-${eventId}`,
    data: { type: "missed-dose", doseId: eventId, userId: event.userId, medicationId: event.medicationId, url: "/" }
  };
}

export function revalidationSql(eventType: NotificationEventType, lock = false): string {
  const requiredState = eventType === "REMINDER" ? "PENDING" : "MISSED";
  return `SELECT o.id
    FROM dose_occurrences o
    JOIN medications m ON m.id=o.medication_id
    JOIN medication_times mt ON mt.medication_id=m.id AND TIME_FORMAT(mt.time_of_day,'%H:%i')=TIME_FORMAT(o.local_time,'%H:%i')
    WHERE o.id=? AND m.id=? AND m.user_id=? AND m.active=1
      AND m.schedule_version=? AND o.schedule_version=m.schedule_version
      AND o.local_date BETWEEN m.start_date AND m.end_date
      AND o.state='${requiredState}' LIMIT 1${lock ? " FOR UPDATE" : ""}`;
}

export async function occurrenceIsCurrent(db: QueryDb, event: DeliveryOccurrence, lock = false): Promise<boolean> {
  const [rows] = await db.query(revalidationSql(event.eventType, lock), [
    event.occurrenceId,
    event.medicationId,
    event.userId,
    event.scheduleVersion
  ]);
  return rows.length === 1;
}

function token(): string {
  return crypto.randomUUID();
}

function claimWhere(claim: DeliveryClaim): [string, unknown[]] {
  return ["event_id=? AND subscription_id=? AND outcome='CLAIMED' AND claim_token=? AND claim_version=?", [claim.eventId, claim.subscriptionId, claim.token, claim.version]];
}

/** Creates or reclaims an unstarted delivery lease. Started leases are never re-sent automatically. */
export async function claimDeliveryAttempt(
  db: QueryDb,
  event: DeliveryOccurrence,
  subscriptionId: number,
  scheduledAt: unknown
): Promise<DeliveryClaim | null> {
  const eventId = notificationEventId(event);
  const claimToken = token();
  const [insert] = await db.query(
    `INSERT IGNORE INTO push_delivery_attempts
      (event_id,occurrence_id,medication_id,schedule_version,user_id,subscription_id,event_type,scheduled_at,attempted_at,outcome,retry_count,claim_token,claim_version,lease_expires_at)
     VALUES (?,?,?,?,?,?,?,?,NOW(3),'CLAIMED',0,?,1,DATE_ADD(NOW(3),INTERVAL ? SECOND))`,
    [eventId, event.occurrenceId, event.medicationId, event.scheduleVersion, event.userId, subscriptionId, event.eventType, scheduledAt, claimToken, DELIVERY_LEASE_SECONDS]
  );
  if (Number(insert.affectedRows) === 1) return { eventId, subscriptionId, token: claimToken, version: 1 };

  const [reclaim] = await db.query(
    `UPDATE push_delivery_attempts
     SET outcome='CLAIMED',attempted_at=NOW(3),next_attempt_at=NULL,claim_token=?,claim_version=claim_version+1,
         lease_expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),dispatch_started_at=NULL,error_category=NULL
     WHERE event_id=? AND subscription_id=? AND retry_count<? AND
       ((outcome='RETRY' AND next_attempt_at<=NOW(3)) OR
        (outcome='CLAIMED' AND dispatch_started_at IS NULL AND lease_expires_at<=NOW(3)))`,
    [claimToken, DELIVERY_LEASE_SECONDS, eventId, subscriptionId, DELIVERY_MAX_RETRIES]
  );
  if (Number(reclaim.affectedRows) !== 1) return null;
  const [rows] = await db.query(
    "SELECT claim_version FROM push_delivery_attempts WHERE event_id=? AND subscription_id=? AND outcome='CLAIMED' AND claim_token=?",
    [eventId, subscriptionId, claimToken]
  );
  return rows.length === 1 ? { eventId, subscriptionId, token: claimToken, version: Number(rows[0].claim_version) } : null;
}

export async function startDeliveryDispatch(db: QueryDb, claim: DeliveryClaim): Promise<boolean> {
  const [where, values] = claimWhere(claim);
  const [result] = await db.query(
    `UPDATE push_delivery_attempts SET dispatch_started_at=NOW(3),lease_expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND) WHERE ${where} AND lease_expires_at>NOW(3)`,
    [DELIVERY_LEASE_SECONDS, ...values]
  );
  return Number(result.affectedRows) === 1;
}

export async function finalizeDelivery(db: QueryDb, claim: DeliveryClaim, outcome: DeliveryOutcome, providerStatus?: number, errorCategory?: string): Promise<boolean> {
  const [where, values] = claimWhere(claim);
  const retry = outcome === "RETRY";
  const [result] = await db.query(
    `UPDATE push_delivery_attempts SET outcome=?,provider_status=?,error_category=?,next_attempt_at=${retry ? "DATE_ADD(NOW(3),INTERVAL 5 MINUTE)" : "NULL"},lease_expires_at=NULL,uncertain_at=${outcome === "UNCERTAIN" ? "NOW(3)" : "uncertain_at"}${retry ? ",retry_count=retry_count+1" : ""} WHERE ${where}`,
    [outcome, providerStatus ?? null, errorCategory ?? null, ...values]
  );
  return Number(result.affectedRows) === 1;
}

/** Releases only an unstarted lease. Exhausted attempts become FAILED instead of requeueing. */
export async function releaseUnstartedClaim(db: QueryDb, claim: DeliveryClaim, errorCategory: string): Promise<boolean> {
  const [where, values] = claimWhere(claim);
  const [result] = await db.query(
    `UPDATE push_delivery_attempts
     SET outcome=IF(retry_count+1>=?,'FAILED','RETRY'),error_category=?,retry_count=retry_count+1,
         next_attempt_at=IF(retry_count+1>=?,NULL,DATE_ADD(NOW(3),INTERVAL 5 MINUTE)),lease_expires_at=NULL
     WHERE ${where} AND dispatch_started_at IS NULL`,
    [DELIVERY_MAX_RETRIES, errorCategory, DELIVERY_MAX_RETRIES, ...values]
  );
  return Number(result.affectedRows) === 1;
}

export async function obsoleteClaim(db: QueryDb, claim: DeliveryClaim): Promise<boolean> {
  return finalizeDelivery(db, claim, "OBSOLETE");
}
