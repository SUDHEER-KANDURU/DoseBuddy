// Canonical OS-level notification `tag` shared by the foreground and background paths.
// Derived only from dose identity (user, medication, local date, HH:MM) so it is
// schedule-version- and event-type-INDEPENDENT. The browser coalesces notifications
// that share this tag, so the foreground local notification and the background push
// for the same dose produce a byte-identical string. This is an intentional copy of
// the worker's `canonicalDoseTag` in cloudflare-worker/notification-delivery.ts (the
// two runtimes cannot share one import); tests/notification-dedup.test.ts asserts the
// two implementations stay byte-identical.
export function canonicalDoseTag(userId, medicationId, localDate, localTime) {
    return `dose-${userId}-${medicationId}-${localDate}-${String(localTime).slice(0, 5).replace(":", "")}`;
}
