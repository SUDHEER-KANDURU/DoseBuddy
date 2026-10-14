/** Integration tests must never accept a production/Aiven URL. Keep this guard
 * centralized so adding another MySQL test cannot accidentally widen scope.
 */
export function disposableMysqlUrl(): string | undefined {
  const raw = process.env.DOSEBUDDY_TEST_MYSQL_URL;
  if (!raw) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("Refusing MySQL integration tests: test URL is invalid."); }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.protocol !== "mysql:" || parsed.hostname !== "127.0.0.1" || database !== "dosebuddy_test" || !parsed.username || !parsed.password) {
    throw new Error("Refusing MySQL integration tests: only credentialed mysql://127.0.0.1:PORT/dosebuddy_test is allowed.");
  }
  return raw;
}

/** Parse only after disposableMysqlUrl has enforced the loopback/schema allowlist. */
export function disposableMysqlConfig(): { host: "127.0.0.1"; port: number; user: string; password: string; database: "dosebuddy_test" } | undefined {
  const raw = disposableMysqlUrl();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  return {
    host: "127.0.0.1",
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: "dosebuddy_test"
  };
}
