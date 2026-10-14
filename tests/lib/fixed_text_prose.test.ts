import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkProse,
  type ProseRules,
} from "../../f/factory/lib/prose_check.ts";

// コードに直書きした定型文(Discordの通知、通知の理由、Consoleのnotice、Issueへのコメント)も、
// `docs/writing-guidelines.md`の規則に従わせる。ここでは英字と日本語の間のスペースを、
// `f/factory`の文字列リテラルから機械的に探す。

const SPACE_RULES: ProseRules = {
  register: null,
  maxLineChars: null,
  forbidBold: false,
  forbidHistory: false,
  forbidAsciiJapaneseSpace: true,
};

/**
 * 検査しないファイル。プロンプトは英語の文で、守らせたい書き方の悪い例(「3 件」)を
 * わざと含むため。
 */
const EXCLUDED_FILES = new Set(["f/factory/lib/prompts.ts"]);

/**
 * 検査しない行。役割タグは投稿の1行目を見分ける固定の文字列で、
 * 既に投稿したコメントとの照合に使うため変えられない。
 * 英語の文の中で画面の項目名を引く行と、文体の指示で「です・ます」「だ・である」を引く行は、
 * 英語の語の区切りとしてスペースが要る。文体の指示は`commit_message_style.test.ts`が文面を固定する。
 */
const EXCLUDED_LINE_PATTERN =
  /自動レビュー\]|自動返信\]|今すぐ監査 in the Console|polite です・ます form|plain だ・である form/;

const STRING_LITERAL_PATTERN =
  /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g;

/**
 * リポジトリのルート。テストを実行するカレントディレクトリに頼らず、このファイルの場所から決める。
 * カレントディレクトリが違うと1件も走査せずに通ってしまうため。
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

type ScanResult = {
  /** 走査したファイルの数。 */
  readonly scanned: number;
  /** 規則に反する文字列リテラル。`path:line: 中身`の形。 */
  readonly violations: readonly string[];
};

/** 1行に収まる文字列リテラルの中身のうち、規則に反するものを探す。 */
async function findViolations(): Promise<ScanResult> {
  const found: string[] = [];
  let scanned = 0;
  const glob = new Bun.Glob("f/factory/**/*.ts");
  for await (const path of glob.scan({ cwd: REPO_ROOT })) {
    if (EXCLUDED_FILES.has(path)) continue;
    scanned += 1;
    const lines = (await Bun.file(join(REPO_ROOT, path)).text()).split("\n");
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (EXCLUDED_LINE_PATTERN.test(line)) return;
      for (const literal of line.match(STRING_LITERAL_PATTERN) ?? []) {
        const content = literal.slice(1, -1);
        if (checkProse(content, SPACE_RULES).length > 0) {
          found.push(`${path}:${index + 1}: ${content}`);
        }
      }
    });
  }
  return { scanned, violations: found };
}

describe("fixed texts in f/factory", () => {
  test("are scanned from at least one file", async () => {
    const { scanned } = await findViolations();

    expect(scanned).toBeGreaterThan(0);
  });

  test("have no space between ASCII and Japanese characters", async () => {
    const { violations } = await findViolations();

    expect(violations).toEqual([]);
  });
});
