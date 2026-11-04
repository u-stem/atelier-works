import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePgConnection } from "../../f/factory/lib/backup_support.ts";
import { yamlOf } from "./worker_boundary_scan.ts";

const BOOTSTRAP = resolve(import.meta.dir, "../../scripts/bootstrap.sh");
const VARIABLE = "f/factory/db_backup_url.variable.yaml";
const BASH = Bun.which("bash") ?? "bash";

// bootstrap.shは読み込むだけで実行が始まるので、関数の定義だけを取り出して実行する。
function extractFunction(name: string): string {
  const source = readFileSync(BOOTSTRAP, "utf8");
  const match = new RegExp(
    `^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`,
    "m",
  ).exec(source);
  if (match === null) {
    throw new Error(`function not found: ${name}`);
  }
  return match[0];
}

function run(password: string): { stdout: string; status: number } {
  const script = `${extractFunction("db_backup_url")}\ndb_backup_url\n`;
  const result = Bun.spawnSync([BASH, "-c", script], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      DB_PASSWORD: password,
    },
  });
  return { stdout: result.stdout.toString(), status: result.exitCode };
}

describe("f/factory/db_backup_url", () => {
  test("is a secret variable", async () => {
    expect((await yamlOf(VARIABLE)).is_secret).toBe(true);
  });

  test("holds no value in the repository", async () => {
    expect((await yamlOf(VARIABLE)).value).toBe("");
  });
});

describe("db_backup_url in bootstrap.sh", () => {
  test("builds the superuser URL of the compose Postgres", () => {
    expect(run("s3cret").stdout).toBe("postgres://postgres:s3cret@db/postgres");
  });

  test("percent-encodes the characters that would break the URL", () => {
    expect(run("p@ss:w/rd").stdout).toBe(
      "postgres://postgres:p%40ss%3Aw%2Frd@db/postgres",
    );
  });

  test("gives the backup the same password back", () => {
    expect(parsePgConnection(run("p@ss:w/rd %").stdout)?.password).toBe(
      "p@ss:w/rd %",
    );
  });

  test("exits with 0", () => {
    expect(run("s3cret").status).toBe(0);
  });

  test("exits non-zero when DB_PASSWORD is empty", () => {
    expect(run("").status).not.toBe(0);
  });

  test("prints no URL when DB_PASSWORD is empty", () => {
    expect(run("").stdout).toBe("");
  });

  test("stores the URL in f/factory/db_backup_url", () => {
    expect(readFileSync(BOOTSTRAP, "utf8")).toContain(
      'upsert_variable "f/factory/db_backup_url" "${db_backup_url_value}"',
    );
  });
});
