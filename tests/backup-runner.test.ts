import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dumpCommand, runBackup } from "../scripts/migration/backup-runner.mjs";

const fixedTime = () => new Date("2026-10-16T00:00:00.000Z");

test("backup command has explicit destination and documented consistency options", () => {
  const command = dumpCommand("C:\\safe path\\dump");
  assert.match(command, /util\.dumpSchemas/);
  assert.match(command, /consistent:true/);
  assert.match(command, /C:\\\\safe path\\\\dump/);
});

test("backup runner rejects zero exit when artifacts are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbb-"));
  try {
    await assert.rejects(() => runBackup({ root, mysqlsh: "mysqlsh", targetUri: "u@h:1/defaultdb", run: async () => ({ code: 0 }), now: fixedTime, runId: "missing" }), /metadata is missing/);
    assert.equal((await readdir(root)).some(name => name.endsWith(".complete.json")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup runner creates completion evidence only for verified run artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbb-"));
  try {
    const outcome = await runBackup({
      root, mysqlsh: "mysqlsh", targetUri: "u@h:1/defaultdb", now: fixedTime, runId: "valid",
      run: async (_command: string, args: string[], options: { destination?: string }) => {
        assert.ok(args.includes("--ssl-mode=REQUIRED"));
        assert.ok(options.destination?.startsWith(path.resolve(root)));
        await mkdir(options.destination!);
        await writeFile(path.join(options.destination!, "@.done.json"), "{}");
        await writeFile(path.join(options.destination!, "@.json"), "{}");
        await mkdir(path.join(options.destination!, "defaultdb"));
        await writeFile(path.join(options.destination!, "defaultdb", "medications.sql"), "CREATE TABLE medications(id INT)");
        return { code: 0 };
      }
    });
    const manifest = JSON.parse(await readFile(outcome.manifest, "utf8"));
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.destination, outcome.destination);
    assert.equal(outcome.inventory.length, 3);
    assert.ok(outcome.inventory.every((file: { sha256: string }) => file.sha256.length === 64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backup runner rejects empty or corrupt hidden metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dbb-"));
  try {
    for (const [runId, done, metadata] of [["empty", "", "{}"], ["corrupt", "{}", "not-json"]]) {
      await assert.rejects(() => runBackup({
        root, mysqlsh: "mysqlsh", targetUri: "u@h:1/defaultdb", now: fixedTime, runId,
        run: async (_command: string, _args: string[], options: { destination?: string }) => {
          await mkdir(options.destination!);
          await writeFile(path.join(options.destination!, "@.done.json"), done);
          await writeFile(path.join(options.destination!, "@.json"), metadata);
          return { code: 0 };
        }
      }), /empty|corrupt/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
