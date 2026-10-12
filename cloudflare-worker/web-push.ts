const encoder = new TextEncoder();

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PreparedWebPush {
  body: Uint8Array;
  headers: Record<string, string>;
  vapidToken: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  expired: boolean;
  retryable: boolean;
}

export function decodeBase64Url(value: string, expectedLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const normal = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(normal), char => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid base64url value");
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new Error(`Invalid key length; expected ${expectedLength} bytes`);
  }
  return bytes;
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function hmac(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, value));
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt, ikm);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const output: number[] = [];
  let previous = new Uint8Array();
  for (let counter = 1; output.length < length; counter++) {
    previous = new Uint8Array(await hmac(prk, concat(previous, info, new Uint8Array([counter]))));
    output.push(...previous);
  }
  return new Uint8Array(output.slice(0, length));
}

function publicJwk(publicKey: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("P-256 public key must be uncompressed");
  return {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicKey.slice(1, 33)),
    y: encodeBase64Url(publicKey.slice(33, 65)),
    ext: true
  };
}

async function importVapidKeys(config: VapidConfig): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicBytes: Uint8Array }> {
  const publicBytes = decodeBase64Url(config.publicKey, 65);
  const privateBytes = decodeBase64Url(config.privateKey, 32);
  const jwk = publicJwk(publicBytes);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, d: encodeBase64Url(privateBytes), key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const publicKey = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge)) {
    throw new Error("VAPID public/private keys do not match");
  }
  return { privateKey, publicKey, publicBytes };
}

function validateSubject(subject: string): string {
  const normalized = subject.includes(":") ? subject : `mailto:${subject}`;
  if (!normalized.startsWith("mailto:") && !normalized.startsWith("https://")) {
    throw new Error("VAPID subject must be a mailto or HTTPS URI");
  }
  return normalized;
}

export async function createVapidToken(config: VapidConfig, endpoint: string, now = Date.now()): Promise<string> {
  const { privateKey } = await importVapidKeys(config);
  const audience = new URL(endpoint).origin;
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: validateSubject(config.subject)
  })));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(signingInput)
  ));
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

export async function prepareWebPush(
  subscription: PushSubscriptionData,
  payload: string | Uint8Array,
  vapid: VapidConfig,
  options: { salt?: Uint8Array; now?: number; ttl?: number; urgency?: string } = {}
): Promise<PreparedWebPush> {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Push endpoint must use HTTPS");
  const recipientPublic = decodeBase64Url(subscription.keys.p256dh, 65);
  const authSecret = decodeBase64Url(subscription.keys.auth, 16);
  const recipientKey = await crypto.subtle.importKey("raw", recipientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey) as ArrayBuffer);
  // Cloudflare's generated declarations currently name this standard ECDH member differently;
  // workerd and the Web Crypto specification use `public` at runtime.
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: recipientKey } as any, ephemeral.privateKey, 256));

  const authPrk = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo = concat(encoder.encode("WebPush: info\0"), recipientPublic, senderPublic);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = options.salt ? new Uint8Array(options.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("Web Push salt must be 16 bytes");
  const prk = await hkdfExtract(salt, ikm);
  const contentKey = await hkdfExpand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plaintext = typeof payload === "string" ? encoder.encode(payload) : payload;
  const recordSizeValue = 4096;
  const maxRecordPayload = recordSizeValue - 17;
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const records: Uint8Array[] = [];
  for (let offset = 0; offset < plaintext.length || (plaintext.length === 0 && offset === 0); offset += maxRecordPayload) {
    const chunk = plaintext.slice(offset, offset + maxRecordPayload);
    const final = offset + chunk.length >= plaintext.length;
    const record = concat(chunk, new Uint8Array([final ? 2 : 1]));
    const recordNonce = new Uint8Array(nonce);
    let sequence = records.length;
    for (let index = recordNonce.length - 1; sequence > 0 && index >= 0; index--) {
      recordNonce[index] ^= sequence & 0xff;
      sequence = Math.floor(sequence / 256);
    }
    records.push(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: recordNonce }, aesKey, record)));
    if (final) break;
  }
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, recordSizeValue);
  const body = concat(salt, recordSize, new Uint8Array([senderPublic.length]), senderPublic, ...records);
  const vapidToken = await createVapidToken(vapid, subscription.endpoint, options.now);
  return {
    body,
    vapidToken,
    headers: {
      Authorization: `vapid t=${vapidToken}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttl ?? 86400),
      Urgency: options.urgency ?? "normal"
    }
  };
}

export async function sendWebPush(
  subscription: PushSubscriptionData,
  payload: unknown,
  vapid: VapidConfig,
  fetcher: typeof fetch = fetch
): Promise<PushResult> {
  const request = await prepareWebPush(subscription, JSON.stringify(payload), vapid);
  const response = await fetcher(subscription.endpoint, { method: "POST", headers: request.headers, body: request.body });
  return {
    ok: response.ok,
    status: response.status,
    expired: response.status === 404 || response.status === 410,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500
  };
}
