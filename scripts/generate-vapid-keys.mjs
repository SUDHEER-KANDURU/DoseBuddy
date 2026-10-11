import { mkdir, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const contactEmail = process.argv[2];
if (!contactEmail || !contactEmail.includes("@")) {
  throw new Error("Usage: node scripts/generate-vapid-keys.mjs notifications@example.com");
}

const { privateKey } = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
const b64url = (value) => Buffer.from(value).toString("base64url");
const publicKey = b64url(Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url")
]));
const privateKeyValue = jwk.d;
const outputDirectory = ".secrets";
await mkdir(outputDirectory, { recursive: true });
await writeFile(`${outputDirectory}/vapid-secrets.json`, JSON.stringify({
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKeyValue,
  VAPID_EMAIL: contactEmail
}, null, 2), { mode: 0o600 });
console.log(`Generated VAPID key pair at ${outputDirectory}/vapid-secrets.json. Keep this file private.`);
