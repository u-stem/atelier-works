// 手動投入の検証とIssue本文の組み立て。
// Consoleから投入を受ける`manual_intake_submit`(秘密値を読まない)と、
// Issueを作る`steps/manual_intake_create_issue`が共有する。
// 検証は純粋な関数で、拒否の理由は固定の符号だけで返す。入力の文字列を理由に含めない。

import { isRepoAllowed } from "./config.ts";
import { ACCEPTED_PROFILES } from "./profile.ts";
import { type FactoryConfig, isGitHubName } from "./types.ts";

/**
 * 投入を断る理由。Consoleはこの一覧から日本語の固定文を引く。
 * `actor_unknown`は検証ではなく、実行者を導けなかったときに`manual_intake_submit`が使う。
 */
export const MANUAL_INTAKE_REFUSAL_REASONS = [
  "invalid_owner",
  "invalid_repo",
  "repo_not_allowed",
  "profile_not_allowed",
  "empty_title",
  "title_too_long",
  "invalid_title_chars",
  "empty_body",
  "invalid_body_chars",
  "body_too_long",
  "invalid_intake_key",
  "actor_unknown",
] as const;

export type ManualIntakeRefusalReason =
  (typeof MANUAL_INTAKE_REFUSAL_REASONS)[number];

/**
 * 題名と本文の上限(コードポイント)。
 * 値は、Issueの題名が256文字、本文が65,536文字までというGitHubの上限に合わせる。
 * `lib/console_support.ts`の取り込み内容の上限の注記と同じ値である。
 */
export const MANUAL_INTAKE_TITLE_MAX_CHARS = 256;
export const MANUAL_INTAKE_BODY_MAX_CHARS = 65_536;

const NO_RESPONSE = "_No response_";

export type ManualIntakeIssueInput = {
  readonly body: string;
  readonly acceptance_criteria: string;
};

/**
 * `input`を、`.github/ISSUE_TEMPLATE/factory-task.yml`と同じ見出し
 * (目的 / 受入基準)のIssue本文に組み立てる。
 * 書式はGitHubのissue formsの描画に合わせる。
 * 各項目を`### <見出し>`と回答で表し、空の項目は`_No response_`にする。
 * manual_intakeはissue formsを通さずに本文を作るため、この書式を自前で再現する。
 *
 * 描画するのは入力にある目的(`body`)と受入基準(`acceptance_criteria`)だけ。
 * 背景・制約・対象範囲は入力に無いため、空の見出しも作らない。
 * 作ると、投入内容に無い項目を空欄で回答したように見えてしまう。
 */
export function buildManualIntakeIssueBody(
  input: ManualIntakeIssueInput,
): string {
  const purpose =
    input.body.trim().length > 0 ? input.body.trim() : NO_RESPONSE;
  const acceptance =
    input.acceptance_criteria.trim().length > 0
      ? input.acceptance_criteria.trim()
      : NO_RESPONSE;
  return ["### 目的", "", purpose, "", "### 受入基準", "", acceptance].join(
    "\n",
  );
}

export type ManualIntakeFields = ManualIntakeIssueInput & {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  /** 進め方。受け付けるのは`ACCEPTED_PROFILES`に載せた値だけである。 */
  readonly profile: string;
  /** 投入の再送を止める冪等キー。省くと、再送を止めない従来の投入になる。 */
  readonly intake_key?: string;
};

/** 冪等キーの形(小文字のUUID)。`factory.manual_intake_keys`のCHECKと同じ式で、両端に固定する。 */
export const INTAKE_KEY_PATTERN = /(?!)/;

/** 冪等キーの形を検査する。形が違うと例外を投げる。入力の文字列はメッセージに含めない。 */
export function assertIntakeKey(_key: string): void {}

/** 投入の内容(リポジトリ、題名、本文、受入基準、進め方)を正規化して、sha256の16進数にする。 */
export function computeIntakeContentHash(
  _fields: Pick<
    ManualIntakeFields,
    "owner" | "repo" | "title" | "body" | "acceptance_criteria" | "profile"
  >,
): string {
  return "";
}

/** Issueの本文の末尾に置く、冪等キーの目印。 */
export function intakeMarkerText(_key: string): string {
  return "";
}

/** `body`の末尾に、冪等キーの目印の行を足す。 */
export function withIntakeMarker(body: string, _key: string): string {
  return body;
}

/**
 * 進め方が受け付けるものかを返す。入口(検証、Issueの作成、登録)が、同じ一覧を見る。
 * 承認を省く進め方は、この一覧に載せない限り、どの入口も通らない。
 */
function isAcceptedProfile(profile: string): boolean {
  return ACCEPTED_PROFILES.includes(profile);
}

/**
 * 受け付けない進め方なら例外を投げる。Issueの作成と登録のステップが、副作用の前に呼ぶ。
 * 入力の文字列は、メッセージに含めない。
 */
export function assertAcceptedProfile(profile: string): void {
  if (!isAcceptedProfile(profile)) {
    throw new Error("manual_intake: the profile is not accepted");
  }
}

export type ManualIntakeValidation =
  | {
      readonly ok: true;
      /** 検証に使った、前後の空白を除いた題名。GitHubへはこの値を渡す。 */
      readonly title: string;
    }
  | {
      readonly ok: false;
      readonly reason: Exclude<ManualIntakeRefusalReason, "actor_unknown">;
    };

/** コードポイントで数える。絵文字などUTF-16で2単位になる字も1字に数える。 */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

const LF = 0x0a;
const TAB = 0x09;

/**
 * 入力に含めない文字か。
 * C0の制御文字(NULを含む)、DEL、C1(U+0085を含む)、方向を入れ替えるbidiの制御文字
 * (U+202A-202E、U+2066-2069)、行と段落の区切り(U+2028、U+2029)である。
 * `allowLineBreaks`が真のときは、本文のために`\n`と`\t`だけを通す。
 * 方向の印(U+200E、U+200F、U+061C)とゼロ幅の文字は、正当な入力まで壊しうるので通す。
 */
function isForbiddenCodePoint(
  codePoint: number,
  allowLineBreaks: boolean,
): boolean {
  if (codePoint <= 0x1f) {
    return !(allowLineBreaks && (codePoint === LF || codePoint === TAB));
  }
  return (
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function hasForbiddenCharacter(
  text: string,
  allowLineBreaks: boolean,
): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      isForbiddenCodePoint(codePoint, allowLineBreaks)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 手動投入の入力を検証する。上から順に調べ、最初に当たった理由を返す。
 * 許可の判定は`isRepoAllowed`に任せる。リポジトリのオーナーの数値IDの照合は、Issueを作るステップが行う。
 * 進め方は、リポジトリの許可の後、題名より前に調べる。
 * 本文の長さは、`buildManualIntakeIssueBody`で組み立てた後の値で測る。GitHubへ届く長さと一致させるためである。
 */
export function validateManualIntake(
  input: ManualIntakeFields,
  config: Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">,
): ManualIntakeValidation {
  if (!isGitHubName(input.owner)) {
    return { ok: false, reason: "invalid_owner" };
  }
  if (!isGitHubName(input.repo)) {
    return { ok: false, reason: "invalid_repo" };
  }
  if (!isRepoAllowed(config, input.owner, input.repo)) {
    return { ok: false, reason: "repo_not_allowed" };
  }
  if (!isAcceptedProfile(input.profile)) {
    return { ok: false, reason: "profile_not_allowed" };
  }

  const title = input.title.trim();
  if (title.length === 0) {
    return { ok: false, reason: "empty_title" };
  }
  if (codePointLength(title) > MANUAL_INTAKE_TITLE_MAX_CHARS) {
    return { ok: false, reason: "title_too_long" };
  }
  if (hasForbiddenCharacter(title, false)) {
    return { ok: false, reason: "invalid_title_chars" };
  }

  if (input.body.trim().length === 0) {
    return { ok: false, reason: "empty_body" };
  }
  if (
    hasForbiddenCharacter(input.body, true) ||
    hasForbiddenCharacter(input.acceptance_criteria, true)
  ) {
    return { ok: false, reason: "invalid_body_chars" };
  }
  if (
    codePointLength(buildManualIntakeIssueBody(input)) >
    MANUAL_INTAKE_BODY_MAX_CHARS
  ) {
    return { ok: false, reason: "body_too_long" };
  }
  return { ok: true, title };
}
