import test from "node:test";
import assert from "node:assert/strict";
import { disposableMysqlUrl } from "./integration/safe-db.ts";

test("MySQL integration URL fails closed outside the local disposable schema", () => {
  const original = process.env.DOSEBUDDY_TEST_MYSQL_URL;
  try {
    delete process.env.DOSEBUDDY_TEST_MYSQL_URL;
    assert.equal(disposableMysqlUrl(), undefined);
    for (const unsafe of [
      "mysql://user:secret@aiven.example/dosebuddy_test",
      "mysql://user:secret@127.0.0.1/dosebuddy",
      "mysql://user:secret@localhost/dosebuddy_test",
      "https://127.0.0.1/dosebuddy_test"
    ]) {
      process.env.DOSEBUDDY_TEST_MYSQL_URL = unsafe;
      assert.throws(() => disposableMysqlUrl(), /only credentialed mysql:\/\/127\.0\.0\.1/);
    }
    process.env.DOSEBUDDY_TEST_MYSQL_URL = "mysql://test:dummy@127.0.0.1:3306/dosebuddy_test";
    assert.equal(disposableMysqlUrl(), process.env.DOSEBUDDY_TEST_MYSQL_URL);
  } finally {
    if (original === undefined) delete process.env.DOSEBUDDY_TEST_MYSQL_URL;
    else process.env.DOSEBUDDY_TEST_MYSQL_URL = original;
  }
});
