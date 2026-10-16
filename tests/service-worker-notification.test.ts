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
