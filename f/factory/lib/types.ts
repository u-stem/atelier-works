// Software FactoryのWindmill資産(`f/factory/**`)で共有するドメイン型と、
// 外部データを絞り込む型ガード・検証関数を置く。
//
// フィールド名はcamelCaseに変換せず、Postgresの列名やJSONリソースの
// フィールド名(snake_case)にそろえる。理由は次の2つ。
//   - `FactoryConfig`は`RT.CFactoryConfig`(`c_factory_config.resource-type.yaml`
//     から生成される`rt.d.ts`)と常に一致させる。こうすると`loadConfig`は
//     名前を変換せず、検証と既定値の補完だけで済む。
//   - `WorkItem` / `RequirementDraft` / `ApprovalRequest` / `*Record`の各型は
//     `migrations/datatable/main/*.sql`の列と1対1で対応する。こうすると
//     `db.ts`の行の解析(Parse-don't-validate)がフィールドごとの検査で済み、
//     名前を変換する層がスキーマと知らないうちにずれることもない。
//
// 外部の値(DBの行、JSONリソース、サブプロセスの出力)は`as`を使わず、
// 下の型ガードで絞り込んでからこれらの型として扱う。

// ---------------------------------------------------------------------------
// 外部データの解析で`lib/*.ts`全体から使う小さな型ガード。
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** `value`を`allowed`に含まれる文字列リテラルのいずれかに絞り込む。 */
export function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  if (typeof value !== "string") {
    return false;
  }
  return (allowed as readonly string[]).includes(value);
}

/**
 * `workspace.ts`の`commitAndPush`がコミットに付けるauthorとcommitterの名義。
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`環境変数で渡し、git configには書かない。
 * `github.ts`の`gitIdentityForViewer`(PATの持ち主から作る)と
 * `workspace.ts`の`CommitAndPushOptions.author`の両方で使う。
 * `github.ts`はすでに`workspace.ts`から`CommandRunner`をimportしているため、
 * 循環importを避けてどちらのモジュールでもなくここに置く。
 */
export type GitIdentity = {
  readonly name: string;
  readonly email: string;
};

// ---------------------------------------------------------------------------
// サブプロセスの引数やgitのrefに埋め込む値の検証。
// `github.ts` / `workspace.ts`が組み立てるgh・git・claudeのコマンドラインで使う。
// GitHub由来のデータが検査されないままシェルに近いAPIへ渡りそうなとき、
// 呼び出し側は値を黙って飛ばすのではなく確実に失敗させる必要がある。
// そのため型ガードで絞り込むのではなく、例外を投げる。
// ---------------------------------------------------------------------------

/**
 * GitHubのログイン名またはリポジトリ名。
 * 先頭は英数字、2文字目以降は英数字と`.` `_` `-`に限る。
 * `.`、`..`、先頭の`-`はこのパターンだけで弾ける。
 * `assertGitHubName`の明示的な検査は、検査だけを読む人のための念押しである。
 */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `labels`に`label`が付いているかを返す。
 * GitHubのラベル名は大文字小文字を区別せず、検索もイベントも区別しないので、
 * 比較も区別しない。
 */
export function hasLabel(labels: readonly string[], label: string): boolean {
  const wanted = label.toLowerCase();
  return labels.some((name) => name.toLowerCase() === wanted);
}

export function assertGitHubName(name: string): void {
  if (name === "." || name === "..") {
    throw new Error(`invalid GitHub name: ${JSON.stringify(name)}`);
  }
  if (!GITHUB_NAME_PATTERN.test(name)) {
    throw new Error(`invalid GitHub name: ${JSON.stringify(name)}`);
  }
}

/**
 * gitのコミットSHA(短縮形か完全形)。
 * GitHubは常に小文字で返すため、小文字の16進数だけを許す。
 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export function assertSha(sha: string): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`invalid git SHA: ${JSON.stringify(sha)}`);
  }
}

/** 期限(epoch ms)までの残り時間でtimeoutMsを頭打ちにする。期限を過ぎているか、期限が有限の数でなければ0を返す(期限の分からない実行を始めない)。 */
export function capToDeadline(
  timeoutMs: number,
  deadlineAt: number,
  nowMs: number,
): number {
  if (!Number.isFinite(deadlineAt)) return 0;
  return Math.max(0, Math.min(timeoutMs, deadlineAt - nowMs));
}

/**
 * ブランチ名の検査規則。
 * gitの`check-ref-format`を完全には再現しない。悪意のあるブランチ名が
 * `git` / `gh`のフラグとして読まれたり、意図したrefのパスから
 * 抜け出したりするのを防げる程度に、その制約に近づけている。
 */
const BRANCH_NAME_RULES: readonly {
  readonly test: (name: string) => boolean;
  readonly reason: string;
}[] = [
  { test: (name) => name.length === 0, reason: "must not be empty" },
  { test: (name) => name.startsWith("-"), reason: "must not start with -" },
  { test: (name) => name.includes(".."), reason: "must not contain .." },
  {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため、意図して制御文字に一致させる
    test: (name) => /[\x00-\x1f\x7f]/.test(name),
    reason: "must not contain control characters",
  },
  { test: (name) => /\s/.test(name), reason: "must not contain whitespace" },
  {
    test: (name) => /[:~^?*[\\]/.test(name),
    reason: "must not contain : ~ ^ ? * [ \\",
  },
  { test: (name) => name.endsWith("/"), reason: "must not end with /" },
  {
    test: (name) => name.endsWith(".lock"),
    reason: "must not end with .lock",
  },
];

export function assertBranchName(name: string): void {
  for (const rule of BRANCH_NAME_RULES) {
    if (rule.test(name)) {
      throw new Error(
        `invalid branch name (${rule.reason}): ${JSON.stringify(name)}`,
      );
    }
  }
}

/**
 * GitHubのPRのHTMLのURL。
 * ownerは先頭が英数字で、2文字目以降は英数字・`_`・`-`の最大39文字、
 * repoは英数字・`.`・`_`・`-`の1〜100文字(`.`と`..`は除く)に限る。
 * Consoleの`lib/githubLink.ts`の正規表現のowner・repoと同じ形に保つこと。
 */
const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]*$/;

/**
 * `url`が`https://github.com/<owner>/<repo>/pull/<n>`の形でなければ例外を投げる。
 * 記録したURLはConsoleでリンクにするので、別の形のURLは保存しない。
 */
export function assertPullRequestUrl(url: string): void {
  if (!PULL_REQUEST_URL.test(url)) {
    throw new Error(`invalid pull request url: ${JSON.stringify(url)}`);
  }
}

// ---------------------------------------------------------------------------
// work_items
// ---------------------------------------------------------------------------

/** 作業項目がFactoryに入った経路。 */
export type WorkItemSource = "issue" | "manual" | "schedule";
export const WORK_ITEM_SOURCES: readonly WorkItemSource[] = [
  "issue",
  "manual",
  "schedule",
];

/** 作業項目のサイクルが扱うGitHubの対象の種類。 */
export type WorkItemKind = "issue" | "pr_review" | "pr_fix" | "audit";
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  "issue",
  "pr_review",
  "pr_fix",
  "audit",
];

/**
 * 作業項目が取りうるすべての状態。
 * 要件定義のパイプライン(`pipeline.flow`)、PRのレビュー・修正の
 * パイプライン(`pr_review.flow` / `pr_fix.flow`)、終端の結果を含む。
 */
export type WorkItemStatus =
  | "picked"
  | "requirements_generating"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "implementing"
  | "pr_open"
  | "reviewing"
  | "reviewed"
  | "fixing"
  | "rereview_requested"
  | "blocked"
  | "needs_human"
  | "failed"
  | "expired"
  | "cancelled"
  | "auditing"
  | "audited";

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "picked",
  "requirements_generating",
  "awaiting_approval",
  "approved",
  "rejected",
  "implementing",
  "pr_open",
  "reviewing",
  "reviewed",
  "fixing",
  "rereview_requested",
  "blocked",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "auditing",
  "audited",
];

/**
 * 終端の状態(`docs/architecture.md`の「状態遷移」)。
 * `factory.v_lead_time`ビューも同じ一覧を持つため、変えるときは
 * migrationで両方をそろえる。
 * `rereview_requested`はpr_fixの成功の終端である。
 * ここに入れないと、`poll_issues`の照合が完了したpr_fixの行を孤児とみなし、
 * 猶予期間を過ぎると失敗にしてしまう。
 * 同じ理由で、implement(工程3)の成功の終端である`pr_open`も入れる。
 * `done`という状態は無く、マージの追跡は工程4で扱う。
 */
export const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "approved",
  "rejected",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
  "reviewed",
  "rereview_requested",
  "blocked",
  "audited",
  "pr_open",
];

/**
 * `factory.work_items`の1行。
 * `pr_review` / `pr_fix`種別の作業項目はIssueに基づかず、
 * 代わりに`pr_number` / `title`を持つ。
 * そのため`issue_number` / `issue_url` / `title` / `body`はnullを取りうる。
 */
export type WorkItem = {
  id: number;
  cycle: number;
  source: WorkItemSource;
  kind: WorkItemKind;
  owner: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  pr_number: number | null;
  title: string | null;
  body: string | null;
  status: WorkItemStatus;
  attempt: number;
  claimed_by: string | null;
  flow_job_id: string | null;
  resume_url: string | null;
  cancel_url: string | null;
  head_sha: string | null;
  last_review_id: number | null;
  last_comment_id: number | null;
  /**
   * 処理済みの位置。`pr_fix_finish`が返信したPRのインラインレビュー
   * コメントのうち最大のid。
   * Issueコメント(`last_comment_id`)とはidの空間が別である。
   */
  last_review_comment_id: number | null;
  /** 観測済みの位置。`poll_prs`がこの作業項目を取得したときに見たPRレビューの最大のid。 */
  observed_review_id: number | null;
  /** 観測済みの位置。`poll_prs`がこの作業項目を取得したときに見たIssueコメントの最大のid。 */
  observed_comment_id: number | null;
  /**
   * 観測済みの位置。`poll_prs`がこの作業項目を取得したときに見た、
   * PRのインラインレビューコメントの最大のid。
   */
  observed_review_comment_id: number | null;
  fix_round: number;
  parent_work_item_id: number | null;
  /**
   * 工程3の実装ブランチ(`factory/issue-<N>-wi-<id>`)。
   * `kind = "issue"`の行で、`implement_prepare`が作った後に入る。
   * それより前と、ほかの種別では`null`。
   */
  branch: string | null;
  /**
   * 工程3が作ったPRのHTML URL(状態`pr_open`)。それまでは`null`。
   * `pr_number`は種別をまたいでPR側の作業項目を束ねるキーに使うため、
   * Issue側の行には持たせず、意図してURLで記録する。
   */
  pr_url: string | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// requirement_drafts
// ---------------------------------------------------------------------------

/**
 * 要件定義書と一緒に書き出すdraw.ioの図1つ。
 * `file`は`RequirementDraft.doc_dir`の中の`<name>.drawio`のファイル名である。
 * XML自体はDBに保存しない(`pipeline_generate.ts`の冒頭コメントを参照)。
 */
export type Diagram = {
  name: string;
  file: string;
};

export type RequirementDraft = {
  id: number;
  work_item_id: number;
  attempt: number;
  summary: string;
  markdown: string;
  diagrams: Diagram[];
  open_questions: string[];
  /**
   * この試行の`requirements.md`とすべての図のファイルを置く、
   * worker内のディレクトリ(`lib/requirements_template.ts`の
   * `buildRequirementsDocDir`)。
   * この列ができる前(2026-09-27より前)に生成された行では`null`。
   */
  doc_dir: string | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// approval_requests: 種別を問わない承認待ち。
// 承認を扱うscriptはすべてこのテーブルを通す。
// ---------------------------------------------------------------------------

/**
 * 承認依頼が待っている判断の種類。
 * `subject_id`は、`"requirements"`ならrequirement_drafts、
 * `"issue_proposal"`ならissue_proposalsの対応する行を指す。
 */
export type ApprovalRequestKind = "requirements" | "issue_proposal";
export const APPROVAL_REQUEST_KINDS: readonly ApprovalRequestKind[] = [
  "requirements",
  "issue_proposal",
];

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";
export const APPROVAL_REQUEST_STATUSES: readonly ApprovalRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
];

/** `factory.approval_requests`の1行。 */
export type ApprovalRequest = {
  id: number;
  kind: ApprovalRequestKind;
  work_item_id: number;
  /**
   * 種別が`"requirements"`なら`requirement_drafts.id`、
   * `"issue_proposal"`なら`issue_proposals.id`。
   */
  subject_id: number;
  status: ApprovalRequestStatus;
  /** 依頼側のメタデータ。例: `"requirements"`では`{ "attempt": n }`。 */
  payload: Record<string, unknown>;
  /** 判断側のオプション。例: `"issue_proposal"`では`{ "with_factory_label": bool }`。 */
  decision_options: Record<string, unknown>;
  requested_at: Date;
  /** `null`は期限が無いことを表す(`"issue_proposal"`など)。 */
  expires_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// 挿入用の`*Record`型。`db.ts`の記録用の関数に渡す形である。
// `id`と`created_at`は挿入時に決まるため含まない。
// ---------------------------------------------------------------------------

/** `db.recordAgentRun`に渡す、`factory.agent_runs`の1行。 */
export type AgentRunRecord = {
  work_item_id: number;
  stage: string;
  attempt: number;
  model: string;
  claude_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  session_id: string | null;
  exit_code: number | null;
  error: string | null;
};

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

/**
 * 指摘の分類。
 * - `must`: マージ前に修正が必要。
 * - `imo`: 提案や意見で、マージを妨げない。
 * - `nits`: 些細な点や書き方の好み。
 * - `q`: 変更を求めない純粋な質問。
 *
 * 統計用に残す`severity`とは別の項目だが、対応はそろえる。
 * blockerとmajorは`must`、minorは`imo`、nitは`nits`に対応し、
 * `q`はseverityに関係なく付く。
 */
export type ReviewFindingKind = "must" | "imo" | "nits" | "q";

export type ReviewFinding = {
  path: string;
  /** head側(差分適用後)の行番号。`end_line`と同じ基準。 */
  line: number | null;
  /** 複数行にわたる指摘の最終行。1行だけの指摘では`null`。 */
  end_line: number | null;
  severity: ReviewSeverity;
  kind: ReviewFindingKind;
  message: string;
  suggestion: string | null;
  /**
   * `line`から`end_line`まで(両端を含む)を置き換える全文。
   * GitHubのsuggestionブロックとして投稿する。
   * 具体的な修正を提案しないときは`null`。
   */
  suggested_code: string | null;
};

/**
 * `pr_review.flow`の実行の総合判定。
 * GitHubのレビューは常にCOMMENTイベントとして投稿するため、
 * これはGitHubのレビューの`event`ではなく、レビュー本文に表示する判定である。
 */
export type ReviewVerdict = "approve" | "comment" | "request_changes";

/** `db.insertReview`に渡す、`factory.reviews`の1行。 */
export type ReviewRecord = {
  work_item_id: number;
  head_sha: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  posted_review_id: string | null;
};

export type FixOutcome = "done" | "requirements_gap" | "blocked";

/**
 * 修正の返信で、元のコメントをどう扱ったか。
 * - `"fixed"`: コードを変更して対応した。
 * - `"skipped"`: 意図して変更しなかった。
 * - `"propose_issue"`: 妥当だがこのPRの範囲外。修正も見送りもせず、
 *   ClaudeがGitHub Issueの候補を下書きし、人がConsoleのInboxから
 *   `issue_proposal_apply.ts`を通して承認・却下する。
 *
 * `pr_workflow_support.ts`の`renderFixReply`の最終行がこれで決まる
 * (`"fixed"`はコミットSHA、`"skipped"`は「見送り」、
 * `"propose_issue"`は「Issue化を提案(承認待ち)」)。
 * 省略はできず、判断の無い返信は`FixReply`の型ガードで弾く
 * (parse-don't-validate)。
 */
export type FixReplyDecision = "fixed" | "skipped" | "propose_issue";

/** `"propose_issue"`の`FixReply`でClaudeが下書きするIssueのタイトルと本文。 */
export type IssueProposalDraft = {
  title: string;
  body: string;
};

export type FixReply = {
  review_comment_id: number;
  body: string;
  decision: FixReplyDecision;
  /**
   * `decision`が`"propose_issue"`のときに限りnullでない値を持つ
   * (`pr_workflow_support.ts`の型ガード`isFixReplyShape`を参照)。
   * このフィールドができる前に記録された返信と互換を保つため省略可能にしており、
   * 読む側はすべて省略を`null`と同じに扱う。
   */
  issue_proposal?: IssueProposalDraft | null;
};

/** `db.insertFixRound`に渡す、`factory.fix_rounds`の1行。 */
export type FixRoundRecord = {
  work_item_id: number;
  round: number;
  trigger_review_ids: number[];
  outcome: FixOutcome;
  replies: FixReply[];
  commit_shas: string[];
};

// ---------------------------------------------------------------------------
// implement_rounds(工程3)
// ---------------------------------------------------------------------------

/**
 * ラウンドの種類。
 * `implement`は承認済みの要件定義に対する最初のラウンド、
 * `fix`は失敗した検査を直すラウンド(`implement_verify`のループ)。
 */
export type ImplementRoundMode = "implement" | "fix";
export const IMPLEMENT_ROUND_MODES: readonly ImplementRoundMode[] = [
  "implement",
  "fix",
];

/**
 * ラウンドの結果。テーブルのCHECK制約と一致させる。
 * `done` / `requirements_gap`はClaudeの出力から、
 * `check_failed` / `checks_skipped` / `stalled`は検証ループから決まる。
 * `error`はClaudeの実行自体が失敗したときに使う。
 */
export type ImplementRoundOutcome =
  | "done"
  | "requirements_gap"
  | "check_failed"
  | "checks_skipped"
  | "stalled"
  | "error";
export const IMPLEMENT_ROUND_OUTCOMES: readonly ImplementRoundOutcome[] = [
  "done",
  "requirements_gap",
  "check_failed",
  "checks_skipped",
  "stalled",
  "error",
];

export function isImplementRoundMode(
  value: unknown,
): value is ImplementRoundMode {
  return isOneOf(value, IMPLEMENT_ROUND_MODES);
}

export function isImplementRoundOutcome(
  value: unknown,
): value is ImplementRoundOutcome {
  return isOneOf(value, IMPLEMENT_ROUND_OUTCOMES);
}

/** `implement_rounds.diff_stat`。ラウンド後のworktreeの差分の規模。 */
export type ImplementDiffStat = {
  files: number;
  added: number;
  deleted: number;
};

export function isImplementDiffStat(
  value: unknown,
): value is ImplementDiffStat {
  return (
    isRecord(value) &&
    isNumber(value.files) &&
    isNumber(value.added) &&
    isNumber(value.deleted)
  );
}

/**
 * `db.insertImplementRound`に渡す、`factory.implement_rounds`の1行。
 * `id` / `created_at` / `round`は含まない。
 * `round`は挿入時に作業項目ごとに`COALESCE(MAX(round), 0) + 1`で決まる。
 */
export type ImplementRoundRecord = {
  work_item_id: number;
  attempt: number;
  mode: ImplementRoundMode;
  outcome: ImplementRoundOutcome;
  summary: string;
  gap_report: string | null;
  /**
   * 検査の出力の先頭16KB。検査の前に止まったラウンドでは止まった理由。
   * どちらも無ければ`null`。
   */
  check_output: string | null;
  checks_skipped_reason: string | null;
  /**
   * 差分から検出した、保護対象のパス・新しいシェルスクリプト・
   * `package.json`の`scripts`の変更。
   * PR本文に載せるために記録するだけで、処理は止めない。
   */
  protected_changes: string[];
  diff_stat: ImplementDiffStat | null;
  agent_run_id: number | null;
};

/** `db.listImplementRounds`が読み戻す、`factory.implement_rounds`の1行全体。 */
export type ImplementRound = ImplementRoundRecord & {
  id: number;
  round: number;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// issue_proposals: GitHub Issueの候補。人がConsoleのInboxから
// (`issue_proposal_apply.ts`を通して)承認・却下するのを待つ。
// ---------------------------------------------------------------------------

export type IssueProposalStatus = "pending" | "approved" | "rejected";

/** 提案の発生元。pr_fixの`propose_issue`の返信か、監査レポート(工程5)。 */
export type IssueProposalOrigin = "pr_fix" | "audit";
export const ISSUE_PROPOSAL_ORIGINS: readonly IssueProposalOrigin[] = [
  "pr_fix",
  "audit",
];

type IssueProposalBase = {
  id: number;
  work_item_id: number;
  title: string;
  body: string;
  status: IssueProposalStatus;
  decided_by: string | null;
  decision_reason: string | null;
  /**
   * この提案から作るIssueに`factory_config.trigger_label`を付けて
   * 要件定義のパイプラインに乗せるよう、判断者が求めたかどうか。
   * 判断前と、却下した場合(ラベルが関係しない)は`null`。
   * 実際にラベルを付けたかは、適用時に`steps/issue_proposal_apply.ts`の
   * `resolveFactoryLabel`が別に決める。`factory_repo`が`factory_config`で
   * 許可されていなければ、`audit`の提案の要求を断ることがある。
   * この列はその場合も求められた値をそのまま残す。
   */
  with_factory_label: boolean | null;
  created_issue_number: number | null;
  created_issue_url: string | null;
  /**
   * `review_comment_id`がPRのレビューコメントなら`true`
   * (`replyReviewComment`で返信)、通常のIssueコメントなら`false`
   * (`postIssueComment`で返信)。
   * `pr_fix_finish.ts`が自分の返信先を選ぶのと同じ情報から挿入時に決める。
   * こうすると`issue_proposal_apply.ts`は判断の返信先を推測せず確実に選べる。
   * `origin = "audit"`では常に`false`で、読まれない。
   */
  is_inline: boolean;
  created_at: Date;
  decided_at: Date | null;
};

/**
 * pr_fixの`propose_issue`の返信から生じた提案。
 * GitHubのレビューコメントかIssueコメントにぶら下がる。
 */
export type PrFixIssueProposal = IssueProposalBase & {
  origin: "pr_fix";
  /**
   * この提案の返信がぶら下がるGitHubのレビューコメント(または通常のIssueコメント)。
   * 元になった`FixReply`の`review_comment_id`と同じid。
   */
  review_comment_id: number;
  /**
   * `pr_fix_finish.ts`が`review_comment_id`から解決できた、
   * GraphQLのレビュースレッドのノードid。
   * 通常のIssueコメントの場合と、照合に失敗した場合
   * (コメントの位置の行が動いたなど)は`null`。
   */
  thread_id: string | null;
  audit_report_id: null;
  position: null;
};

/**
 * 監査レポート(工程5)から生じた提案。GitHubのスレッドは持たず、
 * 代わりに`(audit_report_id, position)`で識別する。
 */
export type AuditIssueProposal = IssueProposalBase & {
  origin: "audit";
  review_comment_id: null;
  thread_id: null;
  audit_report_id: number;
  position: number;
};

/** `factory.issue_proposals`の1行。 */
export type IssueProposal = PrFixIssueProposal | AuditIssueProposal;

/** `factory.audit_reports`の1行。 */
export type AuditReport = {
  id: number;
  work_item_id: number;
  period_start: Date;
  period_end: Date;
  summary: string;
  markdown: string;
  metrics: Record<string, unknown>;
  created_at: Date;
};

/** `db.recordFailure`に渡す、`factory.job_failures`の1行。 */
export type FailureRecord = {
  work_item_id: number | null;
  flow_path: string;
  job_id: string;
  step: string | null;
  error: string;
};

/**
 * 反映に含まれるPRを誰が作ったか。
 * `factory`はFactoryの実装ブランチから作られたPR、`human`はそれ以外のブランチから作られたPR、
 * `unknown`はマージのコミットからブランチを読めなかったPRである。
 */
export const PULL_REQUEST_ORIGINS = ["factory", "human", "unknown"] as const;
export type PullRequestOrigin = (typeof PULL_REQUEST_ORIGINS)[number];

/** 反映に記録するPRの題名の長さの上限(文字数)。 */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 200;

/** 1回の反映に含まれるPR。`factory.deployments.pull_requests`のJSON配列の要素。 */
export type DeploymentPullRequest = {
  readonly number: number;
  /** マージのコミットの本文から取った題名。取れなければnull。画面には文字として出す。 */
  readonly title: string | null;
  readonly origin: PullRequestOrigin;
  /** `https://github.com/<owner>/<repo>/pull/<n>`の形。作れなければnull。 */
  readonly url: string | null;
};

/** `db.recordDeployment`に渡す、`factory.deployments`の1行。 */
export type DeploymentRecord = {
  sha_from: string | null;
  sha_to: string;
  changed_paths: string[];
  result: string;
  needs_host_action: boolean;
  pull_requests: DeploymentPullRequest[];
};

/** `factory.deployments`の最新の1行のうち、反映の成否と対象の版を表す列。 */
export type LatestDeployment = {
  readonly result: string;
  readonly sha_to: string;
};

/** `db.addNotice`に渡す、`factory.notices`の1行。 */
export type NoticeRecord = {
  kind: string;
  message: string;
};

/**
 * `factory.notices`の保存済みの1行。
 * `resolved_by`は解決した承認者で、DBの掃除が解決した行では`cleanup_db`になる。
 * `resolved_by`と`resolved_at`は、解決の記録が無ければ`null`。
 */
export type Notice = {
  id: number;
  kind: string;
  message: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// factory_config(リソース`f/factory/factory_config`、型`c_factory_config`)
// ---------------------------------------------------------------------------

export type FactoryOwnerKind = "user" | "org";

export type FactoryOwner = {
  name: string;
  kind: FactoryOwnerKind;
};

export type LabelerAssociation = "OWNER" | "MEMBER" | "COLLABORATOR";

/**
 * `review_post_mode`の値。
 * `"gated"`では、`pr_review_post.ts`がレビューを記録するだけでGitHubに投稿しない。
 * 承認を経て投稿する仕組みはまだ無い。
 */
export type ReviewPostMode = "comment_only" | "gated";

/**
 * 検証と既定値の補完を済ませた実行時の設定。
 * `lib/config.ts`の`loadConfig`が、`c_factory_config`リソースの生の値
 * (`rt.d.ts`の`RT.CFactoryConfig`)から作る。
 * 既定値は`loadConfig`で補うため、ここではすべてのフィールドが必須であり、
 * 使う側は常に完全な設定を受け取る。
 */
export type FactoryConfig = {
  owners: FactoryOwner[];
  trigger_label: string;
  /**
   * PRのレビューと修正のコメントの投稿者を、GitHubの`author_association`で絞る。
   * トリガーラベルの付与者の確認には使わない(ラベルの`labeled`イベントは
   * `author_association`を持たないため)。
   */
  allowed_labeler_associations: LabelerAssociation[];
  /**
   * トリガーラベルを付けてよい、FactoryのPATのアカウント以外のGitHubのログイン名。
   * 空なら、PATのアカウントが付けたラベルだけに反応する。大文字小文字は区別しない。
   */
  allowed_labeler_logins: string[];
  model: string;
  heavy_model: string;
  max_attempts: number;
  max_turns: number;
  max_budget_usd_per_run: number;
  daily_budget_usd: number;
  claude_timeout_sec: number;
  worktree_ttl_days: number;
  /**
   * 終端状態の作業項目を、`cleanup_db.ts`が削除するまで残す日数。
   * work_itemsを`ON DELETE CASCADE`で参照する表の行も同じく残る。
   */
  retention_work_items_days: number;
  /**
   * job_failures、deployments、解決済みのnoticesの行を、
   * `cleanup_db.ts`がwork_itemsとは独立に削除するまで残す日数。
   */
  retention_logs_days: number;
  factory_repo: string;
  /**
   * `self_update.ts`がこのSoftware Factory自身のリポジトリから更新するときに
   * 追う`factory_repo`のブランチ。`ensureFactoryClone`が毎回fetchし、
   * `checkout -B`でこのブランチのリモートの状態に合わせる。
   */
  factory_branch: string;
  instance_name: string;
  windmill_public_url: string;
  // 以下はリソース型でもリモートのリソースでも省略可能で、
  // `loadConfig`が既定値を補う。これらのフィールドを持たない既存の
  // リソースも検証を通る。
  review_label: string;
  fix_label: string;
  /**
   * 追跡中のPR(`work_items.kind`がpr_review / pr_fix)を、`poll_prs.ts`の
   * `listTrackedPrs`がDBから再発見する対象に残す日数。
   * そのPRの最新のwork_itemsの行の`updated_at`から数える。
   * PRのトリガーラベルは取得時に消費されるため、人が承認・修正ラベルの付与・
   * 修正のpushなどをした後にPRを再び見つけるには、この再発見を使う。
   */
  tracked_pr_days: number;
  review_post_mode: ReviewPostMode;
  max_fix_rounds: number;
  allowed_check_commands: string[];
  default_reviewers: string[];
  /** 空なら`owners`以外の制限をかけない。 */
  repo_allowlist: string[];
  diff_max_lines: number;
  /**
   * `pr_fix_verify`の1回の差分で許す変更ファイル数の上限。
   * 超えるとneeds_humanに回す(セキュリティ上の制限)。
   */
  max_fix_changed_files: number;
  /**
   * `pr_fix_verify`の1回の差分で許す行数(追加と削除の合計)の上限。
   * 超えるとneeds_humanに回す(セキュリティ上の制限)。
   */
  max_fix_diff_lines: number;
  /**
   * 監査(工程5)の1期間がさかのぼれる日数の上限。
   * 前回のレポートがこれより古いときに効く。
   */
  max_lookback_days: number;
  // 工程3(implementフロー)。リソース型ではすべて省略可能で、既定値がある。
  // `implement_enabled`だけは既定が`false`で、有効にする前提は`docs/operations.md`にある。
  /** 承認後に`requirements_apply`がimplementフローを起動するか。 */
  implement_enabled: boolean;
  /** `implement_verify`のラウンド数の上限(implement 1回とfix N-1回)。 */
  implement_max_rounds: number;
  /** implementフローでのClaudeの1回の実行のターン数の上限。 */
  implement_max_turns: number;
  /** implementフローでのClaudeの1回の実行の予算(USD)。 */
  implement_max_budget_usd_per_run: number;
  /** implementフローでのClaudeの1回の実行のタイムアウト(秒)。 */
  implement_timeout_sec: number;
  /** 実装フローの検査コマンド1件のタイムアウト(秒)。フロー全体の期限では短く切らない。 */
  implement_check_timeout_sec: number;
  /**
   * 実装フロー1回の実行の期限(秒)。準備の開始から数える。
   * 修正ラウンドを始めるかどうかと、Claude実行の頭打ちにだけ効く。
   * flow.yamlのstep timeoutとの整合は、実装フローの準備で確かめる(`implementTimeoutMisfit`)。
   */
  implement_flow_timeout_sec: number;
  /** implementフローの差分の規模の上限のうち、変更ファイル数。 */
  implement_max_changed_files: number;
  /** implementフローの差分の規模の上限のうち、追加と削除の行数の合計。 */
  implement_max_diff_lines: number;
  /**
   * リポジトリごとの検査コマンド(`"<owner>/<repo>": string[]`)。
   * implementフローはこれだけを実行する(`config.ts`の
   * `implementCheckCommandsFor`)。エントリの無いリポジトリでは
   * 検査コマンドを実行しない。
   * 一方、`checkCommandsFor`は`allowed_check_commands`にフォールバックする。
   */
  check_commands_by_repo: Record<string, string[]>;
};
