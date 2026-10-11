import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

test("Web Push payload uses encrypted aes128gcm with VAPID authorization", async () => {
  const vapidPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const vapidJwk = await webcrypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const vapidPublic = Buffer.concat([
    Buffer.from([4]), Buffer.from(vapidJwk.x, "base64url"), Buffer.from(vapidJwk.y, "base64url")
  ]);
  const recipient = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const authSecret = webcrypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: "https://push.example.test/send/test-endpoint",
    expirationTime: null,
    keys: {
      p256dh: b64url(await webcrypto.subtle.exportKey("raw", recipient.publicKey)),
      auth: b64url(authSecret)
    }
  };
  const request = await buildPushPayload({
    data: { title: "DoseBuddy test", body: "Encrypted test payload", data: { eventId: "test-event-1" } },
    options: { ttl: 60, urgency: "high" }
  }, subscription, {
    subject: "mailto:notifications@example.test",
    publicKey: b64url(vapidPublic),
    privateKey: vapidJwk.d
  });
  assert.equal(request.method, "post");
  assert.equal(request.headers["content-encoding"], "aes128gcm");
  assert.equal(request.headers["content-type"], "application/octet-stream");
  assert.match(request.headers.authorization, /^vapid t=/);
  assert.ok(request.body instanceof Uint8Array);
  assert.ok(request.body.byteLength > 16);
  assert.ok(!Buffer.from(request.body).includes(Buffer.from("Encrypted test payload")));
});
