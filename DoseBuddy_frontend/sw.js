
const DOSEBUDDY_URL = self.location.origin;

// Branded fallback icon as an inline data: SVG. There is no /favicon.ico asset,
// so defaulting push icon/badge to it caused a failing fetch for every push
// notification. Keep data.icon/data.badge overrides working.
const NOTIFICATION_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2300A19B'/%3E%3Cg transform='translate(16%2C16) scale(0.9) translate(-12%2C-12)'%3E%3Cpath d='M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/g%3E%3C/svg%3E";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
    if (!event.data) return;
    try {
        const data = event.data.json();
        // Older Worker builds sent /favicon.ico even though the frontend does
        // not ship that file. Replace that stale path with the bundled icon so
        // an otherwise valid background push is not paired with a broken asset.
        const icon = data.icon && data.icon !== "/favicon.ico" ? data.icon : NOTIFICATION_ICON;
        const badge = data.badge && data.badge !== "/favicon.ico" ? data.badge : NOTIFICATION_ICON;
        event.waitUntil(
            self.registration.showNotification(data.title || "DoseBuddy", {
                body:  data.body  || "",
                icon,
                badge,
                tag:   data.tag   || "dosebuddy-push",
                data:  data.data  || {},
            })
        );
    } catch (e) {
        console.warn("[DoseBuddy SW] push parse error", e);
    }
});

// ── Notification click ───────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
    event.notification.close();

    const targetUrl = (event.notification.data && event.notification.data.url)
        ? event.notification.data.url
        : DOSEBUDDY_URL;

    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            // Focus an already-open DoseBuddy tab if one exists
            for (const client of clientList) {
                if (client.url.startsWith(DOSEBUDDY_URL) && "focus" in client) {
                    return client.focus();
                }
            }
            // Otherwise open a new tab
            if (self.clients.openWindow) {
                return self.clients.openWindow(targetUrl);
            }
        })
    );
});
