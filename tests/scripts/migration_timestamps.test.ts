// datatableのmigrationの版(ファイル名の先頭の数字)が、重ならず、upとdownで対になることを確かめる。
// 版が重なると、`wmill sync push`が配信を拒否し、自己更新が止まる。
import { describe, expect, test } from "bun:test";
import { listMigrations } from "../lib/migrationConventions.ts";

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

/** upとdownの片方にしか無い版と名前を、`<ファイル名>: <欠けている側>`で返す。 */
function unpairedMigrations(): string[] {
  const migrations = listMigrations();
  const idsOf = (direction: string) =>
    new Set(
      migrations
        .filter((migration) => migration.direction === direction)
        .map((migration) => `${migration.version}_${migration.name}`),
    );
  const ups = idsOf("up");
  const downs = idsOf("down");
  return migrations
    .filter((migration) => {
      const id = `${migration.version}_${migration.name}`;
      return migration.direction === "up" ? !downs.has(id) : !ups.has(id);
    })
    .map(
      (migration) =>
        `${migration.file}: the ${migration.direction === "up" ? "down" : "up"} migration is missing`,
    );
}

describe("datatable migrations", () => {
  test("every up migration has its own version", () => {
    expect(duplicatedVersions("up")).toEqual([]);
  });

  test("every down migration has its own version", () => {
    expect(duplicatedVersions("down")).toEqual([]);
  });

  test("every up migration and down migration of the same name are paired", () => {
    expect(unpairedMigrations()).toEqual([]);
  });
});
