import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runBackup } from "./backup-runner.mjs";

const REDACT = /(mysql:\/\/[^\s]+|password\s*=\s*\S+|--password(?:=|\s+)\S+)/gi;
export const MODES = new Set(["inspect", "prepare-backup", "dry-run", "execute"]);
export function redact(value) { return String(value).replace(REDACT, "[REDACTED]"); }
export function assertMode(mode) { if (!MODES.has(mode)) throw new Error("Unsupported migration mode."); }
export function assertNoProductionWrite(mode, options = {}) {
  if (mode === "execute" && (!options.allowExecute || !options.approval)) throw new Error("Execute mode requires fresh explicit runtime approval.");
  if (mode !== "execute" && options.allowExecute) throw new Error("Only execute mode may permit production DDL.");
}
export function assertTargetUri(uri) {
  if (typeof uri !== "string" || !/^[-A-Za-z0-9_]+@[^/\s:]+:\d+\/defaultdb$/.test(uri)) throw new Error("Migration adapter requires an explicit non-secret user@host:port/defaultdb URI.");
  return uri;
}
function assertScriptPath(path, expectedName) {
  if (typeof path !== "string" || !path.replaceAll("\\", "/").endsWith(`/${expectedName}`)) throw new Error(`Unexpected ${expectedName} script path.`);
  return path;
}
export async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase(); }
export async function runChecked(run, command, args, { timeoutMs = 60_000, label }) {
  const result = await run(command, args, { timeoutMs, label });
  if (!result || result.timedOut || result.code !== 0) throw new Error(`${label} failed: ${redact(result?.stderr || result?.stdout || "nonzero exit")}`);
  return { stdout: redact(result.stdout || ""), stderr: redact(result.stderr || "") };
}
/** Builds concrete operations. `run` is injected so tests never start a process. */
export function createProductionAdapter({ run, mysqlsh, wrangler, targetUri, migrationPath, wrapperPath, driftPath, postverifyPath }) {
  if (!run || !mysqlsh || !wrangler) throw new Error("Adapter requires explicit tool paths and a subprocess runner.");
  assertTargetUri(targetUri); assertScriptPath(driftPath, "10-gate-drift-readonly.sql"); assertScriptPath(postverifyPath, "10-postverify-v0-v9.sql");
  const inspect = async () => {
    await runChecked(run, wrangler, ["deployments", "status", "--name", "dosebuddy"], { label: "Worker deployment inspection" });
    await runChecked(run, wrangler, ["hyperdrive", "get", "18124332f92a4a538050187dc00e8a84"], { label: "Hyperdrive inspection" });
    return runChecked(run, mysqlsh, ["--sql", "--uri", targetUri, "--ssl-mode=REQUIRED", "--file", driftPath], { label: "Read-only drift and identity inspection" });
  };
  return {
    async runMode(mode, options = {}) {
      assertMode(mode); assertNoProductionWrite(mode, options);
      if (mode === "dry-run") return { mode, productionWrites: false, inspected: false };
      if (mode === "inspect") return { mode, productionWrites: false, result: await inspect() };
      if (mode === "prepare-backup") {
        if (!options.allowBackup) throw new Error("Backup mode requires separate explicit backup authorization.");
        if (typeof options.backupRoot !== "string" || !options.backupRoot) throw new Error("Backup mode requires an explicit absolute backup root.");
        const backup = await runBackup({ root: options.backupRoot, mysqlsh, targetUri, run, now: options.now, runId: options.runId });
        return { mode, productionWrites: false, backup };
      }
      const wrapperHash = await sha256(wrapperPath);
      if (wrapperHash !== options.wrapperHash) throw new Error("Wrapper hash mismatch.");
      return { mode, productionWrites: true, result: await runChecked(run, mysqlsh, ["--sql", "--uri", targetUri, "--ssl-mode=REQUIRED", "--file", wrapperPath], { timeoutMs: 5 * 60_000, label: "Migration wrapper" }), postverify: await runChecked(run, mysqlsh, ["--sql", "--uri", targetUri, "--ssl-mode=REQUIRED", "--file", postverifyPath], { label: "Post-verification" }) };
    }, migrationPath
  };
}
