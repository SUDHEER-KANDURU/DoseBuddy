
const DOSEBUDDY_URL = self.location.origin;

self.addEventListener("install", () => {
    console.log("[DoseBuddy SW] Installing service worker");
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    console.log("[DoseBuddy SW] Activating service worker");
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
    console.log("[DoseBuddy SW] Push event received");
    
    if (!event.data) {
        console.warn("[DoseBuddy SW] Push event has no data");
        return;
    }
    
    try {
        const data = event.data.json();
        console.log("[DoseBuddy SW] Push data:", data);
        
        const notificationOptions = {
            body: data.body || "",
            icon: data.icon || "/favicon.ico",
            badge: data.badge || "/favicon.ico",
            tag: data.tag || "dosebuddy-push",
            data: data.data || {},
            requireInteraction: true,
            actions: [
                {
                    action: "mark-taken",
                    title: "Mark as Taken"
                },
                {
                    action: "dismiss",
                    title: "Dismiss"
                }
            ]
        };
        
        event.waitUntil(
            self.registration.showNotification(
                data.title || "DoseBuddy", 
                notificationOptions
            )
        );
    } catch (e) {
        console.error("[DoseBuddy SW] Push parse error:", e);
        // Fallback notification
        event.waitUntil(
            self.registration.showNotification("DoseBuddy Notification", {
                body: "You have a new notification",
                icon: "/favicon.ico"
            })
        );
    }
});

// ── Notification click ───────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
    console.log("[DoseBuddy SW] Notification clicked:", event.action);
    event.notification.close();

    if (event.action === "mark-taken") {
        // Handle marking dose as taken
        event.waitUntil(handleMarkTaken(event.notification.data));
        return;
    }

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

async function handleMarkTaken(notificationData) {
    try {
        // This would need to communicate with the main app
        // For now, just open the app - the user can mark it there
        const clients = await self.clients.matchAll({ type: "window" });
        
        if (clients.length > 0) {
            const client = clients[0];
            client.postMessage({
                type: "MARK_DOSE_TAKEN",
                data: notificationData
            });
            client.focus();
        } else {
            self.clients.openWindow(DOSEBUDDY_URL);
        }
    } catch (error) {
        console.error("[DoseBuddy SW] Error handling mark taken:", error);
    }
}
