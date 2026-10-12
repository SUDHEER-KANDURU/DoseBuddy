import { encodeBase64Url } from "../cloudflare-worker/web-push.ts";

export async function webPushFixture() {
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey));
  const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const recipientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", recipient.publicKey));
  return {
    env: {
      VAPID_PUBLIC_KEY: encodeBase64Url(vapidPublic),
      VAPID_PRIVATE_KEY: vapidPrivate.d!,
      VAPID_EMAIL: "mailto:test@example.test"
    },
    subscription: {
      endpoint: "https://push.example.test/message/1",
      keys: {
        p256dh: encodeBase64Url(recipientPublic),
        auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
      }
    }
  };
}
