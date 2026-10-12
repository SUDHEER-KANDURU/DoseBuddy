import test from "node:test";
import assert from "node:assert/strict";
import { createVapidToken, decodeBase64Url, encodeBase64Url, prepareWebPush, sendWebPush, type VapidConfig } from "../cloudflare-worker/web-push.ts";

const encoder = new TextEncoder();

async function keyMaterial(): Promise<{ vapid: VapidConfig; subscription: any; recipientPrivate: CryptoKey }> {
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey));
  const recipient = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const recipientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", recipient.publicKey));
  return {
    vapid: { publicKey: encodeBase64Url(vapidPublic), privateKey: vapidPrivate.d!, subject: "mailto:test@example.com" },
    subscription: { endpoint: "https://push.example.test/message/1", keys: { p256dh: encodeBase64Url(recipientPublic), auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))) } },
    recipientPrivate: recipient.privateKey
  };
}

async function hmac(key: Uint8Array, value: Uint8Array) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, value));
}
function concat(...parts: Uint8Array[]) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
async function expand(prk: Uint8Array, info: Uint8Array, length: number) { const value = await hmac(prk, concat(info, new Uint8Array([1]))); return value.slice(0, length); }

async function decrypt(body: Uint8Array, subscription: any, recipientPrivate: CryptoKey) {
  const salt = body.slice(0, 16);
  const keyLength = body[20];
  const senderPublic = body.slice(21, 21 + keyLength);
  const ciphertext = body.slice(21 + keyLength);
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, recipientPrivate, 256));
  const recipientPublic = decodeBase64Url(subscription.keys.p256dh, 65);
  const authPrk = await hmac(decodeBase64Url(subscription.keys.auth, 16), shared);
  const ikm = await expand(authPrk, concat(encoder.encode("WebPush: info\0"), recipientPublic, senderPublic), 32);
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await expand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const plaintext: Uint8Array[] = [];
  let offset = 0;
  let sequence = 0;
  while (offset < ciphertext.length) {
    const length = Math.min(recordSize, ciphertext.length - offset);
    const recordNonce = new Uint8Array(nonce);
    let value = sequence++;
    for (let index = recordNonce.length - 1; value > 0 && index >= 0; index--) {
      recordNonce[index] ^= value & 0xff;
      value = Math.floor(value / 256);
    }
    const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: recordNonce }, key, ciphertext.slice(offset, offset + length)));
    const delimiter = record.at(-1);
    assert.equal(delimiter, offset + length === ciphertext.length ? 2 : 1);
    plaintext.push(record.slice(0, -1));
    offset += length;
  }
  return concat(...plaintext);
}

test("RFC 8291 body decrypts and does not expose plaintext", async () => {
  const material = await keyMaterial();
  const plaintext = JSON.stringify({ title: "Dose reminder", medicationId: 42 });
  const prepared = await prepareWebPush(material.subscription, plaintext, material.vapid, { salt: new Uint8Array(16).fill(7) });
  assert.equal(prepared.headers["Content-Encoding"], "aes128gcm");
  assert.equal(prepared.headers["Content-Type"], "application/octet-stream");
  assert.equal(new TextDecoder().decode(prepared.body).includes(plaintext), false);
  const decrypted = await decrypt(prepared.body, material.subscription, material.recipientPrivate);
  assert.equal(new TextDecoder().decode(decrypted), plaintext);
});

test("RFC 8188 record framing decrypts at and beyond one record", async () => {
  const material = await keyMaterial();
  for (const size of [4079, 4080]) {
    const plaintext = "x".repeat(size);
    const prepared = await prepareWebPush(material.subscription, plaintext, material.vapid, { salt: new Uint8Array(16).fill(size % 256) });
    assert.equal(new DataView(prepared.body.buffer, prepared.body.byteOffset + 16, 4).getUint32(0), 4096);
    assert.equal(new TextDecoder().decode(await decrypt(prepared.body, material.subscription, material.recipientPrivate)), plaintext);
  }
});

test("VAPID claims use endpoint origin and a bounded expiry", async () => {
  const { vapid } = await keyMaterial();
  const now = Date.parse("2026-10-11T00:00:00Z");
  const token = await createVapidToken(vapid, "https://push.example.test/path", now);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decodeBase64Url(header))), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "mailto:test@example.com");
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 86400);
  const publicKey = await crypto.subtle.importKey("raw", decodeBase64Url(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, decodeBase64Url(signature), encoder.encode(`${header}.${payload}`)), true);
});

test("mismatched and malformed VAPID keys are rejected", async () => {
  const first = await keyMaterial();
  const second = await keyMaterial();
  await assert.rejects(createVapidToken({ ...first.vapid, privateKey: second.vapid.privateKey }, first.subscription.endpoint), /match|key|point|valid/i);
  await assert.rejects(createVapidToken({ ...first.vapid, publicKey: "bad" }, first.subscription.endpoint), /length|key/i);
});

test("provider responses distinguish expiry and retry", async () => {
  const material = await keyMaterial();
  const expired = await sendWebPush(material.subscription, { ok: true }, material.vapid, async () => new Response(null, { status: 410 }));
  assert.deepEqual(expired, { ok: false, status: 410, expired: true, retryable: false });
  const transient = await sendWebPush(material.subscription, { ok: true }, material.vapid, async () => new Response(null, { status: 503 }));
  assert.equal(transient.retryable, true);
  assert.equal(transient.expired, false);
});
