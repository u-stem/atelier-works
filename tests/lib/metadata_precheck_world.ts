// メタデータの再計算の事前検査のテストで共有する、木とポートの組み立て。
import { createHash } from "node:crypto";
import { computeLockEntries } from "../../f/factory/lib/metadata_hash.ts";
import type { FileRead } from "../../f/factory/lib/metadata_patch_imports.ts";
import {
  type PlanResult,
  type PrecheckPorts,
  planMetadataRehash,
  type TreeEntry,
} from "../../f/factory/lib/metadata_precheck.ts";

export const BASE_TIP = "b".repeat(40);
export const HEAD = "a".repeat(40);

const encoder = new TextEncoder();

export function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

export const SCRIPT_YAML = [
  "summary: ''",
  "description: ''",
  "lock: '!inline f/factory/foo.script.lock'",
  "kind: script",
  "schema:",
  "  $schema: https://json-schema.org/draft/2020-12/schema",
  "  type: object",
  "  properties: {}",
  "  required: []",
  "",
].join("\n");

export const FOO = [
  'import { x } from "./lib/bar.ts";',
  'import * as wmill from "windmill-client@1.817.0";',
  "",
  "type Input = { a: string };",
  "",
  "export async function main(input: Input): Promise<string> {",
  "  return input.a + String(x) + typeof wmill;",
  "}",
  "",
].join("\n");

export const BAR = "export const x = 1;\n";

export type Files = Map<string, string | Uint8Array>;

/** `wmill-lock.yaml`の本文。キーはソートして並べる。 */
export function lockText(hashes: ReadonlyMap<string, string>): string {
  const lines = [...hashes.keys()]
    .sort()
    .map((key) => `  ${key}: ${hashes.get(key)}`);
  return `version: v2\nlocks:\n${lines.join("\n")}\n`;
}

/** scriptとflowのファイルから、その木に合った`wmill-lock.yaml`を作る。 */
export function withLock(files: Files): Files {
  const bytes = new Map<string, Uint8Array>(
    [...files].map(([path, content]) => [path, bytesOf(content)]),
  );
  const result = computeLockEntries(bytes);
  if (!result.ok) {
    throw new Error(`fixture is not hashable: ${result.reason}`);
  }
  return new Map(files).set("wmill-lock.yaml", lockText(result.entries));
}

/** baseの先端の木。`wmill-lock.yaml`は、この木のscriptから計算した値と一致する。 */
export function baseFiles(): Files {
  return withLock(
    new Map<string, string | Uint8Array>([
      ["wmill.yaml", "defaultTs: bun\n"],
      ["f/factory/foo.ts", FOO],
      ["f/factory/foo.script.yaml", SCRIPT_YAML],
      ["f/factory/foo.script.lock", "{}\n//bun.lock\n<empty>"],
      ["f/factory/lib/bar.ts", BAR],
      ["f/factory/lib/bar.script.yaml", SCRIPT_YAML],
      ["f/factory/lib/bar.script.lock", "{}\n//bun.lock\n<empty>"],
      ["f/factory/flow_a__flow/flow.yaml", "summary: a\n"],
      ["f/factory/flow_a__flow/flow.lock", "{}"],
      ["f/factory/job.schedule.yaml", "schedule: '0 0 * * * *'\n"],
      ["docs/readme.md", "# docs\n"],
    ]),
  );
}

export type World = {
  base: Files;
  head: Files;
  /** headの木の、パスごとのモード。無いパスは`100644`。 */
  headModes: Map<string, string>;
  baseModes: Map<string, string>;
  /** `ancestor`に渡す値。 */
  ancestor: boolean | null;
  /** ポートで`failed`にする`ref:path`。 */
  failedReads: Set<string>;
  /** `listTree`が投げるか。 */
  throwOnList: boolean;
  /** `size`を差し替えるheadのパス。 */
  headSizes: Map<string, number>;
  /** `readBlob`に渡された`ref`。 */
  readRefs: Set<string>;
};

/** headはbaseの先端を含み、libの`bar.ts`だけを変えた状態。`wmill-lock.yaml`は古いまま。 */
export function world(): World {
  const base = baseFiles();
  const head = new Map(base).set(
    "f/factory/lib/bar.ts",
    "export const x = 2;\n",
  );
  return {
    base,
    head,
    headModes: new Map(),
    baseModes: new Map(),
    ancestor: true,
    failedReads: new Set(),
    throwOnList: false,
    headSizes: new Map(),
    readRefs: new Set(),
  };
}

function entryOf(
  files: Files,
  modes: Map<string, string>,
  sizes: Map<string, number>,
): TreeEntry[] {
  return [...files].map(([path, content]) => {
    const bytes = bytesOf(content);
    return {
      path,
      mode: modes.get(path) ?? "100644",
      size: sizes.get(path) ?? bytes.byteLength,
      oid: createHash("sha1").update(bytes).digest("hex"),
    };
  });
}

export function portsOf(w: World): PrecheckPorts {
  return {
    listTree: async (ref) => {
      if (w.throwOnList) {
        throw new Error("boom");
      }
      return ref === HEAD
        ? entryOf(w.head, w.headModes, w.headSizes)
        : entryOf(w.base, w.baseModes, new Map());
    },
    readBlob: async (ref, path): Promise<FileRead> => {
      w.readRefs.add(ref);
      if (w.failedReads.has(`${ref}:${path}`)) {
        return { kind: "failed" };
      }
      const content = (ref === HEAD ? w.head : w.base).get(path);
      return content === undefined
        ? { kind: "missing" }
        : { kind: "found", content: bytesOf(content) };
    },
    isAncestor: async () => w.ancestor,
  };
}

export function plan(w: World): Promise<PlanResult> {
  return planMetadataRehash({ baseSha: BASE_TIP, headSha: HEAD }, portsOf(w));
}

/** 失敗の種別。成功なら`ok`。 */
export async function outcome(w: World): Promise<string> {
  const result = await plan(w);
  return result.ok ? "ok" : result.reason;
}
