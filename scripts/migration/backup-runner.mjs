import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, rename, stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const isoName = (date) => date.toISOString().replace(/[:.]/g, "-");
const jsString = (value) => JSON.stringify(value);

/** Builds the documented MySQL Shell dump command with an explicit destination. */
export function dumpCommand(destination) {
  return `util.dumpSchemas([\"defaultdb\"], ${jsString(destination)}, {consistent:true,routines:true,triggers:true,events:true,threads:4})`;
}

async function filesBelow(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function verifyBackupArtifacts(destination) {
  const root = path.resolve(destination);
  const names = await filesBelow(root).catch(() => []);
  if (!names.includes("@.done.json") || !names.includes("@.json")) {
    throw new Error("Backup artifact validation failed: MySQL Shell metadata is missing.");
  }
  for (const metadata of ["@.json", "@.done.json"]) {
    try { JSON.parse(await readFile(path.join(root, metadata), "utf8")); }
    catch { throw new Error(`Backup artifact validation failed: ${metadata} is corrupt.`); }
  }
  const inventory = [];
  for (const name of names.sort()) {
    const file = path.join(root, name);
    const details = await stat(file);
    if (details.size === 0) throw new Error(`Backup artifact validation failed: ${name} is empty.`);
    inventory.push({ name: name.replaceAll("\\", "/"), size: details.size, sha256: await sha256(file) });
  }
  return inventory;
}

/**
 * Writes a completion manifest only after mysqlsh exits cleanly and the actual
 * dump directory contains non-empty, checksummed MySQL Shell metadata/files.
 */
export async function runBackup({ root, mysqlsh, targetUri, run, now = () => new Date(), runId = randomUUID() }) {
  if (!root || !mysqlsh || !targetUri || typeof run !== "function") throw new Error("Backup runner requires root, mysqlsh, target URI, and process runner.");
  const parent = path.resolve(root);
  await mkdir(parent, { recursive: true });
  const id = `dosebuddy-${isoName(now())}-${runId}`;
  const destination = path.join(parent, id);
  const runningManifest = path.join(parent, `${id}.running.json`);
  const base = { runId: id, destination, executable: mysqlsh, arguments: ["--js", "--uri", targetUri, "--ssl-mode=REQUIRED", "--execute", dumpCommand(destination)], startedAt: now().toISOString() };
  await writeFile(runningManifest, JSON.stringify(base, null, 2), { encoding: "utf8", flag: "wx" });
  let result;
  try {
    result = await run(mysqlsh, base.arguments, { timeoutMs: 30 * 60_000, label: "Consistent backup", destination });
    if (!result || result.timedOut || result.code !== 0) throw new Error("MySQL Shell backup process failed.");
    const inventory = await verifyBackupArtifacts(destination);
    const manifest = path.join(parent, `${id}.complete.json`);
    await writeFile(`${manifest}.tmp`, JSON.stringify({ ...base, endedAt: now().toISOString(), status: "complete", inventory }, null, 2), "utf8");
    await rename(`${manifest}.tmp`, manifest);
    return { runId: id, destination, manifest, inventory };
  } catch (error) {
    await writeFile(runningManifest, JSON.stringify({ ...base, endedAt: now().toISOString(), status: "failed", exitCode: result?.code ?? null }, null, 2), "utf8");
    throw error;
  }
}
