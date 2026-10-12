import { encodeBase64Url, prepareWebPush } from "../../cloudflare-worker/web-push";
import { dueOccurrencesAtInstant } from "../../cloudflare-worker/scheduling";

export default {
  async fetch(): Promise<Response> {
    const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
    const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const prepared = await prepareWebPush({
      endpoint: "https://push.example.test/message",
      keys: {
        p256dh: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", recipient.publicKey))),
        auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      }
    }, JSON.stringify({ runtime: "workerd" }), {
      publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey))),
      privateKey: vapidJwk.d!,
      subject: "mailto:test@example.com"
    });
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      time_zone: "UTC",
      time_str: `${String(Math.floor(index % 1_440 / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
      start_date: "2026-01-01",
      end_date: "2026-12-31"
    }));
    const schedulerStarted = performance.now();
    const due = dueOccurrencesAtInstant(rows, new Date("2026-06-01T12:00:20Z"));
    const schedulerMs = performance.now() - schedulerStarted;
    return Response.json({
      ok: prepared.body.length > 100,
      encoding: prepared.headers["Content-Encoding"],
      schedulerRows: rows.length,
      schedulerDue: due.length,
      schedulerMs
    });
  }
};
