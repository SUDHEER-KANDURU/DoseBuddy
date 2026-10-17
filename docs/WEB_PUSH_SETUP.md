# Historical Web Push setup notes — inactive

This document describes the unverified Web Push and Durable Object implementation that was removed from the local branch. Do not use these instructions to configure or deploy the current code.

The current local baseline is `origin/main` at `bd42755`. It retains the earlier foreground reminder flow, Service Worker notification display/click handling, legacy push routes, and five-minute missed-dose Cron processing. Those paths have not been verified as reliable background delivery.

The standalone `push_subscriptions.sql` and `push_delivery_attempts.sql` files that previously lived at the repository root have been removed as redundant: their table definitions are a subset of `database-migrations.sql`, which is the authoritative schema. They were never required by the current baseline. The canonical, up-to-date definitions of the `push_subscriptions` and `push_delivery_attempts` tables (including all additive columns, indexes, and foreign keys) live in `database-migrations.sql`.

The local `.secrets/vapid-secrets.json` file, if present, is intentionally outside Git and was not read, changed, or deleted. The current baseline does not use the new key-generation helper; do not configure these values in production based on this archived guide.

A replacement notification design must document its supported delivery behavior, database migration plan, secret format, deployment procedure, and verification evidence before deployment.
