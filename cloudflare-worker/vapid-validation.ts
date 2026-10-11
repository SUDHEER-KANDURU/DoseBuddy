const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

const encodeBase64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export async function isVapidKeyPairValid(publicKeyValue: string, privateKeyValue: string): Promise<boolean> {
  try {
    const raw = decodeBase64Url(publicKeyValue);
    if (raw.length !== 65 || raw[0] !== 4) return false;
    const jwk = {
      kty: "EC", crv: "P-256",
      x: encodeBase64Url(raw.slice(1, 33)),
      y: encodeBase64Url(raw.slice(33, 65)),
      d: privateKeyValue
    };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const challenge = new TextEncoder().encode("DoseBuddy VAPID key validation");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, challenge);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge);
  } catch {
    return false;
  }
}
