import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { isVapidKeyPairValid } from "../cloudflare-worker/vapid-validation.ts";

async function makeVapidPair() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
    privateKey: jwk.d
  };
}

test("VAPID validation accepts a matching pair and rejects a mismatch", async () => {
  const first = await makeVapidPair();
  const second = await makeVapidPair();
  assert.equal(await isVapidKeyPairValid(first.publicKey, first.privateKey), true);
  assert.equal(await isVapidKeyPairValid(first.publicKey, second.privateKey), false);
  assert.equal(await isVapidKeyPairValid("invalid", first.privateKey), false);
});
