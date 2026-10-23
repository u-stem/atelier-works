// 新規投入の入力欄の判定。画面から切り離した純関数にして、`bun test`で確かめる。
// 検証の本体は`manual_intake_submit`にある。ここは、送る前に分かる誤りを入力欄で知らせるためのもので、
// scriptの断りを置き換えない。

import type { IntakeTarget } from "../api/guards/intakeTargets.ts";

/** 題名の上限(コードポイント)。GitHubのIssueの題名の上限に合わせ、scriptの検証と同じ値にする。 */
export const INTAKE_TITLE_MAX_CHARS = 256;

export type IntakeForm = {
  /** `owner/repo`の形。候補から選ぶか、自由に入力する。 */
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  /** 1行に1項目。空でもよい。 */
  readonly acceptanceCriteria: string;
};

export type IntakeProblem =
  | "repo_invalid"
  | "title_empty"
  | "title_too_long"
  | "body_empty";

export type IntakeBuild =
  | {
      readonly ok: true;
      readonly input: {
        readonly owner: string;
        readonly repo: string;
        readonly title: string;
        readonly body: string;
        readonly acceptanceCriteria: string;
      };
    }
  | { readonly ok: false; readonly problems: readonly IntakeProblem[] };

const REPO_REF = /^([^/\s]+)\/([^/\s]+)$/;

/** `owner/repo`をownerとrepoに分ける。その形でなければ`null`を返す。名前の規則の検査はscriptが行う。 */
export function parseRepoRef(
  text: string,
): { owner: string; repo: string } | null {
  const match = REPO_REF.exec(text.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

export function repoOptionLabel(target: IntakeTarget): string {
  return `${target.owner}/${target.repo}`;
}

/**
 * 入力欄の初期値。候補の先頭は、`console_query`が先頭に置く`factory_repo`である。
 * 候補が無いときは空にする。
 */
export function defaultRepoText(targets: readonly IntakeTarget[]): string {
  const first = targets[0];
  return first === undefined ? "" : repoOptionLabel(first);
}

/** 前後の空白を除いた題名の長さ。コードポイントで数え、絵文字は1字に数える。 */
export function titleLength(title: string): number {
  return [...title.trim()].length;
}

function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 入力欄の値を、書き込みの入力にする。送る前に分かる誤りは、すべてまとめて返す。
 * 改行はLFにそろえる。題名と本文の空白の扱いはscriptが決めるので、ここでは除かない。
 */
export function buildIntakeInput(form: IntakeForm): IntakeBuild {
  const problems: IntakeProblem[] = [];
  const repo = parseRepoRef(form.repo);
  if (repo === null) {
    problems.push("repo_invalid");
  }
  const length = titleLength(form.title);
  if (length === 0) {
    problems.push("title_empty");
  } else if (length > INTAKE_TITLE_MAX_CHARS) {
    problems.push("title_too_long");
  }
  if (form.body.trim().length === 0) {
    problems.push("body_empty");
  }
  if (repo === null || problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    input: {
      owner: repo.owner,
      repo: repo.repo,
      title: form.title,
      body: normalizeLineBreaks(form.body),
      acceptanceCriteria: normalizeLineBreaks(form.acceptanceCriteria),
    },
  };
}

const PROBLEM_MESSAGES: Readonly<Record<IntakeProblem, string>> = {
  repo_invalid:
    "リポジトリは「オーナー名/リポジトリ名」の形で入力してください。",
  title_empty: "題名を入力してください。",
  title_too_long: `題名は${INTAKE_TITLE_MAX_CHARS}字までにしてください。`,
  body_empty: "目的を入力してください。",
};

export function describeIntakeProblem(problem: IntakeProblem): string {
  return PROBLEM_MESSAGES[problem];
}
