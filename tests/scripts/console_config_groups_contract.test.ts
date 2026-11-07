// 設定タブのグループ分けが、リソースタイプの全項目を覆うことを確かめる。
// 新しい項目が足されたとき、グループの分類を決めるよう、ここで落とす。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_GROUP_DEFINITIONS } from "../../console/src/lib/configGroups.ts";

const RESOURCE_TYPE = join(
  import.meta.dir,
  "../../c_factory_config.resource-type.yaml",
);

/** リソースタイプの`properties`の直下のキー。入れ子の`properties`は数えない。 */
function declaredKeys(): string[] {
  const keys: string[] = [];
  let inProperties = false;
  for (const line of readFileSync(RESOURCE_TYPE, "utf8").split("\n")) {
    if (line === "  properties:") {
      inProperties = true;
      continue;
    }
    if (!inProperties) continue;
    if (line === "  required:") break;
    const match = /^ {4}([A-Za-z0-9_]+):$/.exec(line);
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

const GROUPED = CONFIG_GROUP_DEFINITIONS.flatMap((group) => group.keys);

describe("the groups of the config tab", () => {
  test("reads the keys of the resource type", () => {
    expect(declaredKeys().length).toBeGreaterThan(50);
  });

  test("hold every key of the resource type", () => {
    expect(declaredKeys().filter((key) => !GROUPED.includes(key))).toEqual([]);
  });

  test("hold every key of the resource type in exactly one group", () => {
    const counts = declaredKeys().map(
      (key) => GROUPED.filter((grouped) => grouped === key).length,
    );
    expect(counts.filter((count) => count !== 1)).toEqual([]);
  });

  test("hold no key that the resource type does not declare", () => {
    expect(GROUPED.filter((key) => !declaredKeys().includes(key))).toEqual([]);
  });
});
