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
