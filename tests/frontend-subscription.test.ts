import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function appSource(): Promise<string> {
  return readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
}

function sliceFn(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

interface Harness {
  ensurePushSubscription: () => Promise<void>;
  subscribeToPush: () => Promise<any>;
  getFlag: () => boolean;
  posts: Array<{ url: string; body: any }>;
  subscribeCalls: { count: number };
}

async function loadSubscription(opts: {
  permission?: string;
  existingSubscription?: boolean;
  subscribeRejects?: boolean;
  postOk?: boolean;
} = {}): Promise<Harness> {
  const source = await appSource();
  const subscribeToPush = sliceFn(source, "async function subscribeToPush(");
  const ensurePushSubscription = sliceFn(source, "async function ensurePushSubscription(");

  const posts: Array<{ url: string; body: any }> = [];
  const subscribeCalls = { count: 0 };
  let currentSub: any = opts.existingSubscription
    ? { toJSON: () => ({ endpoint: "https://push.example/1" }) }
    : null;

  const subObj = { toJSON: () => ({ endpoint: "https://push.example/new" }) };
  const pushManager = {
    getSubscription: async () => currentSub,
    subscribe: async () => {
      subscribeCalls.count++;
      if (opts.subscribeRejects) throw Object.assign(new Error("gesture required"), { name: "NotAllowedError" });
      currentSub = subObj;
      return subObj;
    }
  };

  const sandbox: any = {
    navigator: { serviceWorker: { ready: Promise.resolve({ pushManager }) } },
    window: {},
    Notification: { permission: opts.permission ?? "granted" },
    API_BASE: "https://api.example",
    currentUser: { id: 3 },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "UTC" }) }) },
    decodeVapidPublicKey: (_k: string) => new Uint8Array([1, 2, 3]),
    authFetch: async (url: string, init?: any) => {
      if (url.includes("/push/vapid-key")) {
        return { ok: true, json: async () => ({ publicKey: "BPUBLICKEY" }) };
      }
      if (url.includes("/push/subscribe")) {
        posts.push({ url, body: JSON.parse(init.body) });
        return opts.postOk === false
          ? { ok: false, status: 500, json: async () => ({ message: "fail" }) }
          : { ok: true, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    console: { log: () => {} }
  };

  // The functions reference PushManager / serviceWorker / Notification via `in` checks
  // on window/navigator.
  sandbox.window.PushManager = function () {};
  sandbox.window.Notification = sandbox.Notification;

  const factory = new Function(
    "navigator", "window", "Notification", "API_BASE", "currentUser", "Intl", "decodeVapidPublicKey", "authFetch", "console",
    `let hasActivePushSubscription = false;
     ${subscribeToPush}\n${ensurePushSubscription}
     return { subscribeToPush, ensurePushSubscription, getFlag: () => hasActivePushSubscription };`
  );
  const fns = factory(
    sandbox.navigator, sandbox.window, sandbox.Notification, sandbox.API_BASE, sandbox.currentUser,
    sandbox.Intl, sandbox.decodeVapidPublicKey, sandbox.authFetch, sandbox.console
  );
  return { ...fns, posts, subscribeCalls };
}

test("ensurePushSubscription subscribes once and POSTs {subscription, timeZone}", async () => {
  const h = await loadSubscription({ permission: "granted", existingSubscription: false });
  await h.ensurePushSubscription();
  assert.equal(h.posts.length, 1, "one POST to /push/subscribe");
  assert.ok(h.posts[0].url.includes("/push/subscribe"));
  assert.ok(h.posts[0].body.subscription, "body uses the exact `subscription` key");
  assert.equal(h.posts[0].body.timeZone, "UTC");
  assert.equal(h.getFlag(), true, "flag set true after successful subscribe");
});

test("ensurePushSubscription is idempotent when a subscription already exists (no POST)", async () => {
  const h = await loadSubscription({ permission: "granted", existingSubscription: true });
  await h.ensurePushSubscription();
  assert.equal(h.posts.length, 0, "existing subscription short-circuits — no re-POST");
  assert.equal(h.subscribeCalls.count, 0, "no new subscribe() call");
  assert.equal(h.getFlag(), true);
});

test("ensurePushSubscription returns early without permission (no subscribe)", async () => {
  const h = await loadSubscription({ permission: "default", existingSubscription: false });
  await h.ensurePushSubscription();
  assert.equal(h.posts.length, 0);
  assert.equal(h.subscribeCalls.count, 0);
  assert.equal(h.getFlag(), false);
});

test("a gesture-less subscribe() rejection is swallowed (no throw) and flag stays false", async () => {
  const h = await loadSubscription({ permission: "granted", existingSubscription: false, subscribeRejects: true });
  let threw = false;
  try { await h.ensurePushSubscription(); } catch { threw = true; }
  assert.equal(threw, false, "ensurePushSubscription must never throw");
  assert.equal(h.getFlag(), false, "flag stays false so the gesture fallback is surfaced");
  assert.equal(h.posts.length, 0, "no POST when subscribe failed");
});
