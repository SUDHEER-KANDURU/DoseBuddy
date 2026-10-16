import test from "node:test";
import assert from "node:assert/strict";
import { canonicalMigrationHash, assertReadyForExecution, readinessContextHash, CANONICAL_MIGRATION_SHA256, FINAL_APPROVAL_PHRASE } from "../scripts/migration/readiness.mjs";

const evidence = () => ({
  migrationHash: CANONICAL_MIGRATION_SHA256,
  target: { worker: "dosebuddy", binding: "HYPERDRIVE", hyperdriveId: "18124332f92a4a538050187dc00e8a84", database: "defaultdb", deploymentId: "deployment-1" },
  backup: { done: true, consistent: true, inventoryVerified: true, restoredLocally: true, fingerprintsMatch: true, backupId: "backup-1", fingerprint: "backup-fingerprint-1" },
  preflight: { schemaIsPreMigration: true, noPartialMigration: true, noDuplicatesOrOrphans: true, noBlockingLocks: true, wrapperVerified: true, stopsOnSqlError: true, fingerprint: "preflight-fingerprint-1" }
});
const approved = (now = 1_000_000) => {
  const base = evidence();
  return { ...base, approval: { phrase: FINAL_APPROVAL_PHRASE, sessionId: "session-1", approvedAt: now - 1, contextHash: readinessContextHash(base) }, sessionId: "session-1", now };
};

test("readiness accepts only the reviewed migration with current same-session approval", async () => {
  assert.equal(await canonicalMigrationHash(new URL("../database-migrations.sql", import.meta.url)), CANONICAL_MIGRATION_SHA256);
  assert.equal(assertReadyForExecution(approved()), true);
});

test("readiness fails closed for a wrong target, backup failure, or partial migration", () => {
  for (const change of [
    { target: { ...approved().target, database: "other" } },
    { backup: { ...approved().backup, fingerprintsMatch: false } },
    { preflight: { ...approved().preflight, noPartialMigration: false } }
  ]) assert.throws(() => assertReadyForExecution({ ...approved(), ...change }), /Migration gate failed/);
});

test("readiness rejects missing, stale, or cross-session approval", () => {
  assert.throws(() => assertReadyForExecution({ ...approved(), approval: undefined }), /final approval/);
  assert.throws(() => assertReadyForExecution({ ...approved(), approval: { ...approved().approval, approvedAt: 1 } }), /stale/);
  assert.throws(() => assertReadyForExecution({ ...approved(), approval: { ...approved().approval, sessionId: "old" } }), /final approval/);
});

test("readiness rejects approval evidence replayed for a different target, backup, or preflight", () => {
  assert.throws(() => assertReadyForExecution({ ...approved(), target: { ...approved().target, deploymentId: "deployment-2" } }), /final approval/);
  assert.throws(() => assertReadyForExecution({ ...approved(), backup: { ...approved().backup, fingerprint: "older-backup" } }), /final approval/);
  assert.throws(() => assertReadyForExecution({ ...approved(), preflight: { ...approved().preflight, fingerprint: "older-preflight" } }), /final approval/);
});
