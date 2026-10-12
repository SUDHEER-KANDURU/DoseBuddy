# DoseBuddy Notification System Implementation Report

## Current status

**Not approved for deployment.** This report records local implementation and verification only. No production connection, database migration, deployment, VAPID secret change, push-provider delivery, or browser/device test was performed.

## Implemented behavior

- `cloudflare-worker/web-push.ts` uses Worker Web Crypto rather than the Node-only `web-push` dependency. It validates matching P-256 VAPID keys, signs ES256 VAPID JWTs, and encrypts payloads using Web Push `aes128gcm`.
- Web Push framing uses RFC 8188 records. Payloads larger than one 4,096-byte record are split into records with correctly sequenced nonces rather than sent as an oversized single record. Unit tests decrypt payloads at 4,079 and 4,080 bytes.
- Scheduled dose occurrences use explicit local dates/times and IANA user time zones. Missing or invalid zones are rejected rather than silently defaulted to UTC, India, or another geography. DST gaps and repeated local times have unit/mock coverage.
- `dose_occurrences` has conditional TAKEN/MISSED transitions; TAKEN cannot be overwritten by a later MISSED transition. The migration now supplies nullable `taken_at` and `missed_at` columns for fresh and upgraded schemas.
- Delivery attempts use tokenized bounded leases. Unstarted expired claims are locked and revalidated before a bounded retry. Claims whose provider-dispatch boundary was persisted become `UNCERTAIN` after expiry and are excluded from automatic resend, because provider acceptance cannot be determined after a persistence failure.
- Medication edits, deletions, and reschedules invalidate obsolete attempts; dispatch revalidates current medication, schedule revision, and occurrence state before provider submission.

## Current local evidence

| Check | Result | Scope |
|---|---:|---|
| `npm run verify` | Passed | 31 Worker unit/mock tests, TypeScript build, local workerd Web Crypto/scheduler smoke, and Wrangler bundle dry-run. |
| Spring H2 regression | Passed (exit 0) | Spring/H2 configuration regression only; it is not MySQL integration. |
| `npm run test:integration` without `DOSEBUDDY_TEST_MYSQL_URL` | Passed with 3 skips | The required real MySQL 8 tests are blocked/unverified; no database URL was used. |
| Browser/device/provider delivery | Blocked | No authorized real browser/device or provider session was run. Closed-browser delivery is unverified. |

See [NOTIFICATION_RELEASE_GATE.md](NOTIFICATION_RELEASE_GATE.md) for the exact MySQL release gate, disposable-database procedure, migration rollout constraints, and time-zone policy.
