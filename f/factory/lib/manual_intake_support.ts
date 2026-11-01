// 手動投入の検証とIssue本文の組み立て。
// Consoleから投入を受ける`manual_intake_submit`(秘密値を読まない)と、
// Issueを作る`steps/manual_intake_create_issue`が共有する。
// 検証は純粋な関数で、拒否の理由は固定の符号だけで返す。入力の文字列を理由に含めない。

import { createHash } from "node:crypto";
import { isRepoAllowed } from "./config.ts";
import { ACCEPTED_PROFILES, requiredApprovals } from "./profile.ts";
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
  "intake_key_required",
  "implement_disabled",
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

/**
 * 冪等キーの形(小文字のUUID)。`factory.manual_intake_keys`のCHECKと同じ式で、両端に固定する。
 * 大文字、前後の文字、末尾の改行を通さない。
 */
export const INTAKE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 冪等キーの入力を、キー無し(`undefined`)か、形を検査する前の文字列にそろえる。
 * Windmillのフォームは空欄を空文字で送りうるので、空文字、`null`、省略を同じくキー無しにする。
 * 空白だけの文字列は、形が違うキーとして残し、検査で断る。
 */
export function normalizeIntakeKey(
  value: string | null | undefined,
): string | undefined {
  return value === null || value === undefined || value === ""
    ? undefined
    : value;
}

/** 冪等キーの形か。例外を投げず、値を文に含めない。 */
function isIntakeKey(value: string): boolean {
  return INTAKE_KEY_PATTERN.test(value);
}

/**
 * 冪等キーの形を検査する。形が違うと例外を投げる。
 * フローを直接実行する経路でも、表に触れる前に形を確かめるために使う。
 * 入力の文字列は、メッセージに含めない。
 */
export function assertIntakeKey(key: string): void {
  if (!isIntakeKey(key)) {
    throw new Error("manual_intake: the intake key is not accepted");
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * 投入の内容(リポジトリ、題名、本文、受入基準、進め方)を正規化して、sha256の16進数にする。
 * 同じキーで内容が違う投入を、同じ投入として扱わないために使う。
 * 前後の空白と改行の種類は、Issueの本文に影響しないので、正規化で除く。
 * 項目の境目が曖昧にならないよう、JSONの配列にしてから計算する。
 */
export function computeIntakeContentHash(
  fields: Pick<
    ManualIntakeFields,
    "owner" | "repo" | "title" | "body" | "acceptance_criteria" | "profile"
  >,
): string {
  const normalized = JSON.stringify([
    fields.owner,
    fields.repo,
    normalizeText(fields.title),
    normalizeText(fields.body),
    normalizeText(fields.acceptance_criteria),
    fields.profile,
  ]);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Issueの本文の末尾に置く、冪等キーの目印。
 * 作成の結果を取りこぼしたとき、同じキーの再試行がこの目印で作成済みのIssueを見つける。
 */
export function intakeMarkerText(key: string): string {
  return `<!-- factory:intake:${key} -->`;
}

/**
 * 手動投入の本文の最後に置く、固定の区切りの行。
 * 本文の末尾は、目的と受入基準に利用者の入力が入る。入力の最後の行に目印を書かれると、
 * 目印の探索が、別の投入のIssueを作成済みと見誤る。
 * 手動投入は、本文の最後に必ずこの行を足す。目印はその後に足すので、目印の前は常にこの行になる。
 */
export const MANUAL_INTAKE_END_LINE = "<!-- factory:intake:end -->";

/** キー無しの投入の本文に、区切りの行を足す。 */
export function withIntakeEnd(body: string): string {
  return `${body}\n\n${MANUAL_INTAKE_END_LINE}`;
}

/** `body`の末尾に、区切りの行と、冪等キーの目印を、それぞれ単独の行として足す。 */
export function withIntakeMarker(body: string, key: string): string {
  return `${withIntakeEnd(body)}\n\n${intakeMarkerText(key)}`;
}

/**
 * GitHubに投稿するIssueの本文を組み立てる。キーが無ければ区切りの行で、あれば区切りの行と目印で終える。
 * 作業項目の本文にも、この値をそのまま保存する。
 * 承認の前の確認が、作業項目の本文と現在のIssueの本文を比べるので、投稿した本文と食い違うと、承認が常に断られる。
 * Issueを作るステップと登録のステップが、同じ式で組み立てる。
 */
export function buildPostedIssueBody(
  input: ManualIntakeIssueInput,
  key: string | undefined,
): string {
  const assembled = buildManualIntakeIssueBody(input);
  return key === undefined
    ? withIntakeEnd(assembled)
    : withIntakeMarker(assembled, key);
}

/** GitHubのIssueの画面のURL。Issueを作るステップと登録のステップが、同じ式で組み立てる。 */
export function issueHtmlUrl(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `https://github.com/${owner}/${repo}/issues/${String(issueNumber)}`;
}

/**
 * `body`が、区切りの行、空行、`key`の目印の順に終わるかを返す。
 * 目印の探索が見つけたIssueを、作成済みと信じる前の確認に使う。
 * 末尾の空白と改行の種類(CRLF)は無視する。区切りの行は、行の先頭から始まる単独の行でなければならない。
 */
export function endsWithIntakeMarker(body: string, key: string): boolean {
  const text = body.replace(/\r\n?/g, "\n").trimEnd();
  const tail = `${MANUAL_INTAKE_END_LINE}\n\n${intakeMarkerText(key)}`;
  if (!text.endsWith(tail)) return false;
  const before = text.slice(0, text.length - tail.length);
  return before === "" || before.endsWith("\n");
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

/**
 * 進め方が、要件定義の承認を省くか。省く進め方は、人の承認の代わりに入口を閉じる(冪等キー、実装の停止スイッチ)。
 * 登録が実装フローを直接起動する条件と、同じ判定である。
 */
export function skipsApprovals(profile: string): boolean {
  return !requiredApprovals(profile).requirements;
}

/**
 * 承認を省く進め方で冪等キーが無ければ、例外を投げる。副作用の前に呼ぶ。
 * キーが無いと、再送がIssueと作業項目を増やし、承認の無い実装が重なって起動するためである。
 */
export function assertIntakeKeyForProfile(
  profile: string,
  key: string | undefined,
): void {
  if (skipsApprovals(profile) && key === undefined) {
    throw new Error(
      "manual_intake: intake_key_required: the profile needs an intake key",
    );
  }
}

/**
 * 承認を省く進め方で実装が止まっていれば、例外を投げる。Issueを作る前に呼ぶ。
 * 実装を止める設定の間に、承認の無い作業項目とIssueだけが残るのを避けるためである。
 */
export function assertImplementEnabledForProfile(
  profile: string,
  implementEnabled: boolean,
): void {
  if (skipsApprovals(profile) && !implementEnabled) {
    throw new Error(
      "manual_intake: implement_disabled: the implementation is switched off",
    );
  }
}

/**
 * 検証が読む設定。`implement_enabled`は、承認を省く進め方だけが読む。
 * 無い設定は、実装が止まっているものとして扱う(`implement_disabled`)。承認を省く進め方を、設定の欠落で通さないためである。
 */
export type ManualIntakeConfig = Pick<
  FactoryConfig,
  "owners" | "repo_allowlist" | "factory_repo"
> &
  Partial<Pick<FactoryConfig, "implement_enabled">>;

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
 * 承認を省く進め方は、次に実装の停止スイッチ、冪等キーの有無の順に調べる。冪等キーの形は、その次に調べる。
 * 本文の長さは、`buildManualIntakeIssueBody`で組み立てた後の値で測る。GitHubへ届く長さと一致させるためである。
 * Issueの本文の末尾に付ける区切りの行と、冪等キーがあるときの目印の分も数える。空文字のキーは、キー無しとして扱う。
 */
export function validateManualIntake(
  input: ManualIntakeFields,
  config: ManualIntakeConfig,
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
  const intakeKey = normalizeIntakeKey(input.intake_key);
  if (skipsApprovals(input.profile)) {
    if (config.implement_enabled !== true) {
      return { ok: false, reason: "implement_disabled" };
    }
    if (intakeKey === undefined) {
      return { ok: false, reason: "intake_key_required" };
    }
  }
  if (intakeKey !== undefined && !isIntakeKey(intakeKey)) {
    return { ok: false, reason: "invalid_intake_key" };
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
  const issueBody = buildPostedIssueBody(input, intakeKey);
  if (codePointLength(issueBody) > MANUAL_INTAKE_BODY_MAX_CHARS) {
    return { ok: false, reason: "body_too_long" };
  }
  return { ok: true, title };
}
