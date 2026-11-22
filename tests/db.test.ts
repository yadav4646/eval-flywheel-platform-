import { describe, expect, it } from "vitest";
import { assertReadOnly, runSql, tryRunSql, MAX_ROWS } from "../agent/db";

describe("read-only SQL guard", () => {
  it.each([
    "INSERT INTO customers VALUES (1)",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "SELECT 1; DROP TABLE orders",
    "PRAGMA table_info(orders)",
    "ATTACH DATABASE 'x.db' AS x",
    "WITH x AS (SELECT 1) DELETE FROM orders",
    "",
  ])("rejects %j", (sql) => {
    expect(() => assertReadOnly(sql)).toThrow();
  });
  it.each(["SELECT 1", "select count(*) from orders;", "WITH t AS (SELECT 1 AS a) SELECT a FROM t", "SELECT 'drop table; delete' AS s", "SELECT 1 -- ; drop table x"])(
    "allows %j",
    (sql) => {
      expect(() => assertReadOnly(sql)).not.toThrow();
    },
  );
  it("caps rows and reports truncation", () => {
    const r = runSql("SELECT id FROM order_items");
    expect(r.rowCount).toBe(MAX_ROWS);
    expect(r.truncated).toBe(true);
  });
  it("keeps duplicate column names (array rows)", () => {
    const r = runSql("SELECT 1 AS a, 2 AS a");
    expect(r.columns).toEqual(["a", "a"]);
    expect(r.rows[0]).toEqual([1, 2]);
  });
  it("tryRunSql returns errors instead of throwing", () => {
    expect(tryRunSql("SELECT nope FROM orders")).toHaveProperty("error");
  });
});
