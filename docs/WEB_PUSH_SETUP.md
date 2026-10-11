# Historical Web Push setup notes — inactive

This document describes the unverified Web Push and Durable Object implementation that was removed from the local branch. Do not use these instructions to configure or deploy the current code.

The current local baseline is `origin/main` at `bd42755`. It retains the earlier foreground reminder flow, Service Worker notification display/click handling, legacy push routes, and five-minute missed-dose Cron processing. Those paths have not been verified as reliable background delivery.

`push_subscriptions.sql` and `push_delivery_attempts.sql` are retained as historical migration artifacts because they may have been copied to another environment. Their presence here does not mean they are required by the current baseline or have been applied anywhere. Do not run them as part of this rollback.

The local `.secrets/vapid-secrets.json` file, if present, is intentionally outside Git and was not read, changed, or deleted. The current baseline does not use the new key-generation helper; do not configure these values in production based on this archived guide.

A replacement notification design must document its supported delivery behavior, database migration plan, secret format, deployment procedure, and verification evidence before deployment.
