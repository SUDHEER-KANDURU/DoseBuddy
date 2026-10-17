import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("service worker replaces the legacy missing favicon on background push", async () => {
  const handlers = new Map<string, (event: any) => void>();
  let shownOptions: any;
  const self = {
    location: { origin: "https://dosebuddy.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: { showNotification: async (_title: string, options: any) => { shownOptions = options; } },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: async () => {}
  };
  const source = await readFile(new URL("../DoseBuddy_frontend/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, console });

  let completion: Promise<unknown> | undefined;
  handlers.get("push")!({
    data: { json: () => ({ title: "DoseBuddy - Missed Dose", icon: "/favicon.ico", badge: "/favicon.ico" }) },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; }
  });
  await completion;

  assert.match(shownOptions.icon, /^data:image\/svg\+xml,/);
  assert.match(shownOptions.badge, /^data:image\/svg\+xml,/);
});

test("background push shows a notification with the canonical tag, independent of any open tab (case 10)", async () => {
  const handlers = new Map<string, (event: any) => void>();
  let shownTitle: string | undefined;
  let shownOptions: any;
  let matchAllConsulted = false;
  const self = {
    location: { origin: "https://dosebuddy.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: { showNotification: async (title: string, options: any) => { shownTitle = title; shownOptions = options; } },
    clients: { claim: async () => {}, matchAll: async () => { matchAllConsulted = true; return []; }, openWindow: async () => {} },
    skipWaiting: async () => {}
  };
  const source = await readFile(new URL("../DoseBuddy_frontend/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, console });

  let completion: Promise<unknown> | undefined;
  handlers.get("push")!({
    data: { json: () => ({ title: "DoseBuddy - Medication Reminder", body: "Time to take Medicine (5mg)", tag: "dose-3-2-2026-10-11-0800", data: { doseId: "REMINDER:3:2:7:2026-10-11:08:00" } }) },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; }
  });
  await completion;

  assert.equal(shownOptions.tag, "dose-3-2-2026-10-11-0800");
  assert.equal(shownTitle, "DoseBuddy - Medication Reminder");
  assert.equal(shownOptions.body, "Time to take Medicine (5mg)");
  assert.equal(matchAllConsulted, false, "push rendering must not depend on an open tab");
});

// ── Malformed / non-object payload hardening (FEAT-002, design §7 / §4.1) ────
// A harness that counts showNotification calls and lets a push event supply any
// json() implementation (including a throwing one) so we can prove the handler
// never renders a blank/garbage notification and never throws out of waitUntil.
async function loadPushHarness() {
  const handlers = new Map<string, (event: any) => void>();
  let showCount = 0;
  let shownTitle: string | undefined;
  let shownOptions: any;
  const self = {
    location: { origin: "https://dosebuddy.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: {
      showNotification: async (title: string, options: any) => {
        showCount++;
        shownTitle = title;
        shownOptions = options;
      }
    },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: async () => {}
  };
  const source = await readFile(new URL("../DoseBuddy_frontend/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, console, URL });

  async function firePush(json: () => unknown): Promise<void> {
    let completion: Promise<unknown> | undefined;
    handlers.get("push")!({
      data: { json },
      waitUntil: (promise: Promise<unknown>) => { completion = promise; }
    });
    if (completion) await completion;
  }

  return {
    firePush,
    getCount: () => showCount,
    getTitle: () => shownTitle,
    getOptions: () => shownOptions,
    handlers
  };
}

test("push handler renders nothing and does not throw when json() throws (case 7)", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => { throw new SyntaxError("not JSON"); });
  assert.equal(h.getCount(), 0, "a throwing payload must render zero notifications");
});

test("push handler renders nothing for a string payload", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => "just a string");
  assert.equal(h.getCount(), 0);
});

test("push handler renders nothing for a number payload", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => 42);
  assert.equal(h.getCount(), 0);
});

test("push handler renders nothing for an array payload", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => ["title", "body"]);
  assert.equal(h.getCount(), 0);
});

test("push handler renders nothing for a null payload", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => null);
  assert.equal(h.getCount(), 0);
});

test("push handler renders one coerced notification for a valid object with missing fields", async () => {
  const h = await loadPushHarness();
  await h.firePush(() => ({}));
  assert.equal(h.getCount(), 1, "a valid object renders exactly one notification");
  assert.equal(h.getTitle(), "DoseBuddy", "title coerces to the default");
  assert.equal(h.getOptions().body, "", "body coerces to empty string");
  assert.equal(h.getOptions().tag, "dosebuddy-push", "tag coerces to the default");
  // The {} default is created inside the vm realm, so deepStrictEqual's prototype
  // check fails cross-realm; assert it is an empty own-keyed object instead.
  assert.equal(typeof h.getOptions().data, "object", "data coerces to an object");
  assert.equal(Object.keys(h.getOptions().data).length, 0, "data coerces to an empty object");
  assert.match(h.getOptions().icon, /^data:image\/svg\+xml,/, "icon falls back to the bundled SVG");
  assert.match(h.getOptions().badge, /^data:image\/svg\+xml,/, "badge falls back to the bundled SVG");
});

test("notificationclick on a cross-origin data.url falls back to the app origin", async () => {
  const h = await loadPushHarness();
  let opened: string | undefined;
  // Re-build a self with a focus-less client list so the handler takes the openWindow path.
  const handlers = new Map<string, (event: any) => void>();
  const self = {
    location: { origin: "https://dosebuddy.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: { showNotification: async () => {} },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (url: string) => { opened = url; }
    },
    skipWaiting: async () => {}
  };
  const source = await readFile(new URL("../DoseBuddy_frontend/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, console, URL });

  let completion: Promise<unknown> | undefined;
  handlers.get("notificationclick")!({
    notification: { close: () => {}, data: { url: "https://evil.example/steal" } },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; }
  });
  await completion;

  assert.equal(opened, "https://dosebuddy.example", "a cross-origin url must fall back to the app origin");
});

test("notificationclick on a same-origin data.url uses that url", async () => {
  const handlers = new Map<string, (event: any) => void>();
  let opened: string | undefined;
  const self = {
    location: { origin: "https://dosebuddy.example" },
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: { showNotification: async () => {} },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (url: string) => { opened = url; }
    },
    skipWaiting: async () => {}
  };
  const source = await readFile(new URL("../DoseBuddy_frontend/sw.js", import.meta.url), "utf8");
  runInNewContext(source, { self, console, URL });

  let completion: Promise<unknown> | undefined;
  handlers.get("notificationclick")!({
    notification: { close: () => {}, data: { url: "https://dosebuddy.example/dashboard" } },
    waitUntil: (promise: Promise<unknown>) => { completion = promise; }
  });
  await completion;

  assert.equal(opened, "https://dosebuddy.example/dashboard", "a same-origin url is honored");
});
