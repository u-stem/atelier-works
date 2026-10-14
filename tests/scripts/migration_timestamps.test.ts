// datatableのmigrationの版(ファイル名の先頭の数字)が、重ならず、upとdownで対になることを確かめる。
// 版が重なると、`wmill sync push`が配信を拒否し、自己更新が止まる。
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const MIGRATIONS_DIR = "migrations/datatable/main";
const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.(up|down)\.sql$/;

type Migration = { version: string; name: string; direction: string };

function listMigrations(): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = MIGRATION_FILE.exec(file);
    if (match === null) continue;
    const [, version = "", name = "", direction = ""] = match;
    migrations.push({ version, name, direction });
  }
  return migrations;
}

function duplicatedVersions(direction: string): string[] {
  const seen = new Map<string, string[]>();
  for (const migration of listMigrations()) {
    if (migration.direction !== direction) continue;
    seen.set(migration.version, [
      ...(seen.get(migration.version) ?? []),
      migration.name,
    ]);
  }
  return [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([version, names]) => `${version}: ${names.join(", ")}`);
}

describe("datatable migrations", () => {
  test("every up migration has its own version", () => {
    expect(duplicatedVersions("up")).toEqual([]);
  });

  test("every down migration has its own version", () => {
    expect(duplicatedVersions("down")).toEqual([]);
  });

  test("every down migration has the up migration of the same name", () => {
    const ups = new Set(
      listMigrations()
        .filter((migration) => migration.direction === "up")
        .map((migration) => `${migration.version}_${migration.name}`),
    );
    const orphanDowns = listMigrations()
      .filter((migration) => migration.direction === "down")
      .map((migration) => `${migration.version}_${migration.name}`)
      .filter((id) => !ups.has(id));
    expect(orphanDowns).toEqual([]);
  });
});
