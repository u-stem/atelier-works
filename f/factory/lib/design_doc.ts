// headless Claudeが書いた設計書(`.claude/skills/factory-design/`の`template.md`と`SKILL.md`)を機械的に検査する。
// I/OやWindmill・GitHubに依存しない純粋関数で、生成後に`steps/design_generate.ts`が行う検査を単体テストでも行える。
// 章立て以外の検査(禁止する記法、引用、長さ、図の参照、見出しのコード表記)は要件定義書と共有する。

import { DESIGN_ID_PATTERN, DESIGN_SECTIONS } from "./design_template.ts";
import {
  checkDiagramRefs,
  checkDocumentProse,
  checkForbiddenSyntax,
  checkLengths,
  checkQuotes,
  checkSectionList,
  extractSectionBody,
  extractTableRows,
} from "./requirements_doc.ts";

/** 要件との対応表の章の見出し。 */
const CORRESPONDENCE_SECTION = "要件との対応表";

/**
 * 要件との対応表のIDの列を検査する。
 * 1行以上あること、形式(`DS-`と3桁)、重複の無さ、001から欠番の無い連番を確かめる。
 */
export function checkDesignIds(markdown: string): string[] {
  const rows = extractTableRows(
    extractSectionBody(markdown, CORRESPONDENCE_SECTION),
  );
  const issues: string[] = [];
  if (rows.length === 0) {
    issues.push("要件との対応が1件もありません");
  }

  const seen = new Set<string>();
  const numbers: number[] = [];
  for (const row of rows) {
    const id = (row[0] ?? "").trim();
    if (id === "") {
      continue;
    }
    if (!DESIGN_ID_PATTERN.test(id)) {
      issues.push(
        `IDの形式が不正です: 「${id}」(DS-連番3桁の形式にしてください)`,
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(`IDが重複しています: 「${id}」`);
      continue;
    }
    seen.add(id);
    numbers.push(Number.parseInt(id.slice(id.indexOf("-") + 1), 10));
  }

  numbers.sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    const expected = i + 1;
    if (numbers[i] !== expected) {
      issues.push(
        `DSのIDが連番になっていません(${String(expected).padStart(3, "0")}番が欠番の可能性があります)`,
      );
      break;
    }
  }
  return issues;
}

export type DesignDocValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/** 書き終えた設計書にすべての検査をかけ、結果を1つの判定にまとめる。 */
export function validateDesignDoc(
  markdown: string,
  diagramFiles: readonly string[],
): DesignDocValidation {
  const issues = [
    ...checkSectionList(markdown, DESIGN_SECTIONS),
    ...checkDesignIds(markdown),
    ...checkForbiddenSyntax(markdown),
    ...checkQuotes(markdown),
    ...checkLengths(markdown),
    ...checkDocumentProse(markdown),
    ...checkDiagramRefs(markdown, diagramFiles),
  ];
  if (issues.length === 0) {
    return { ok: true };
  }
  return { ok: false, issues };
}
