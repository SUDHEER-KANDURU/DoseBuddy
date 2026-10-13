# Targeted notification/time-zone push report

## Included
- Medication save fallback coverage for legacy notification schema compatibility.
- Time-zone persistence compatibility response when the `time_zone` column is unavailable.
- Zone-aware 22:00 scheduling across UTC date boundaries and one-hour missed-dose processing.
- MySQL-compatible idempotent notification index migration syntax.

## Verification
- Passed: focused notification, scheduling, and worker-route tests (25 tests).
- Passed: TypeScript build.
- Passed: local workerd web-push and scheduler-volume checks.
- Passed: `npx --no-install wrangler deploy --dry-run`.
- Migration integration tests were skipped because no MySQL integration environment was configured.

## Excluded known issue
`tests/ai-chat.test.ts` remains excluded from this commit. Its known unrelated AI Health Assistant verification failure was not run or changed as part of this notification/time-zone push.
