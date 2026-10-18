/**
 * composeの定義の`image`と、環境変数の参照を、表と照らす。
 * 外れた形は2つに分ける。承認すれば通せる「違反」と、承認でも通さない「拒否」。
 * 違反は呼び出し側が使う(今は`plan`の判定を変えない)。拒否は`compose_forbidden`になる。
 * 純粋な関数で、ファイルにも外部コマンドにも触れない。
 */

import { createHash } from "node:crypto";
import {
  COMPOSE_SERVICE_ALLOWLIST,
  rawTextViolation,
} from "./compose_policy.ts";
import { MAX_BLOB_BYTES, MISE_ENV_KEYS } from "./constants.ts";
import { escapeDetail, isRecord } from "./stable.ts";

/** サービスごとの`image`のリポジトリ名。`null`は`build`だけで`image`を持たないサービス。 */
export const COMPOSE_IMAGE_TABLE: Readonly<Record<string, string | null>> = {
  db: "postgres",
  windmill_server: "ghcr.io/windmill-labs/windmill",
  windmill_worker: null,
  windmill_worker_native: "ghcr.io/windmill-labs/windmill",
  windmill_worker_console: "ghcr.io/windmill-labs/windmill",
  windmill_worker_periodic: "ghcr.io/windmill-labs/windmill",
  windmill_extra: "ghcr.io/windmill-labs/windmill-extra",
  caddy: "ghcr.io/windmill-labs/caddy-l4",
  console_fetcher: null,
  factory_state_init: "ghcr.io/windmill-labs/windmill",
};

/** 秘密値の変数ごとに、`environment`で受け取ってよいサービス。 */
export const COMPOSE_SECRET_TABLE: Readonly<Record<string, readonly string[]>> =
  {
    DB_PASSWORD: [
      "db",
      "windmill_server",
      "windmill_worker",
      "windmill_worker_native",
      "windmill_worker_console",
      "windmill_worker_periodic",
    ],
    CONSOLE_GITHUB_TOKEN: ["console_fetcher"],
  };

/**
 * `image`のタグの位置で使ってよい変数。値が版の形式(`/`、`:`、`@`を含まない)に限られるものだけ。
 * 値に`/`や`:`を入れられる変数は、レジストリの指定に化けるため入れない。
 */
export const TAG_VARIABLE_NAMES: readonly string[] = MISE_ENV_KEYS.filter(
  (name) => name.endsWith("_VERSION"),
);

export type ComposeViolation = {
  readonly kind: "image" | "secret";
  readonly service: string;
  /** サービスの最上位のキー。トップレベルの定義なら、そのキー。 */
  readonly field: string;
  /** 表示用。エスケープして切り詰めてある。 */
  readonly subject: string;
  /** 同じ違反かを比べる鍵。元の値のSHA-256を含む。表示しない。 */
  readonly id: string;
};

export type TablesResult =
  | { readonly ok: true; readonly violations: readonly ComposeViolation[] }
  | { readonly ok: false; readonly detail: string };

export type TableLimits = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  /** 走査した文字列とキーの合計のバイト数。 */
  readonly maxBytes: number;
};

const DEFAULT_LIMITS: TableLimits = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 8 * 1024 * 1024,
};

const SUBJECT_LIMIT = 120;
const TOP = "(top)";

/** 承認でも通さない形。`detail`はエスケープした固定の文を持つ。 */
class Rejection extends Error {
  constructor(detail: string) {
    super(escapeDetail(detail));
  }
}

function reject(detail: string): never {
  throw new Rejection(detail);
}

type Ref = {
  readonly name: string;
  /** 参照を含むスカラー全体。違反の鍵に使う。 */
  readonly scalar: string;
  /** 名前の側(マップのキー、`NAME=値`の`NAME`)にあるか。 */
  readonly inKey: boolean;
};

const REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 文書の走査。同じノードの結果は1回だけ求めて、別名で共有された先でも使い回す。 */
class Scanner {
  private nodes = 0;
  private bytes = 0;
  private readonly memo = new Map<object, readonly Ref[]>();
  private readonly active = new Set<object>();

  constructor(private readonly limits: TableLimits) {}

  /** コンテナ(配列かマップ)を1つ数える。深さと個数の上限を超えたら拒否する。 */
  touch(depth: number): void {
    if (depth > this.limits.maxDepth)
      reject("the compose file is nested too deep");
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      reject("the compose file has too many nodes");
    }
  }

  private count(text: string): void {
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > this.limits.maxBytes) {
      reject("the compose file has too much text");
    }
  }

  refsOfString(text: string, inKey: boolean): Ref[] {
    this.count(text);
    const refs: Ref[] = [];
    for (const match of text.matchAll(REFERENCE)) {
      refs.push({ name: match[1] ?? "", scalar: text, inKey });
    }
    return refs;
  }

  refsOf(value: unknown, depth: number): readonly Ref[] {
    if (typeof value === "string") return this.refsOfString(value, false);
    if (typeof value !== "object" || value === null) return [];
    const known = this.memo.get(value);
    if (known !== undefined) return known;
    if (this.active.has(value)) reject("the compose file refers to itself");
    this.touch(depth);
    this.active.add(value);
    const refs: Ref[] = [];
    if (Array.isArray(value)) {
      for (const item of value) refs.push(...this.refsOf(item, depth + 1));
    } else {
      for (const [key, item] of Object.entries(value)) {
        refs.push(...this.refsOfString(key, true));
        refs.push(...this.refsOf(item, depth + 1));
      }
    }
    this.active.delete(value);
    this.memo.set(value, refs);
    return refs;
  }

  /** `environment`の参照。名前の側と値の側を分け、値なしで環境から取る書き方も拾う。 */
  environmentRefs(value: unknown, depth: number): readonly Ref[] {
    if (typeof value !== "object" || value === null) {
      return this.refsOf(value, depth);
    }
    this.touch(depth);
    const refs: Ref[] = [];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string") {
          refs.push(...this.refsOf(item, depth + 1));
          continue;
        }
        const at = item.indexOf("=");
        const left = at === -1 ? item : item.slice(0, at);
        refs.push(
          ...this.refsOfString(left, true).map((ref) => ({
            ...ref,
            scalar: item,
          })),
        );
        if (at === -1) refs.push(...passThrough(left, this));
        else {
          refs.push(
            ...this.refsOfString(item.slice(at + 1), false).map((ref) => ({
              ...ref,
              scalar: item,
            })),
          );
        }
      }
      return refs;
    }
    for (const [key, item] of Object.entries(value)) {
      refs.push(...this.refsOfString(key, true));
      if (item === null) refs.push(...passThrough(key, this));
      else refs.push(...this.refsOf(item, depth + 1));
    }
    return refs;
  }

  /** `build.args`の、値なしで環境から取る書き方。 */
  buildArgRefs(build: unknown, depth: number): readonly Ref[] {
    if (!isRecord(build) || build.args === undefined) return [];
    const args = build.args;
    this.touch(depth);
    const refs: Ref[] = [];
    if (Array.isArray(args)) {
      for (const item of args) {
        if (typeof item === "string" && !item.includes("=")) {
          refs.push(...passThrough(item, this));
        }
      }
    } else if (isRecord(args)) {
      for (const [key, item] of Object.entries(args)) {
        if (item === null) refs.push(...passThrough(key, this));
      }
    }
    return refs;
  }
}

/**
 * 値なしの書き方(`NAME`だけ、または`NAME: null`)は、環境の同名の変数を渡す。
 * 前後の空白は除いて名前とみなす。名前の内側に空白があれば拒否する。
 */
function passThrough(raw: string, scanner: Scanner): Ref[] {
  const name = raw.trim();
  if (/\s/.test(name)) reject("an environment entry has a space in its name");
  if (!ENV_NAME.test(name)) return [];
  scanner.refsOfString(name, true);
  return [{ name, scalar: name, inKey: true }];
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function display(raw: string): string {
  if (raw.length <= SUBJECT_LIMIT) return escapeDetail(raw);
  return `${escapeDetail(raw.slice(0, 100))}...(${raw.length} chars)`;
}

function violation(
  kind: "image" | "secret",
  service: string,
  field: string,
  raw: string,
  material: string,
): ComposeViolation {
  return {
    kind,
    service,
    field,
    subject: display(raw),
    id: digest([kind, service, field, material]),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

const TAG_ATOM = `(?:[A-Za-z0-9_.-]|\\$\\{(?:${TAG_VARIABLE_NAMES.join("|")})(?::\\?[^}$/:]*)?\\})`;

function imageMatches(repository: string, image: string): boolean {
  return new RegExp(
    `^${escapeRegExp(repository)}(?::${TAG_ATOM}+)?(?:@sha256:[0-9a-f]{64})?$`,
  ).test(image);
}

function imageViolations(
  service: string,
  node: Record<string, unknown>,
): ComposeViolation[] {
  const expected = COMPOSE_IMAGE_TABLE[service];
  if (expected === undefined) reject(`service is not allowed: ${service}`);
  const out: ComposeViolation[] = [];
  const hasImage = Object.hasOwn(node, "image");
  const image = node.image;
  if (expected === null) {
    if (hasImage) {
      out.push(
        typeof image === "string"
          ? violation("image", service, "image", image, image)
          : violation(
              "image",
              service,
              "image",
              "(not a string)",
              "non-string",
            ),
      );
    }
    if (!Object.hasOwn(node, "build")) {
      out.push(violation("image", service, "build", "(no build)", "no build"));
    }
    return out;
  }
  if (!hasImage || image === undefined) {
    out.push(violation("image", service, "image", "(none)", "none"));
  } else if (typeof image !== "string") {
    out.push(
      violation("image", service, "image", "(not a string)", "non-string"),
    );
  } else if (!imageMatches(expected, image)) {
    if (image.includes("$")) {
      reject(`the image of ${service} has a variable outside the tag`);
    }
    out.push(violation("image", service, "image", image, image));
  }
  if (Object.hasOwn(node, "build")) {
    out.push(violation("image", service, "build", "build", "build"));
  }
  return out;
}

/** 参照が、そのまま通るか、違反か、拒否か。 */
function judge(
  ref: Ref,
  service: string,
  field: string,
): ComposeViolation | null {
  if (MISE_ENV_KEYS.includes(ref.name)) return null;
  const allowed = Object.hasOwn(COMPOSE_SECRET_TABLE, ref.name)
    ? COMPOSE_SECRET_TABLE[ref.name]
    : undefined;
  if (allowed !== undefined) {
    if (allowed.includes(service) && field === "environment" && !ref.inKey) {
      return null;
    }
    return violation("secret", service, field, ref.name, ref.scalar);
  }
  if (ref.name === "HOME" || ref.name === "PATH") {
    return violation("secret", service, field, ref.name, ref.scalar);
  }
  return reject(`variable ${ref.name.slice(0, 64)} is not allowed`);
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sorted(items: Map<string, ComposeViolation>): ComposeViolation[] {
  return [...items.values()].sort(
    (a, b) =>
      compare(a.service, b.service) ||
      compare(a.kind, b.kind) ||
      compare(a.field, b.field) ||
      compare(a.subject, b.subject) ||
      compare(a.id, b.id),
  );
}

function scan(parsed: unknown, limits: TableLimits): ComposeViolation[] {
  const scanner = new Scanner(limits);
  if (!isRecord(parsed)) reject("the document is not a map");
  scanner.touch(0);
  const services = parsed.services;
  if (!isRecord(services)) reject("services is not a map");
  scanner.touch(1);
  const found = new Map<string, ComposeViolation>();
  const add = (item: ComposeViolation | null) => {
    if (item !== null) found.set(item.id, item);
  };
  for (const [name, node] of Object.entries(services)) {
    if (!COMPOSE_SERVICE_ALLOWLIST.includes(name)) {
      reject(`service is not allowed: ${name}`);
    }
    if (!isRecord(node)) reject(`service ${name} is not a map`);
    scanner.touch(2);
    for (const item of imageViolations(name, node)) add(item);
    for (const [field, value] of Object.entries(node)) {
      const refs =
        field === "environment"
          ? scanner.environmentRefs(value, 3)
          : scanner.refsOf(value, 3);
      for (const ref of refs) add(judge(ref, name, field));
      if (field === "build") {
        for (const ref of scanner.buildArgRefs(value, 4)) {
          add(judge(ref, name, field));
        }
      }
    }
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "services") continue;
    for (const ref of scanner.refsOf(value, 1)) add(judge(ref, TOP, key));
  }
  return sorted(found);
}

/**
 * composeのテキストを、表と照らす。
 * 大きさの上限を超える、生のテキストの拒否の形(タグ、マージキー、`\r`など)がある、YAMLとして読めない、
 * `services`がマップでない、許可リストにないサービスがある、上限を超える、自分を参照している、
 * リポジトリ名の位置に変数がある、知らない変数名を参照している場合は、拒否を返す。
 * 検査の途中の想定外の例外は、拒否にせず投げ直す。
 */
export function checkComposeTablesText(
  text: string,
  limits: TableLimits = DEFAULT_LIMITS,
): TablesResult {
  if (Buffer.byteLength(text, "utf8") > MAX_BLOB_BYTES) {
    return { ok: false, detail: "the compose file is over the size limit" };
  }
  const rawDetail = rawTextViolation(text);
  if (rawDetail !== null) return { ok: false, detail: rawDetail };
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return { ok: false, detail: "the compose file is not valid YAML" };
  }
  try {
    return { ok: true, violations: scan(parsed, limits) };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, detail: error.message };
    throw error;
  }
}
