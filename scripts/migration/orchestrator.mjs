import { randomUUID } from "node:crypto";
import { assertReadyForExecution, canonicalMigrationHash, readinessContextHash, CANONICAL_MIGRATION_SHA256 } from "./readiness.mjs";

/**
 * Dependency-injected production runner. This module deliberately has no
 * credentials, URLs, or subprocess defaults: callers must provide fresh
 * read-only evidence and an explicit execution function.
 */
export async function runControlledMigration({ gates, approve, runWrapper, runPostVerify, now = Date.now() }) {
  const migrationHash = await canonicalMigrationHash(gates.migrationPath);
  if (migrationHash !== CANONICAL_MIGRATION_SHA256) throw new Error("Migration gate failed: canonical migration changed.");
  const wrapper = await gates.verifyWrapper();
  if (!wrapper?.verified || wrapper.migrationHash !== migrationHash) throw new Error("Migration gate failed: wrapper verification failed.");
  const target = await gates.verifyTarget();
  const backup = await gates.verifyFreshBackupAndRestore();
  const preflight = await gates.verifyPreflight();
  const contextHash = readinessContextHash({ migrationHash, target, backup, preflight });
  const sessionId = randomUUID();
  const approval = await approve({ contextHash, sessionId, expiresAt: now + 10 * 60_000 });
  assertReadyForExecution({ migrationHash, target, backup, preflight, approval, sessionId, now });
  const finalCheck = await gates.verifyDriftAndLocksAgain();
  if (!finalCheck?.clean || finalCheck.contextHash !== contextHash) throw new Error("Migration gate failed: target drifted or locks changed after approval.");
  const token = randomUUID();
  const result = await runWrapper({ token, contextHash });
  if (!result?.ok) throw new Error("Migration wrapper failed; post-verification was not started.");
  const post = await runPostVerify({ contextHash });
  if (!post?.ok) throw new Error("Migration completed but post-verification failed.");
  return { contextHash, migrationHash };
}
