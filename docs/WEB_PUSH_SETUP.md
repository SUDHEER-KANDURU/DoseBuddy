# Historical Web Push setup notes — inactive

This document describes the unverified Web Push and Durable Object implementation that was removed from the local branch. Do not use these instructions to configure or deploy the current code.

The current local baseline is `origin/main` at `bd42755`. It retains the earlier foreground reminder flow, Service Worker notification display/click handling, legacy push routes, and five-minute missed-dose Cron processing. Those paths have not been verified as reliable background delivery.

The standalone `push_subscriptions.sql` and `push_delivery_attempts.sql` files that previously lived at the repository root have been removed as redundant: their table definitions are a subset of `database-migrations.sql`, which is the authoritative schema. They were never required by the current baseline. The canonical, up-to-date definitions of the `push_subscriptions` and `push_delivery_attempts` tables (including all additive columns, indexes, and foreign keys) live in `database-migrations.sql`.

The local `.secrets/vapid-secrets.json` file, if present, is intentionally outside Git and was not read, changed, or deleted. The current baseline does not use the new key-generation helper; do not configure these values in production based on this archived guide.

A replacement notification design must document its supported delivery behavior, database migration plan, secret format, deployment procedure, and verification evidence before deployment.

## Per-platform closed-browser delivery limits (what "delivery" actually guarantees)

DoseBuddy's reliability work (Phase 1) draws a hard line between a push provider *accepting* a request and a device *displaying* a notification. These are not the same event, and the gap is platform-dependent. The Reminder Delivery Health panel and its `PROVIDER_ACCEPTED`/`ACTIVE` copy deliberately hedge with "display isn't guaranteed when the browser is closed" for the reasons below.

What the system can and cannot promise:

- **Provider accepted (`SENT`)** means the Web Push service returned a 2xx for the request. It does **not** confirm the OS woke the browser, ran the service worker `push` handler, or showed anything. DoseBuddy records this as acceptance only, never as "displayed" and never as "medication taken."
- **Displayed** is observable only when a page or service worker is actually alive to run `showNotification`. The server cannot see it, so the health UI never infers display from `SENT`.

Platform-specific caveats for background/closed-browser delivery:

- **Desktop Chrome / Edge (Chromium):** background push generally works while the browser process is running, including when all windows are closed but the background process persists. If the browser is **fully exited** (no background process) or the OS has suspended it, a queued push may be delivered late or dropped by the OS. "Continue running background apps when the browser is closed" being off makes closed-browser delivery unreliable.
- **Desktop Firefox:** similar to Chromium — delivery depends on Firefox (or its background service) still running; a fully-quit application will not wake for a push.
- **Desktop Safari (macOS):** uses Apple Push Notification service; delivery while Safari is closed is subject to macOS power/notification policies and is not guaranteed.
- **iOS / iPadOS (Safari):** Web Push is supported **only** for web apps added to the Home Screen (installed PWAs) on recent iOS versions, and is subject to Apple's background and budget constraints. A site opened in a regular Safari tab does not receive background Web Push. Delivery timing is at the OS's discretion.
- **Android (Chrome / Firefox):** background delivery via the system push service is generally reliable while the device is online, but aggressive battery optimization / "Doze" and per-OEM app-standby settings can delay or suppress notifications when the device is idle.
- **All platforms:** a device that is offline, asleep, or powered off receives nothing until it reconnects; providers may expire undelivered messages. Expired or invalidated subscriptions surface in the health panel as `SUBSCRIPTION_NEEDS_RECOVERY` with a re-register action.

Operational takeaway: treat Web Push as **best-effort background delivery**, not a guaranteed-at-a-specific-time channel. The health panel reports the real, evidence-based state (permission, live subscription, last recorded dispatch outcome, recent failures) rather than a blanket "working," so patients are never told reminders are guaranteed when the platform cannot promise it.
