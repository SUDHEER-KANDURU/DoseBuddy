
const DOSEBUDDY_URL = self.location.origin;

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
        event.waitUntil(
            self.registration.showNotification(data.title || "DoseBuddy", {
                body:  data.body  || "",
                icon:  data.icon  || "/favicon.ico",
                badge: data.badge || "/favicon.ico",
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
