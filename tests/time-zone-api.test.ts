import test from "node:test";
import assert from "node:assert/strict";
import { canonicalTimeZone } from "../cloudflare-worker/scheduling.ts";

test("browser IANA zone is canonicalized", () => {
  assert.equal(canonicalTimeZone("US/Eastern"), "America/New_York");
});

test("missing and invalid zones are rejected rather than defaulted", () => {
  assert.equal(canonicalTimeZone(undefined), null);
  assert.equal(canonicalTimeZone("UTC+05:30"), null);
});
