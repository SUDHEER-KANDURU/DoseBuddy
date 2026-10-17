import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Slice the pure resolveNotificationStatus out of app.js (same brace-matching
// pattern as frontend-subscription.test.ts) and run it in isolation. The resolver
// is DOM-free, so no sandbox globals are required.
async function loadResolver(): Promise<(arg: any) => { status: string; action: string }> {
  const source = await readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
  const sig = "function resolveNotificationStatus(";
  const start = source.indexOf(sig);
  assert.ok(start >= 0, "expected to find resolveNotificationStatus");
  // The parameter list destructures ({ ... } = {}), so the first "{" after the
  // signature is a param brace, not the body. Walk the parameter parens to depth 0
  // first, then take the next "{" as the function body's opening brace.
  let parenDepth = 0;
  let afterParams = -1;
  for (let i = start + sig.length - 1; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") { parenDepth--; if (parenDepth === 0) { afterParams = i + 1; break; } }
  }
  assert.ok(afterParams > 0, "could not find end of parameter list");
  const open = source.indexOf("{", afterParams);
  let depth = 0;
  let body = "";
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { body = source.slice(start, i + 1); break; } }
  }
  assert.ok(body, "unbalanced braces for resolveNotificationStatus");
  const factory = new Function(`${body}\nreturn resolveNotificationStatus;`);
  return factory();
}

// A fully-healthy server aggregate: one active subscription, last real dispatch SENT,
// no recent failures. Individual tests override fields to exercise each branch.
function aggregate(overrides: any = {}) {
  return {
    subscription: { exists: true, active: true, count: 1 },
    vapidConfigured: true,
    lastDispatch: { outcome: "SENT", eventType: "REMINDER", attemptedAt: "2026-01-01T08:00:00.000Z", providerStatus: 201 },
    lastTest: null,
    recentFailures: [],
    actionRequired: false,
    ...overrides
  };
}

test("UNSUPPORTED wins first when the browser lacks Notification/PushManager", async () => {
  const resolve = await loadResolver();
  const r = resolve({ permission: "granted", hasBrowserSub: true, serverAggregate: aggregate(), supported: false });
  assert.equal(r.status, "UNSUPPORTED");
  assert.equal(r.action, "SUPPORTED_BROWSERS");
});

test("DISABLED when preferences are off, even if granted + subscribed", async () => {
  const resolve = await loadResolver();
  const r = resolve({ permission: "granted", hasBrowserSub: true, serverAggregate: aggregate(), prefsEnabled: false });
  assert.equal(r.status, "DISABLED");
  assert.equal(r.action, "OPEN_PREFERENCES");
});

test("PERMISSION_DENIED when permission is denied", async () => {
  const resolve = await loadResolver();
  const r = resolve({ permission: "denied", hasBrowserSub: false, serverAggregate: aggregate() });
  assert.equal(r.status, "PERMISSION_DENIED");
  assert.equal(r.action, "UNBLOCK_STEPS");
});

test("PERMISSION_REQUIRED when permission is default", async () => {
  const resolve = await loadResolver();
  const r = resolve({ permission: "default", hasBrowserSub: false, serverAggregate: aggregate({ subscription: { exists: false, active: false, count: 0 }, lastDispatch: null }) });
  assert.equal(r.status, "PERMISSION_REQUIRED");
  assert.equal(r.action, "ENABLE");
});

test("SUBSCRIPTION_MISSING when granted but no browser sub and server count 0", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: false,
    serverAggregate: aggregate({ subscription: { exists: false, active: false, count: 0 }, lastDispatch: null })
  });
  assert.equal(r.status, "SUBSCRIPTION_MISSING");
  assert.equal(r.action, "ENABLE");
});

test("Finding-1: server says SENT but no browser sub -> not ACTIVE", async () => {
  const resolve = await loadResolver();
  // hasBrowserSub false with a server count of 0 -> SUBSCRIPTION_MISSING, never ACTIVE,
  // even though lastDispatch.outcome === 'SENT'.
  const r = resolve({
    permission: "granted",
    hasBrowserSub: false,
    serverAggregate: aggregate({ subscription: { exists: false, active: false, count: 0 } })
  });
  assert.notEqual(r.status, "ACTIVE");
  assert.equal(r.status, "SUBSCRIPTION_MISSING");
});

test("SUBSCRIPTION_NEEDS_RECOVERY when browser sub exists but server count 0", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({ subscription: { exists: false, active: false, count: 0 } })
  });
  assert.equal(r.status, "SUBSCRIPTION_NEEDS_RECOVERY");
  assert.equal(r.action, "RESUBSCRIBE");
});

test("SUBSCRIPTION_NEEDS_RECOVERY when lastDispatch outcome is EXPIRED", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({ lastDispatch: { outcome: "EXPIRED", eventType: "REMINDER", attemptedAt: "x", providerStatus: 410 } })
  });
  assert.equal(r.status, "SUBSCRIPTION_NEEDS_RECOVERY");
});

test("CONNECTION_UNAVAILABLE when the health fetch produced no aggregate", async () => {
  const resolve = await loadResolver();
  // hasBrowserSub true so the SUBSCRIPTION_MISSING branch (count 0) is skipped,
  // leaving a null aggregate to resolve to CONNECTION_UNAVAILABLE.
  const r = resolve({ permission: "granted", hasBrowserSub: true, serverAggregate: null });
  assert.equal(r.status, "CONNECTION_UNAVAILABLE");
  assert.equal(r.action, "RETRY");
});

test("DISPATCH_FAILED when lastDispatch outcome is FAILED", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({ lastDispatch: { outcome: "FAILED", eventType: "REMINDER", attemptedAt: "x", providerStatus: 400 } })
  });
  assert.equal(r.status, "DISPATCH_FAILED");
  assert.equal(r.action, "TEST_PUSH");
});

test("DISPATCH_UNCERTAIN when lastDispatch outcome is UNCERTAIN", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({ lastDispatch: { outcome: "UNCERTAIN", eventType: "REMINDER", attemptedAt: "x", providerStatus: null } })
  });
  assert.equal(r.status, "DISPATCH_UNCERTAIN");
  assert.equal(r.action, "TEST_PUSH");
});

test("DISPATCH_PENDING when lastDispatch outcome is CLAIMED or RETRY", async () => {
  const resolve = await loadResolver();
  for (const outcome of ["CLAIMED", "RETRY"]) {
    const r = resolve({
      permission: "granted",
      hasBrowserSub: true,
      serverAggregate: aggregate({ lastDispatch: { outcome, eventType: "REMINDER", attemptedAt: "x", providerStatus: null } })
    });
    assert.equal(r.status, "DISPATCH_PENDING", `outcome ${outcome}`);
    assert.equal(r.action, "NONE");
  }
});

test("PROVIDER_ACCEPTED when lastDispatch outcome is SENT (with live sub)", async () => {
  const resolve = await loadResolver();
  const r = resolve({ permission: "granted", hasBrowserSub: true, serverAggregate: aggregate() });
  assert.equal(r.status, "PROVIDER_ACCEPTED");
  assert.equal(r.action, "TEST_PUSH");
});

test("ACTIVE when granted + live sub + server count>=1 + no failures + no dispatch outcome", async () => {
  const resolve = await loadResolver();
  // lastDispatch null (no prior real reminder) with a live, server-known subscription.
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({ lastDispatch: null })
  });
  assert.equal(r.status, "ACTIVE");
  assert.equal(r.action, "TEST_PUSH");
});

test("a TEST attempt (lastTest) never flips the status away from ACTIVE", async () => {
  const resolve = await loadResolver();
  const r = resolve({
    permission: "granted",
    hasBrowserSub: true,
    serverAggregate: aggregate({
      lastDispatch: null,
      lastTest: { outcome: "FAILED", attemptedAt: "x", providerStatus: 400 }
    })
  });
  assert.equal(r.status, "ACTIVE", "a failed TEST must not drive the real-reminder status");
});
