// 新規投入の入力欄の判定。画面から切り離した純関数にして、`bun test`で確かめる。
// 検証の本体は`manual_intake_submit`にある。ここは、送る前に分かる誤りを入力欄で知らせるためのもので、
// scriptの断りを置き換えない。

import type { IntakeTarget } from "../api/guards/intakeTargets.ts";

/** 題名の上限(コードポイント)。GitHubのIssueの題名の上限に合わせ、scriptの検証と同じ値にする。 */
export const INTAKE_TITLE_MAX_CHARS = 256;

/** 投入の進め方。`standard`は承認を経て実装し、ほかの3つは承認を省いて実装する。 */
export const INTAKE_PROFILES = [
  "standard",
  "direct",
  "bugfix",
  "docs",
] as const;

export type IntakeProfile = (typeof INTAKE_PROFILES)[number];

export type IntakeForm = {
  /** `owner/repo`の形。候補から選ぶか、自由に入力する。 */
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  /** 1行に1項目。空でもよい。 */
  readonly acceptanceCriteria: string;
  readonly profile: IntakeProfile;
  /** 不具合の修正のときだけ送る欄。 */
  readonly reproduction: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
};

export type IntakeProblem =
  | "repo_invalid"
  | "title_empty"
  | "title_too_long"
  | "body_empty"
  | "reproduction_empty"
  | "expected_empty"
  | "actual_empty";

export type IntakeBuild =
  | {
      readonly ok: true;
      readonly input: {
        readonly owner: string;
        readonly repo: string;
        readonly title: string;
        readonly body: string;
        readonly acceptanceCriteria: string;
        readonly profile: IntakeProfile;
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

/** 欄の値を、改行をLFにそろえて前後の空白を除く。空白だけの欄は空文字になる。 */
function fieldText(text: string): string {
  return normalizeLineBreaks(text).trim();
}

/**
 * 不具合の欄を、Issueの本文(目的の後)に足す節にする。
 * 欄の値は投入者本人の内容で、見出しとして信頼しない。値の中の`#`で始まる行は、そのまま残す。
 */
function bugfixBody(form: IntakeForm): string {
  return [
    normalizeLineBreaks(form.body).trimEnd(),
    `#### 再現手順\n${fieldText(form.reproduction)}`,
    `#### 実際の動作\n${fieldText(form.actualBehavior)}`,
  ].join("\n\n");
}

/** 期待する動作を先頭に置き、投入者の受入基準があれば、その後ろに続ける。 */
function bugfixAcceptance(form: IntakeForm): string {
  const sections = [`#### 期待する動作\n${fieldText(form.expectedBehavior)}`];
  if (form.acceptanceCriteria.trim().length > 0) {
    sections.push(
      `#### その他の受入基準\n${normalizeLineBreaks(form.acceptanceCriteria).trimEnd()}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * 入力欄の値を、書き込みの入力にする。送る前に分かる誤りは、すべてまとめて返す。
 * 改行はLFにそろえる。題名と本文の空白の扱いはscriptが決めるので、ここでは除かない。
 * 不具合の修正のときだけ、再現手順、期待する動作、実際の動作を本文と受入基準に組み込む。
 * それ以外の進め方では、3欄の値は送らず、空でも問題にしない。
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
  const bugfix = form.profile === "bugfix";
  if (bugfix && fieldText(form.reproduction).length === 0) {
    problems.push("reproduction_empty");
  }
  if (bugfix && fieldText(form.expectedBehavior).length === 0) {
    problems.push("expected_empty");
  }
  if (bugfix && fieldText(form.actualBehavior).length === 0) {
    problems.push("actual_empty");
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
      body: bugfix ? bugfixBody(form) : normalizeLineBreaks(form.body),
      acceptanceCriteria: bugfix
        ? bugfixAcceptance(form)
        : normalizeLineBreaks(form.acceptanceCriteria),
      profile: form.profile,
    },
  };
}

/**
 * 冪等キーを引き継げる入力か。`buildIntakeInput`が組んだ送る値どうしで比べる。
 * 送る値が同じなら、キーの表に残る内容のハッシュも同じになる。違う内容が同じキーを引き継ぐと、
 * 「投入しました」と返った後にフローが断られ、通知にだけ出る。
 * どちらかが組み立てられない入力は、送れないので「違う」とする。
 */
export function sameSentValues(left: IntakeForm, right: IntakeForm): boolean {
  const a = buildIntakeInput(left);
  const b = buildIntakeInput(right);
  return (
    a.ok &&
    b.ok &&
    a.input.owner === b.input.owner &&
    a.input.repo === b.input.repo &&
    a.input.title === b.input.title &&
    a.input.body === b.input.body &&
    a.input.acceptanceCriteria === b.input.acceptanceCriteria &&
    a.input.profile === b.input.profile
  );
}

export type ProfileOption = {
  readonly value: IntakeProfile;
  readonly label: string;
  /** 進め方の違いを知らせる1行。 */
  readonly description: string;
};

export const PROFILE_OPTIONS: readonly ProfileOption[] = [
  {
    value: "standard",
    label: "通常",
    description: "要件定義の承認(設定によっては設計の承認も)を経て実装する",
  },
  {
    value: "direct",
    label: "直接",
    description: "承認なしで実装してPRを作る",
  },
  {
    value: "bugfix",
    label: "不具合の修正",
    description: "再現手順つきで、承認なしで実装してPRを作る",
  },
  {
    value: "docs",
    label: "文書の変更",
    description:
      "文書の変更として承認なしで実装する(文書以外を変えたらPRで警告する)",
  },
];

export function profileLabel(profile: IntakeProfile): string {
  return (
    PROFILE_OPTIONS.find((option) => option.value === profile)?.label ?? ""
  );
}

/** 承認を省く進め方か。`standard`だけが承認を経る。 */
export function skipsApproval(profile: IntakeProfile): boolean {
  return profile !== "standard";
}

/** 承認を省くときに、欄の下へ出す注記。`standard`では出さない。 */
export function profileNotice(profile: IntakeProfile): string | null {
  return skipsApproval(profile)
    ? "PRは人がレビューしてからマージしてください(強制はされません)"
    : null;
}

/**
 * 進め方のラジオで、既定の動作(フォームの暗黙の送信)を止めるキーか。
 * 矢印キーで承認を省く進め方に切り替えた直後のEnterが、確認なしに投入を送るのを防ぐ。
 * 矢印キー、スペース、Tabは、ラジオの選択と移動に使うので止めない。
 */
export function blocksImplicitSubmit(key: string): boolean {
  return key === "Enter";
}

/** 送信ボタンの文言。承認を省くときは、押す場所でそれを示す。 */
export function submitLabel(profile: IntakeProfile): string {
  return skipsApproval(profile) ? "承認なしで投入する" : "投入する";
}

const PROBLEM_MESSAGES: Readonly<Record<IntakeProblem, string>> = {
  repo_invalid:
    "リポジトリは「オーナー名/リポジトリ名」の形で入力してください。",
  title_empty: "題名を入力してください。",
  title_too_long: `題名は${INTAKE_TITLE_MAX_CHARS}字までにしてください。`,
  body_empty: "目的を入力してください。",
  reproduction_empty: "再現手順を入力してください。",
  expected_empty: "期待する動作を入力してください。",
  actual_empty: "実際の動作を入力してください。",
};

export function describeIntakeProblem(problem: IntakeProblem): string {
  return PROBLEM_MESSAGES[problem];
}
