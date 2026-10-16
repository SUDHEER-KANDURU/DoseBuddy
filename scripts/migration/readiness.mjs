import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CANONICAL_MIGRATION_SHA256 = "2F9AC09480527A4E124935A59254514FC98CD95BBD20EBEF9A14EF6EC9D84E5F";
export const FINAL_APPROVAL_PHRASE = "APPROVE_DOSEBUDDY_PRODUCTION_MIGRATION";

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Migration gate failed: ${label} is missing.`);
  return value;
}

/**
 * Produces a non-secret identity for the exact evidence reviewed in one run.
 * A human approval must quote this value; it is not a signature and cannot
 * replace an authenticated operator or a live target query.
 */
export function readinessContextHash({ migrationHash, target, backup, preflight }) {
  assertCanonicalMigration(migrationHash);
  assertProductionTarget(target);
  assertBackupEvidence(backup);
  assertPreflight(preflight);
  const material = JSON.stringify({
    migrationHash,
    target: {
      worker: target.worker,
      binding: target.binding,
      hyperdriveId: target.hyperdriveId,
      database: target.database,
      deploymentId: requiredString(target.deploymentId, "target deployment identity")
    },
    backup: {
      backupId: requiredString(backup.backupId, "backup identity"),
      fingerprint: requiredString(backup.fingerprint, "backup fingerprint")
    },
    preflight: {
      fingerprint: requiredString(preflight.fingerprint, "preflight fingerprint")
    }
  });
  return createHash("sha256").update(material).digest("hex").toUpperCase();
}

export async function canonicalMigrationHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase();
}

export function assertCanonicalMigration(hash) {
  if (hash !== CANONICAL_MIGRATION_SHA256) {
    throw new Error("Migration gate failed: canonical migration hash does not match the reviewed file.");
  }
}

export function assertProductionTarget(target) {
  if (!target || target.worker !== "dosebuddy" || target.binding !== "HYPERDRIVE" || target.hyperdriveId !== "18124332f92a4a538050187dc00e8a84" || target.database !== "defaultdb") {
    throw new Error("Migration gate failed: deployed Worker or Hyperdrive target is not the reviewed DoseBuddy target.");
  }
}

export function assertBackupEvidence(backup) {
  if (!backup?.done || !backup?.consistent || !backup?.inventoryVerified || !backup?.restoredLocally || !backup?.fingerprintsMatch) {
    throw new Error("Migration gate failed: a fresh, consistent backup and matching local restore are required.");
  }
}

export function assertPreflight(preflight) {
  if (!preflight?.schemaIsPreMigration || !preflight?.noPartialMigration || !preflight?.noDuplicatesOrOrphans || !preflight?.noBlockingLocks || !preflight?.wrapperVerified || !preflight?.stopsOnSqlError) {
    throw new Error("Migration gate failed: preflight did not establish a safe migration boundary.");
  }
}

export function assertFreshFinalApproval(approval, { sessionId, contextHash, now = Date.now(), maxAgeMs = 10 * 60_000 } = {}) {
  if (!approval || approval.phrase !== FINAL_APPROVAL_PHRASE || !sessionId || approval.sessionId !== sessionId || !Number.isFinite(approval.approvedAt) || !contextHash || approval.contextHash !== contextHash) {
    throw new Error("Migration gate failed: explicit final approval for this session is required.");
  }
  if (approval.approvedAt > now || now - approval.approvedAt > maxAgeMs) {
    throw new Error("Migration gate failed: final approval is stale or has an invalid timestamp.");
  }
}

export function assertReadyForExecution({ migrationHash, target, backup, preflight, approval, sessionId, now }) {
  const contextHash = readinessContextHash({ migrationHash, target, backup, preflight });
  assertFreshFinalApproval(approval, { sessionId, contextHash, now });
  return true;
}
