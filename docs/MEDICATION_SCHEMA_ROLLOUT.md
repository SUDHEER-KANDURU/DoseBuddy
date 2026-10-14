# Medication schema rollout

## Why medication creation can be blocked

`POST /api/medications/add` is used by both the manual form and prescription/AI save flow. The Worker now validates its compatible client payload first, then writes `medications.active` and `medications.schedule_version` so notification scheduling has a revisioned active medication record. Those two columns are added by `database-migrations.sql`; that file is never executed by the Worker.

If either column is absent, the route rolls back the failed notification-era insert and retries the medication and time rows using the legacy `medications` column set. It does not expose SQL, credentials, or connection details. This restores medication creation for manual and prescription/AI payloads, but notification-era reads, edits, and scheduled delivery remain unavailable until the authorized migration is complete.

## Required compatibility checks

Before an authorized rollout, inspect a staging or disposable MySQL 8 schema for:

- `users.id` and `medications.id` primary-key types. This migration expects them to be `BIGINT`, and declares the related `user_id` and `medication_id` columns as `BIGINT` so the foreign keys are type-compatible. If a target schema differs, stop and prepare a schema-specific migration rather than applying this file unchanged;
- `medications.active` and `medications.schedule_version` (required for medication create, reads, edits, and scheduled delivery). The durable production change adds them as `NOT NULL` fields with defaults of `1`, so existing medication rows are backfilled by MySQL to active revision `1`; verify those values before switching notification-era Worker behavior on;
- `users.time_zone` (required for user-local occurrence scheduling);
- `push_subscriptions`, `dose_occurrences`, and `push_delivery_attempts`, including the additive ledger columns, indexes, and foreign keys in `database-migrations.sql`.
- Duplicate `dose_occurrences` natural keys `(medication_id, schedule_version, local_date, local_time)`. The migration adds a unique index and stops if duplicates exist; review those rows before an authorized migration rather than deleting them automatically.

The migration intentionally stops on incompatible orphan data when adding foreign keys. Repair decisions must be approved; do not delete user history to force a migration through.

## Safe authorized procedure

1. Back up the target through the approved change process and rehearse on a disposable/staging MySQL 8 schema only.
2. Create an isolated empty database and set only the dedicated test variable in the current shell (do **not** set `DB_URL`, Hyperdrive, or production credentials). The integration runner is serial and refuses to run its destructive fixture unless the dedicated database has no tables:
   ```powershell
   $env:DOSEBUDDY_TEST_MYSQL_URL = "mysql://test_user:test_password@127.0.0.1:3306/dosebuddy_test"
   npm run test:integration
   Remove-Item Env:DOSEBUDDY_TEST_MYSQL_URL
   ```
   The `notification migration converges twice from the legacy ledger` gate creates a deliberately partial legacy schema, confirms MySQL 8 returns `ER_BAD_FIELD_ERROR` for missing medication columns, runs Mark as Taken through the Worker and verifies the dashboard readback before migration, then applies the migration twice and verifies timezone persistence and push-ledger schema. It also verifies a late TAKEN correction after a persisted MISSED state and provider retry/idempotency through a local intercepted provider. Those provider checks do not prove browser receipt.
3. Preflight columns, indexes, constraints, table engine, and orphan records against the reviewed SQL. Schedule a maintenance window and explicit rollback decision point.
4. Apply the reviewed, idempotent migration only through the approved production change process. This task does not execute it, change secrets, or connect to/write production.
5. Verify the schema and a non-production Worker with manual and prescription payloads. If rollback is needed, use the approved restore/schema rollback plan; do not blindly drop additive notification data.

Users must set or synchronize a valid IANA time zone through the authenticated user time-zone flow. A user with no valid zone is excluded from time-zone-dependent medication scheduling until it is set; no server-default zone is inferred.

## Current release status

With `DOSEBUDDY_TEST_MYSQL_URL` absent, the three real MySQL 8 tests are intentionally skipped and remain **BLOCKED / UNVERIFIED**. The test code reads only that dedicated variable and has no `DB_URL` or Hyperdrive fallback. Production readiness remains blocked until the approved schema rollout and all three disposable-MySQL gates pass. No claim is made here about deployed Worker, device, or closed-browser notification behavior.
