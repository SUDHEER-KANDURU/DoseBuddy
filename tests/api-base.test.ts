import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveApiBase, DEFAULT_API_BASE, DEFAULT_BACKEND_ORIGIN } from "../DoseBuddy_frontend/api-base.js";

const authPaths = [
  "/auth/login",
  "/auth/signup",
  "/auth/refresh",
  "/auth/verify-email",
  "/auth/resend-otp",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/user/profile/1",
  "/user/time-zone",
  "/user/change-password/1"
];

test("resolveApiBase defaults to verified backend worker dosebuddy.dosebuddy-health.workers.dev/api", () => {
  assert.equal(resolveApiBase(undefined), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({}), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ apiBase: "" }), DEFAULT_API_BASE);
  assert.equal(DEFAULT_API_BASE, "https://dosebuddy.dosebuddy-health.workers.dev/api");
});

test("resolveApiBase honors explicit apiBase override and trims trailing slashes", () => {
  assert.equal(resolveApiBase({ apiBase: "https://custom.backend/api" }), "https://custom.backend/api");
  assert.equal(resolveApiBase({ apiBase: "https://custom.backend/api/" }), "https://custom.backend/api");
  assert.equal(resolveApiBase({ apiBase: "/api" }), "/api");
  assert.equal(resolveApiBase({ apiBase: "/api/" }), "/api");
});

test("resolveApiBase builds apiBase from apiBaseUrl when apiBase is absent", () => {
  assert.equal(resolveApiBase({ apiBaseUrl: "https://custom.backend" }), "https://custom.backend/api");
  assert.equal(resolveApiBase({ apiBaseUrl: "https://custom.backend/" }), "https://custom.backend/api");
  assert.equal(
    resolveApiBase({ apiBaseUrl: DEFAULT_BACKEND_ORIGIN }),
    DEFAULT_API_BASE
  );
});

test("auth request URLs target backend worker and never obsolete host or static frontend worker", () => {
  const configsToTest = [
    undefined,
    {},
    {
      apiBaseUrl: "https://dosebuddy.dosebuddy-health.workers.dev",
      apiBase: "https://dosebuddy.dosebuddy-health.workers.dev/api"
    }
  ];

  for (const cfg of configsToTest) {
    const base = resolveApiBase(cfg);
    for (const path of authPaths) {
      const url = `${base}${path}`;

      // Must never target obsolete host
      assert.equal(url.includes("sudheerkanduru-5588"), false, `obsolete host leaked into ${url}`);

      // Must never target the static-only frontend worker for API routes
      assert.equal(
        url.includes("dosebuddy-frontend.dosebuddy-health.workers.dev"),
        false,
        `static frontend worker host used for API route ${url}`
      );

      // Must target the active backend worker
      assert.ok(
        url.startsWith("https://dosebuddy.dosebuddy-health.workers.dev/api/"),
        `expected backend worker API route, got ${url}`
      );
    }
  }
});

test("app.js and index.html contain no obsolete host and configure backend worker", async () => {
  const app = await readFile(new URL("../DoseBuddy_frontend/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../DoseBuddy_frontend/index.html", import.meta.url), "utf8");

  for (const [filename, src] of [["app.js", app], ["index.html", html]]) {
    assert.equal(
      src.includes("sudheerkanduru-5588"),
      false,
      `obsolete host still present in ${filename}`
    );
  }

  // index.html must configure the backend worker and not the frontend worker for API
  assert.ok(
    html.includes("https://dosebuddy.dosebuddy-health.workers.dev"),
    "index.html must reference backend worker dosebuddy.dosebuddy-health.workers.dev"
  );
  assert.equal(
    /apiBaseUrl:\s*["']https:\/\/dosebuddy-frontend/i.test(html),
    false,
    "index.html must not set apiBaseUrl to frontend worker"
  );

  // app.js must wire the centralized helper
  assert.ok(app.includes("resolveApiBase"), "app.js must import and call resolveApiBase");
});
