// メタデータのパッチの検査のテストで共有する、実行・PR・木・ポートの組み立て。
import { createHash } from "node:crypto";
import type { FileRead } from "../../f/factory/lib/metadata_patch_imports.ts";
import {
  type PrFacts,
  type RunFacts,
  type VerifyConfig,
  type VerifyPorts,
  verifyMetadataPatch,
} from "../../f/factory/lib/metadata_patch_verify.ts";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const MERGE = "c".repeat(40);
export const BASE_TIP = "d".repeat(40);
export const HASH_OLD = "1".repeat(64);
export const HASH_NEW = "2".repeat(64);

/** 依存の無いlibのlockと同じ中身。baseの先端の木にある正規の空lockとして使う。 */
export const EMPTY_LOCK = '{\n  "dependencies": {}\n}\n//bun.lock\n<empty>';
/** 正規の空lockを置くbaseの木のパス。 */
export const EMPTY_LOCK_PATH =
  "f/factory/lib/metadata_patch_manifest.script.lock";
/** 依存を持つscriptのlock。 */
export const LOCK =
  '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n//bun.lock\n{"lockfileVersion": 2}';
/** 別の版のlock。 */
export const OTHER_LOCK =
  '{\n  "dependencies": {\n    "left-pad": "1.2.0"\n  }\n}\n//bun.lock\n{"lockfileVersion": 2}';

export const encoder = new TextEncoder();
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export const scriptYaml = (name: string, schemaType = "object") =>
  [
    `summary: ${name}`,
    "description: a script",
    `lock: '!inline f/factory/${name}.script.lock'`,
    "kind: script",
    "schema:",
    `  type: ${schemaType}`,
    "",
  ].join("\n");

export const wmillLock = (hashes: Record<string, string>) =>
  `version: v2\nlocks:\n${Object.entries(hashes)
    .map(([key, hash]) => `  ${key}: ${hash}`)
    .join("\n")}\n`;

export type World = {
  config: VerifyConfig;
  run: RunFacts;
  pr: PrFacts;
  head: Map<string, string | Uint8Array>;
  /** baseブランチの今の先端(`pr.baseSha`)の木。 */
  base: Map<string, string | Uint8Array>;
  /** パッチに載せるファイル。キーはリポジトリ相対のパス。 */
  patch: Map<string, string | Uint8Array>;
  statuses: Map<string, "added" | "modified">;
  /** 作ったmanifestを書き換える。 */
  tamperManifest: (manifest: Record<string, unknown>) => void;
  /** 作ったarchiveを書き換える。 */
  tamperArchive: (archive: Map<string, Uint8Array>) => void;
  isAncestor: (ancestor: string, descendant: string) => boolean | null;
  parents: readonly string[] | null;
  /** 読み取りに失敗するbaseのパス。 */
  baseFailures: Set<string>;
  /** baseの木の読み取りで渡されたref。 */
  baseReads: string[];
  /** 読み取りに失敗するheadのパス。 */
  headFailures: Set<string>;
  /** ポートの一部を差し替える。 */
  ports: Partial<VerifyPorts>;
};

/**
 * headはfoo.tsがlib/bar.tsをimportし、PRはfoo.tsとbar.tsを変えた状態。
 * fooのlockはheadの木でもパッチでも`LOCK`で、importはbaseの先端の木と同じ。パッチはfooのlock、yaml、ハッシュを運ぶ。
 */
export function world(): World {
  return {
    config: {
      repository: "acme/widgets",
      workflowPath: ".github/workflows/ci.yml",
    },
    run: {
      workflowPath: ".github/workflows/ci.yml",
      event: "pull_request",
      headRepositoryFullName: "acme/widgets",
      pullRequestNumbers: [42],
      headSha: HEAD,
      conclusion: "failure",
      metadataJobConclusion: "failure",
    },
    pr: {
      number: 42,
      headSha: HEAD,
      baseSha: BASE_TIP,
      diff: [
        { path: "f/factory/foo.ts", status: "modified" },
        { path: "f/factory/lib/bar.ts", status: "modified" },
      ],
      diffTruncated: false,
    },
    head: new Map<string, string | Uint8Array>([
      ["f/factory/foo.ts", 'import { x } from "./lib/bar.ts";\n'],
      ["f/factory/lib/bar.ts", "export const x = 2;\n"],
      ["f/factory/other.ts", "export const y = 1;\n"],
      ["f/factory/foo.script.lock", LOCK],
      ["f/factory/foo.script.yaml", scriptYaml("foo")],
      [
        "wmill-lock.yaml",
        wmillLock({ "f/factory/foo": HASH_OLD, "f/factory/other": HASH_OLD }),
      ],
    ]),
    base: new Map<string, string | Uint8Array>([
      ["f/factory/foo.ts", 'import { x } from "./lib/bar.ts";\n'],
      ["f/factory/lib/bar.ts", "export const x = 1;\n"],
      ["f/factory/foo.script.lock", LOCK],
      [EMPTY_LOCK_PATH, EMPTY_LOCK],
    ]),
    patch: new Map<string, string | Uint8Array>([
      ["f/factory/foo.script.lock", LOCK],
      ["f/factory/foo.script.yaml", scriptYaml("foo", "string")],
      [
        "wmill-lock.yaml",
        wmillLock({ "f/factory/foo": HASH_NEW, "f/factory/other": HASH_OLD }),
      ],
    ]),
    statuses: new Map(),
    tamperManifest: () => {},
    tamperArchive: () => {},
    isAncestor: () => true,
    parents: [BASE, HEAD],
    baseFailures: new Set(),
    baseReads: [],
    headFailures: new Set(),
    ports: {},
  };
}

/** baseとheadの両方に、同じlockを持つ既存のscriptを足す。 */
export function addExistingScript(
  w: World,
  name: string,
  source: string,
): void {
  w.head.set(`f/factory/${name}.ts`, source);
  w.base.set(`f/factory/${name}.ts`, source);
  w.head.set(`f/factory/${name}.script.lock`, LOCK);
  w.base.set(`f/factory/${name}.script.lock`, LOCK);
}

export const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? encoder.encode(value) : value;

export function build(w: World) {
  const archive = new Map<string, Uint8Array>();
  const entries: Record<string, unknown>[] = [];
  for (const [path, value] of [...w.patch].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const content = bytes(value);
    archive.set(`files/${path}`, content);
    entries.push({
      path,
      status: w.statuses.get(path) ?? "modified",
      sha256: sha256(content),
      size: content.byteLength,
    });
  }
  const manifest: Record<string, unknown> = {
    version: 1,
    headSha: HEAD,
    baseSha: BASE,
    mergeSha: MERGE,
    entries,
  };
  w.tamperManifest(manifest);
  archive.set("manifest.json", encoder.encode(JSON.stringify(manifest)));
  w.tamperArchive(archive);
  const ports: VerifyPorts = {
    isAncestor: async (a, d) => w.isAncestor(a, d),
    readCommitParents: async () => w.parents,
    listHeadSources: async () =>
      [...w.head.keys()].filter((path) => path.endsWith(".ts")),
    readHeadFile: async (path): Promise<FileRead> => {
      if (w.headFailures.has(path)) {
        return { kind: "failed" };
      }
      const value = w.head.get(path);
      return value === undefined
        ? { kind: "missing" }
        : { kind: "found", content: bytes(value) };
    },
    readBaseFile: async (ref, path): Promise<FileRead> => {
      w.baseReads.push(ref);
      if (w.baseFailures.has(path)) {
        return { kind: "failed" };
      }
      const value = w.base.get(path);
      return value === undefined
        ? { kind: "missing" }
        : { kind: "found", content: bytes(value) };
    },
    ...w.ports,
  };
  return { input: { config: w.config, run: w.run, pr: w.pr, archive }, ports };
}

export async function verify(w: World) {
  const { input, ports } = build(w);
  return verifyMetadataPatch(input, ports);
}

export async function codeOf(w: World): Promise<string> {
  const result = await verify(w);
  return result.ok ? "ok" : result.code;
}
