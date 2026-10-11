# Web Push production setup

The Worker uses `@block65/webcrypto-web-push` for RFC 8291 `aes128gcm` payload encryption and RFC 8292 VAPID authorization. Its signing and encryption use the Worker Web Crypto API. The Service Worker displays push events; the operating system controls background notification sound.

## Generate and configure keys

1. Run `node scripts/generate-vapid-keys.mjs notifications@example.com` with a monitored contact address. It writes a P-256 VAPID key pair to `.secrets/vapid-secrets.json`, which is excluded from Git.
2. From the repository root, submit the three values together with `npx wrangler secret bulk .secrets/vapid-secrets.json --name dosebuddy`. Do not display or commit that file. Wrangler creates a Worker version when secrets are changed.
3. Verify only key names with `npx wrangler secret list --name dosebuddy`. The authenticated `/api/push/vapid-key` endpoint validates that the public and private keys match before returning the public key.
4. Apply the additive `push_subscriptions.sql` and `push_delivery_attempts.sql` migrations to the production MySQL database before enabling notification settings. They create subscription and diagnostics tables if absent; they do not modify existing account or medication rows.
5. Deploy the Worker and frontend using the existing Wrangler configurations. The Worker deployment includes a SQLite Durable Object migration (`v1`) and the one-minute Cron reconciliation trigger.

If an existing VAPID key has ever been used by a browser subscription, keep using that exact key pair. Replacing it causes existing subscriptions to reject delivery; users must enable notifications again to create subscriptions with the new public key.

## Runtime behavior and limits

Medication creation schedules reminder and missed-deadline jobs in a per-user Durable Object. Alarms persist independently of browser tabs and store stable medication/date/time occurrence identities. A five-minute Cron trigger reconciles medication schedules and recovers events after missed alarms. The scheduled reminder and the one-minute missed transition are separate jobs. SQL is re-read before either action; missed transitions lock the medication row and preserve TAKEN status.

Durable Object alarms are at-least-once and Cloudflare may retry them; they do not guarantee exact wall-clock execution. The DO keeps stable event IDs and the Service Worker uses a stable notification tag with `renotify: false`, but a push provider acceptance is not proof that an operating system displayed or sounded the notification. Closed-browser display must still be tested on the target browser/device.

SQLite-backed Durable Objects are available on Cloudflare's Workers Free plan. Cloudflare documents free-tier daily request and storage limits; exceeding a free allowance can stop operations until reset. Review the current [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) before scaling. Browser push relies on the browser vendor's push service; this project adds no SMS provider.
