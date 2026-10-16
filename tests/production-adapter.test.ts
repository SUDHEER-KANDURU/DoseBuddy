import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProductionAdapter, assertMode, assertNoProductionWrite, redact } from "../scripts/migration/production-adapter.mjs";

const adapterArgs = (run: any) => ({
  run, mysqlsh: "mysqlsh", wrangler: "wrangler",
  targetUri: "avnadmin@example.test:23079/defaultdb", migrationPath: "x", wrapperPath: "x",
  driftPath: "C:/x/10-gate-drift-readonly.sql", postverifyPath: "C:/x/10-postverify-v0-v9.sql"
});

test("adapter fails closed for unsupported modes and execute without approval", () => {
  assert.throws(() => assertMode("oops"));
  assert.throws(() => assertNoProductionWrite("execute", {}));
  assert.throws(() => assertNoProductionWrite("inspect", { allowExecute: true }));
  assert.equal(redact("mysql://u:p@host password=abc"), "[REDACTED] [REDACTED]");
});

test("dry-run cannot invoke a subprocess", async () => {
  let calls = 0;
  const adapter = createProductionAdapter(adapterArgs(async () => { calls++; return { code: 0 }; }));
  const result = await adapter.runMode("dry-run");
  assert.equal(result.productionWrites, false);
  assert.equal(calls, 0);
});

test("inspection uses explicit URI and subprocess failure remains non-writing", async () => {
  const calls: string[][] = [];
  const adapter = createProductionAdapter(adapterArgs(async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 1, stderr: "password=secret" };
  }));
  await assert.rejects(() => adapter.runMode("inspect"), /\[REDACTED\]/);
  assert.deepEqual(calls[0], ["deployments", "status", "--name", "dosebuddy"]);
});

test("adapter rejects missing URI and unreviewed scripts", () => {
  assert.throws(() => createProductionAdapter({ ...adapterArgs(async () => ({ code: 0 })), targetUri: "" }));
  assert.throws(() => createProductionAdapter({ ...adapterArgs(async () => ({ code: 0 })), driftPath: "C:/x/evil.sql" }));
});

test("backup mode requires separate authorization and verified artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbb-adapter-"));
  try {
    let calls = 0;
    const adapter = createProductionAdapter(adapterArgs(async (_command: string, _args: string[], options: { destination: string }) => {
      calls++;
      await mkdir(options.destination);
      await writeFile(path.join(options.destination, "@.done.json"), "{}");
      await writeFile(path.join(options.destination, "@.json"), "{}");
      return { code: 0 };
    }));
    await assert.rejects(() => adapter.runMode("prepare-backup"), /authorization/);
    assert.equal(calls, 0);
    const result = await adapter.runMode("prepare-backup", { allowBackup: true, backupRoot: root, runId: "test", now: () => new Date(0) });
    assert.equal(result.backup.inventory.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
