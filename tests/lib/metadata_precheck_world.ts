// メタデータの再計算の事前検査のテストで共有する、木とポートの組み立て。
import { createHash } from "node:crypto";
import { computeLockEntries } from "../../f/factory/lib/metadata_hash.ts";
import type { FileRead } from "../../f/factory/lib/metadata_patch_imports.ts";
import {
  type PlanLimits,
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
  /** 木にあるのに`missing`を返す`ref:path`。 */
  missingReads: Set<string>;
  /** 読み取りで例外を投げる`ref:path`。 */
  throwingReads: Set<string>;
  /** 読み取りで、`byteLength`が例外を投げる内容を返す`ref:path`。 */
  brokenReads: Set<string>;
  /** 想定外の形の値を返す`ref:path`。値は、`readBlob`の戻り値の型に合わない。 */
  malformedReads: Map<string, string>;
  /** `listTree`が投げるか。 */
  throwOnList: boolean;
  /** `isAncestor`が投げるか。 */
  throwOnAncestor: boolean;
  /** `size`を差し替えるパス。 */
  headSizes: Map<string, number>;
  baseSizes: Map<string, number>;
  /** 木の項目を差し替えるheadのパス。 */
  headEntryEdits: Map<string, Partial<TreeEntry>>;
  /** `readBlob`に渡された`ref`。 */
  readRefs: Set<string>;
  /** `readBlob`が呼ばれた回数。 */
  readCount: number;
  /**
   * 真のとき、`plan`の前に、baseの木から計算した`wmill-lock.yaml`をbaseの木に置く。
   * テストがbaseの`.ts`を変えても、baseのメタデータが最新である前提を保つため。
   * テストがbaseの`wmill-lock.yaml`を自分で書き換えたときは、何もしない。
   */
  settle: boolean;
  /** `world()`が作ったときの、`wmill-lock.yaml`の本文。 */
  originalLock: string;
  /** `planMetadataRehash`に渡す自己検査。省略したときは本物を使う。 */
  selfCheck: (() => boolean) | undefined;
  /** 真のとき、木の`oid`をSHA-256で作る(SHA-256のリポジトリ)。 */
  sha256Oids: boolean;
  /** `planMetadataRehash`に渡す入力。 */
  input: { baseSha: string; headSha: string };
  limits: PlanLimits | undefined;
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
    missingReads: new Set(),
    throwingReads: new Set(),
    brokenReads: new Set(),
    malformedReads: new Map(),
    throwOnList: false,
    throwOnAncestor: false,
    headSizes: new Map(),
    baseSizes: new Map(),
    headEntryEdits: new Map(),
    readRefs: new Set(),
    readCount: 0,
    settle: true,
    sha256Oids: false,
    selfCheck: undefined,
    originalLock: String(base.get("wmill-lock.yaml")),
    input: { baseSha: BASE_TIP, headSha: HEAD },
    limits: undefined,
  };
}

/** blobのoid。`blob <長さ>\0`の接頭辞を付けた内容のハッシュである。 */
export function blobOid(
  bytes: Uint8Array,
  algorithm: "sha1" | "sha256",
): string {
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function entryOf(
  files: Files,
  modes: Map<string, string>,
  sizes: Map<string, number>,
  edits: Map<string, Partial<TreeEntry>>,
  algorithm: "sha1" | "sha256",
): TreeEntry[] {
  return [...files].map(([path, content]) => {
    const bytes = bytesOf(content);
    return {
      path,
      mode: modes.get(path) ?? "100644",
      size: sizes.get(path) ?? bytes.byteLength,
      oid: blobOid(bytes, algorithm),
      ...edits.get(path),
    };
  });
}

/** `byteLength`を読むと例外を投げる内容。ポートが想定外の値を返したときの再現に使う。 */
class BrokenBytes extends Uint8Array {
  override get byteLength(): number {
    throw new Error("broken");
  }
}

export function portsOf(w: World): PrecheckPorts {
  return {
    listTree: async (ref) => {
      if (w.throwOnList) {
        throw new Error("boom");
      }
      return ref === HEAD
        ? entryOf(
            w.head,
            w.headModes,
            w.headSizes,
            w.headEntryEdits,
            w.sha256Oids ? "sha256" : "sha1",
          )
        : entryOf(
            w.base,
            w.baseModes,
            w.baseSizes,
            new Map(),
            w.sha256Oids ? "sha256" : "sha1",
          );
    },
    readBlob: async (ref, path): Promise<FileRead> => {
      w.readRefs.add(ref);
      w.readCount += 1;
      const key = `${ref}:${path}`;
      if (w.throwingReads.has(key)) {
        throw new Error("boom");
      }
      if (w.failedReads.has(key)) {
        return { kind: "failed" };
      }
      if (w.missingReads.has(key)) {
        return { kind: "missing" };
      }
      const malformed = w.malformedReads.get(key);
      if (malformed !== undefined) {
        return JSON.parse(malformed);
      }
      if (w.brokenReads.has(key)) {
        return { kind: "found", content: new BrokenBytes(4) };
      }
      const content = (ref === HEAD ? w.head : w.base).get(path);
      return content === undefined
        ? { kind: "missing" }
        : { kind: "found", content: bytesOf(content) };
    },
    isAncestor: async () => {
      if (w.throwOnAncestor) {
        throw new Error("boom");
      }
      return w.ancestor;
    },
  };
}

/** baseの木のメタデータを、baseの木の内容に合わせる。headのlockがbaseのlockと同じだったときは、headにも置く。 */
function settleBase(w: World): void {
  if (!w.settle || String(w.base.get("wmill-lock.yaml")) !== w.originalLock) {
    return;
  }
  const computed = computeLockEntries(
    new Map(
      [...w.base].map(([path, content]) => [path, bytesOf(content)] as const),
    ),
  );
  if (!computed.ok) {
    return;
  }
  const text = lockText(computed.entries);
  if (String(w.head.get("wmill-lock.yaml")) === w.originalLock) {
    w.head.set("wmill-lock.yaml", text);
  }
  w.base.set("wmill-lock.yaml", text);
}

export function plan(w: World): Promise<PlanResult> {
  settleBase(w);
  return planMetadataRehash(w.input, portsOf(w), w.limits, w.selfCheck);
}

/** 失敗の種別。成功なら`ok`。 */
export async function outcome(w: World): Promise<string> {
  const result = await plan(w);
  return result.ok ? "ok" : result.reason;
}
