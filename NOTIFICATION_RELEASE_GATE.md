# DoseBuddy Notification Release Gate

**Status: NOT APPROVED FOR DEPLOYMENT.** This is local evidence only. It does not authorize a deployment, production migration, provider delivery, or closed-browser notification claim.

## Stranded delivery claims

Delivery attempts use bounded leases with `claim_token`, `claim_version`, `lease_expires_at`, and `dispatch_started_at`. The Worker persists the dispatch-start boundary before provider submission, locks and revalidates medication/occurrence state, and conditionally finalizes using the current token/version. A medication mutation that completes before final dispatch is revalidated out; a mutation arriving while the final lock is held waits for its outcome.

An expired unstarted claim is locked and revalidated, then released to `RETRY` only within the retry bound or marked `OBSOLETE`. An expired started claim becomes `UNCERTAIN` and is excluded from automatic provider retry. This is at-least-once/uncertain-delivery behavior, not exactly-once delivery.

## Web Push and dose-state compatibility

The Worker uses Worker Web Crypto, not the Node-only `web-push` package. It validates matching VAPID P-256 public/private keys, signs VAPID JWTs, and encrypts payloads with `aes128gcm`. RFC 8188 record framing splits payloads beyond a 4,096-byte record and sequences record nonces; unit tests decrypt payloads at 4,079 and 4,080 bytes.

`database-migrations.sql` creates `dose_occurrences.taken_at` and `missed_at` for new schemas and adds them idempotently for upgraded schemas. The disposable-MySQL migration test checks these columns and executes both MISSED and TAKEN transitions when the isolated gate is configured.

## Isolated MySQL 8 gate

`DOSEBUDDY_TEST_MYSQL_URL` was absent. `npm run test:integration` exited 0 only because it correctly skipped all three required tests; they remain **BLOCKED / UNVERIFIED**:

1. `two-connection TAKEN versus MISSED race`
2. `medication mutation serializes before the final dispatch boundary`
3. `notification migration converges twice from the legacy ledger`

The integration files read only `process.env.DOSEBUDDY_TEST_MYSQL_URL` and use `skip: !url`. They do not read `DB_URL`, Hyperdrive bindings, Aiven settings, or production configuration. Do not approve production while this gate is open.

### Later execution procedure

1. Provision a new, disposable MySQL 8 instance/schema containing no production data. Do not reuse production, Aiven, `DB_URL`, or Hyperdrive credentials.
2. In an isolated PowerShell session, set only the dedicated variable without printing it:
   ```powershell
   $env:DOSEBUDDY_TEST_MYSQL_URL = '<isolated MySQL 8 URL>'
   npm run test:integration
   Remove-Item Env:DOSEBUDDY_TEST_MYSQL_URL
   ```
3. Retain non-secret evidence of the MySQL version, disposable schema identity, command exit code, all three test names, and **zero skips**.
4. Tear down the disposable schema/server after retaining evidence. Never execute this suite against production data.

## Migration and time-zone rollout

`database-migrations.sql` was not executed. Before an authorized rollout, confirm MySQL 8 compatibility, a tested restorable backup, no orphan delivery references, and no duplicate `(event_id, subscription_id)` ledger rows other than rows the migration explicitly normalizes. Apply the additive schema migration to a disposable/staging schema first, run the three MySQL tests with zero skips, then use the normal controlled-release process.

Apply the database migration before Worker code that writes occurrence timestamps or claim fields. For rollback, stop affected Worker scheduling and restore the pre-migration backup before resuming the prior application version. Do not blindly drop the new columns, indexes, or constraints after ledger data exists: that loses audit/recovery information and is not a safe rollback.

Users require a valid canonical IANA time zone. The authenticated `PUT /api/user/time-zone` endpoint stores it; `POST /api/push/subscribe` may synchronize a valid supplied zone. No geographic default, including UTC or India, is assigned. Users with missing or invalid zones are not server-scheduled until authenticated synchronization succeeds.

## Current local evidence classification

| Check | Result | What it proves / does not prove |
|---|---|---|
| `npm run verify` | Passed: 31 unit/mock tests, build, workerd, dry-run | Worker-local behavior only; no real MySQL or device proof. |
| `npm run test:unit` | Passed: 31, 0 failed | Includes VAPID/encryption, time zone, date boundary, invalidation, and recovery mocks. |
| `npm run build` | Passed | TypeScript type check only. |
| `npm run test:workerd` | Passed | Local workerd Web Crypto and scheduler smoke only. |
| `wrangler deploy --dry-run` | Passed | Worker bundle/configuration only; no deployment or delivery proof. |
| Spring H2 regression | Passed (exit 0) | H2 configuration regression only; not MySQL integration. |
| `npm run test:integration` | 3 skipped | All named InnoDB gates remain blocked because the dedicated URL is absent. |
| Browser/device | Blocked | No authorized browser/device or push-provider session was run. |
