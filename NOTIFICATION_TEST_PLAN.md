# DoseBuddy Notification System Test Plan

## Evidence status

This plan does not constitute completed browser or deployment testing. Local Worker unit/mock tests, workerd smoke, TypeScript build, Wrangler dry-run, and Spring/H2 regression pass; the three real MySQL 8 tests and all real browser/device checks remain release gates. See [NOTIFICATION_RELEASE_GATE.md](NOTIFICATION_RELEASE_GATE.md) for the exact results and isolated-database procedure.

## Automated local checks

1. Run `npm run verify`. It covers Worker unit/mock behavior, encrypted Web Push generation, VAPID key matching, time-zone/DST scheduling, date-boundary behavior, medication invalidation, lease recovery, TypeScript, local workerd smoke, and a Wrangler bundle/configuration dry-run.
2. With no database URL configured, run:
   ```powershell
   Remove-Item Env:DOSEBUDDY_TEST_MYSQL_URL -ErrorAction SilentlyContinue
   npm run test:integration
   ```
   Expect exactly three skipped tests. This confirms that the suite does not silently use `DB_URL`, Hyperdrive, Aiven, or production configuration.
3. Run the Spring H2 regression suite:
   ```powershell
   .\DoseBuddy_Backend\mvnw.cmd -f .\DoseBuddy_Backend\pom.xml test -q
   ```

## Required isolated MySQL 8 gate

Provision a new disposable MySQL 8 schema containing no production data. In an isolated PowerShell session, set only `DOSEBUDDY_TEST_MYSQL_URL`, run `npm run test:integration`, retain non-secret evidence of all three named tests with zero skips, then remove the variable and destroy the disposable schema/server. Do not use production, Aiven, `DB_URL`, or Hyperdrive credentials.

The tests are: `two-connection TAKEN versus MISSED race`, `medication mutation serializes before the final dispatch boundary`, and `notification migration converges twice from the legacy ledger`.

## Required browser/device validation

After an authorized non-production deployment, use a real browser/device and provider subscription to verify subscription permission, encrypted reminder receipt, correct medication/time display, notification interaction, and closed-browser behavior. Record the browser/device, provider response, schedule time zone, and result without exposing VAPID private keys. Until this is performed, closed-browser delivery remains unverified.
