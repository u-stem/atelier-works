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

/** `value`がGitHubのログイン名かリポジトリ名の形か。例外を投げず、値を文に含めない。 */
export function isGitHubName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    GITHUB_NAME_PATTERN.test(value)
  );
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

/** `value`がブランチ名の検査規則に合うか。例外を投げず、値を文に含めない。 */
export function isBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !BRANCH_NAME_RULES.some((rule) => rule.test(value))
  );
}

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
export type WorkItemKind =
  | "issue"
  | "pr_review"
  | "pr_fix"
  | "audit"
  | "dependabot";
export const WORK_ITEM_KINDS: readonly WorkItemKind[] = [
  "issue",
  "pr_review",
  "pr_fix",
  "audit",
  "dependabot",
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
  /**
   * この作業項目が直しているCIの判定(`pr_ci_checks`の行)のID。
   * CIの失敗を直す`pr_fix`の作業項目だけが持ち、それ以外は`null`。外部キーは持たない。
   */
  ci_check_id: number | null;
  /**
   * この作業項目が直しているマージの競合(`pr_conflict_checks`の行)のID。
   * 競合を直す`pr_fix`の作業項目だけが持ち、それ以外は`null`。外部キーは持たない。
   * `ci_check_id`とは同時に持たない。
   */
  conflict_check_id: number | null;
  /** 直している競合のepisode。`conflict_check_id`と同時に値を持ち、同時に`null`になる。 */
  conflict_episode: number | null;
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

/**
 * 1回のClaudeの実行で、実際に使われた1つのモデルの使用量。
 * `claude -p`の結果の`modelUsage`の1要素にあたり、`agent_runs.model_usage`の要素として保存する。
 */
export type ModelUsageEntry = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
};

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
  /**
   * 実際に使われたモデルごとの内訳。`model`は`--model`に渡した値で、別のモデルが使われても変わらない。
   * Claudeが結果を返さなかった実行と、`modelUsage`を持たない結果では空になる。
   */
  model_usage: readonly ModelUsageEntry[];
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

/**
 * 投稿したレビューの結果。Discordの通知とConsoleのレビュー行が、同じ基準で状態を出す。
 * `changes_requested`は、修正必須の指摘が未解決の状態である。
 * `reviewed`は、修正必須の指摘が無く、人の承認を待つ状態である。
 */
export type ReviewResult = "changes_requested" | "reviewed";

/**
 * 投稿した直後に判定した、レビューの結果。
 * `unverified`は、前のラウンドから残った未解決の`[MUST]`を数えるためのスレッドの一覧を読めず、
 * 指摘が残っているかを判定できなかった状態である。
 * 残っていないと分からないので、`reviewed`(人の承認を待てる状態)にはしない。
 * `factory.reviews`には記録せず、`result`をnullにする。
 */
export type ReviewOutcome = ReviewResult | "unverified";

/**
 * `factory.reviews`の1行。
 * `result`は、結果を記録する前に作られた行か、
 * 未解決の指摘を読めず結果を判定できなかった行(`ReviewOutcome`の`unverified`)で`null`になる。
 */
export type ReviewRecord = {
  work_item_id: number;
  head_sha: string;
  verdict: ReviewVerdict;
  result: ReviewResult | null;
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
 *   ClaudeがGitHub Issueの候補を下書きし、人がConsoleの要対応から
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
// issue_proposals: GitHub Issueの候補。人がConsoleの要対応から
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

/**
 * ジョブごとの一時ディレクトリを掃除するまでの経過秒(`job_tmp.ts`の掃除が読む)。
 * ジョブの終了時の削除が走らなかったものだけが残る。取り消されたジョブや強制終了されたworkerが対象である。
 * 動いているジョブのものを消さないよう、`claude_timeout_sec`と`implement_timeout_sec`の既定値より十分長くする。
 * `config.ts`は、この2つの設定がこの期限を超えるものを拒否する。
 * 設定を読むだけのscriptが、ファイル操作の`job_tmp.ts`をimportでたどらないよう、ここに置く。
 */
export const JOB_TMP_MAX_AGE_SEC = 3 * 24 * 60 * 60;

/** 反映に記録するPRの題名の長さの上限(文字数)。 */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 200;

/**
 * 題名から取り除く文字。空白に置き換える。
 * - 制御文字と行・段落の区切り(`\p{Cc}\p{Zl}\p{Zp}`)
 * - 書字方向の制御文字(U+061C、U+200E、U+200F、U+202A-202E、U+2066-2069)
 * - 幅の無い空白と、見えない演算子など、形を変えない書式文字(U+200B、U+2060-2064、U+FEFF)
 * - タグ文字(U+E0000-E007F)
 * ZWJ(U+200D)とZWNJ(U+200C)は残す。絵文字の列やペルシア語、インド系の文字の題名が崩れるためである。
 */
const TITLE_REMOVED_CHARS =
  /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/**
 * PRの題名として記録、表示してよい形にする。
 * `TITLE_REMOVED_CHARS`を空白にし、連続する空白を1つにして、
 * `MAX_PULL_REQUEST_TITLE_LENGTH`文字で切る。空になれば`null`を返す。
 * 題名はPRの作者が決める文字列で、表示だけに使い、承認の判断には使わない。
 * 記録するときと読み出すときの両方で通し、表示を崩す文字を持ち込ませない。
 */
export function sanitizePullRequestTitle(raw: string): string | null {
  const cleaned = raw
    .replace(TITLE_REMOVED_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned)
    .slice(0, MAX_PULL_REQUEST_TITLE_LENGTH)
    .join("")
    .trim();
}

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
  /**
   * 失敗の理由。伏せ字処理と切り詰めを済ませた文(`recordFailedDeployment`を参照)。
   * 成功の記録では`null`にする。省くと`null`と同じ扱いになる。
   */
  error?: string | null;
};

/** `factory.deployments`の最新の1行のうち、反映の成否と対象の版を表す列。 */
export type LatestDeployment = {
  readonly result: string;
  readonly sha_to: string;
};

/** `db.addNoticeUnlessUnresolved`に渡す、`factory.notices`の1行。 */
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
// GitHubの収集(`gh_repos`、`gh_collect_runs`)
// ---------------------------------------------------------------------------

/**
 * リポジトリが「消えた」(`gone`)理由。
 * `archived`は一覧にあるがarchiveされている。`not_listed`は前回あったのに一覧に無い。
 * `not_visible`は`repo_allowlist`にあるのに一覧に無い。
 */
export const GH_GONE_REASONS = [
  "archived",
  "not_listed",
  "not_visible",
] as const;
export type GhGoneReason = (typeof GH_GONE_REASONS)[number];

/** 収集の実行の失敗の種類。成功の行には付けない。 */
export const GH_COLLECT_ERROR_CODES = [
  "no_token",
  "token_config_invalid",
  "db_error",
  "owner_mismatch",
  "deadline",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "secondary_limit",
  "http_5xx",
  "timeout",
  "graphql_error",
  "parse_error",
] as const;
export type GhCollectErrorCode = (typeof GH_COLLECT_ERROR_CODES)[number];

/** 収集の実行の失敗が生じた段。一覧が`list`、詳細が`detail`。 */
export const GH_COLLECT_STAGES = ["list", "detail"] as const;
export type GhCollectStage = (typeof GH_COLLECT_STAGES)[number];

/** PRの記録の状態。開いている、または観測の時点で一覧に無かった。 */
export const GH_PR_STATES = ["open", "closed"] as const;
export type GhPrState = (typeof GH_PR_STATES)[number];

/** Issueの記録の状態。閉じたのかラベルが外れたのかは区別しない。 */
export const GH_ISSUE_STATES = ["open", "unlisted"] as const;
export type GhIssueState = (typeof GH_ISSUE_STATES)[number];

/** 作者のGraphQLの種別。 */
export const GH_AUTHOR_TYPES = [
  "User",
  "Bot",
  "Mannequin",
  "Organization",
  "EnterpriseUserAccount",
] as const;
export type GhAuthorType = (typeof GH_AUTHOR_TYPES)[number];

/** 保存する`mergeable`の値。`UNKNOWN`は保存しない。 */
export const GH_MERGEABLE_VALUES = ["MERGEABLE", "CONFLICTING"] as const;
export type GhMergeable = (typeof GH_MERGEABLE_VALUES)[number];

/** エラーが出ても別名を失敗にしない、PRの任意の項目。スキーマで`null`を許す項目だけを挙げる。 */
export const GH_DETAIL_OPTIONAL_FIELDS = [
  "labels",
  "reviewRequests",
  "author",
  "autoMergeRequest",
] as const;
export type GhDetailOptionalField = (typeof GH_DETAIL_OPTIONAL_FIELDS)[number];

/** `factory.gh_repos`の1行。`owner`と`repo`は小文字。 */
export type GhRepo = {
  readonly id: number;
  readonly owner: string;
  readonly owner_id: number;
  readonly repo: string;
  /** 一度も見えていない`not_visible`の行だけ`null`。 */
  readonly repo_id: number | null;
  readonly allowed: boolean;
  readonly default_branch: string | null;
  readonly archived: boolean;
  /** `allowed`が偽の行は`null`。 */
  readonly open_pr_count: number | null;
  readonly labeled_issue_count: number | null;
  readonly gone: boolean;
  readonly gone_reason: GhGoneReason | null;
  readonly listed_at: Date | null;
  /** 詳細を最後に取り終えた周回の、観測を始めた時刻。一度も無ければ`null`。 */
  readonly last_collected_at: Date | null;
  /** 詳細の結果を最後に書いた時刻。取る順の並びのキー。一度も着手していなければ`null`。 */
  readonly last_attempted_at: Date | null;
  /** 前回の着手が、ページの上限か件数の照合の不一致で打ち切られた。 */
  readonly truncated: boolean;
  /** 前回の着手が失敗した。 */
  readonly detail_failed: boolean;
};

/** 一覧に載ったリポジトリの書き込み。`owner`は呼び出し側が別に渡す。 */
export type GhRepoUpsert = {
  readonly repo: string;
  readonly repo_id: number;
  readonly allowed: boolean;
  readonly default_branch: string | null;
  readonly archived: boolean;
  readonly open_pr_count: number | null;
  readonly labeled_issue_count: number | null;
};

/** 一覧に載らなかったリポジトリの書き込み。 */
export type GhRepoGone = {
  readonly repo: string;
  readonly reason: "not_listed" | "not_visible";
};

/** 所有者ごとの、収集の最新の実行と、最後に先頭を担当した実行。 */
export type GhCollectOwnerState = {
  readonly owner: string;
  /** `finished_at`のある最新の行の結果。行が無ければ`null`。 */
  readonly latest: {
    readonly finished_at: Date;
    readonly ok: boolean;
    readonly error_code: GhCollectErrorCode | null;
    readonly next_allowed_at: Date | null;
  } | null;
  /** `led`が真で`finished_at`のある最新の実行の`started_at`。無ければ`null`。 */
  readonly last_led_at: Date | null;
};

/** 所有者ごとの、収集の鮮度の判定に使う記録。実行の無い所有者は、時刻と`latest`が`null`の行になる。 */
export type GhCollectFreshnessRow = {
  readonly owner: string;
  /** `ok`かつ`verified`で`finished_at`のある行の、最大の`finished_at`。 */
  readonly last_success_at: Date | null;
  /** `finished_at`のある最新の行。 */
  readonly latest: {
    readonly finished_at: Date;
    readonly error_code: GhCollectErrorCode | null;
    readonly next_allowed_at: Date | null;
  } | null;
  /** 最新の`started_at`の行が実行中(`finished_at`が空)なら、その`started_at`。 */
  readonly running_since: Date | null;
  /** 所有者の行の最古の`started_at`。 */
  readonly first_started_at: Date | null;
};

/** PRの詳細として書く値。`null`の列は不明で、偽や空を意味しない。 */
export type GhPullRequestWrite = {
  readonly number: number;
  readonly head_sha: string;
  readonly head_ref: string | null;
  readonly base_ref: string | null;
  readonly is_draft: boolean;
  readonly is_cross_repository: boolean;
  readonly auto_merge_enabled: boolean | null;
  readonly author_login: string | null;
  readonly author_type: GhAuthorType | null;
  readonly author_id: number | null;
  readonly mergeable: GhMergeable | null;
  readonly has_review_label: boolean | null;
  readonly has_fix_label: boolean | null;
  readonly review_requested_user_ids: readonly number[] | null;
  readonly assignee_ids: readonly number[] | null;
  readonly team_review_requested: boolean | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

/** `factory.gh_pull_requests`の1行。 */
export type GhPullRequest = GhPullRequestWrite & {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly repo_id: number;
  readonly state: GhPrState;
  readonly written_at: Date;
  readonly usable: boolean;
};

/**
 * 下流が鮮度と使ってよいかの判定に読む、`gh_repos`の列。
 * `repo_id`が`null`の行は、一度も見えていない`not_visible`の行である。
 */
export type GhRepoFreshnessRow = Pick<
  GhRepo,
  | "repo_id"
  | "allowed"
  | "archived"
  | "gone"
  | "last_collected_at"
  | "truncated"
  | "detail_failed"
>;

/**
 * 1つのリポジトリの`gh_repos`の行、開いているPRの行、DBの`now()`を、1つの文で読んだ結果。
 * `repo`が`null`なら、`gh_repos`に行が無い。
 */
export type GhRepoOpenPrSnapshot = {
  readonly db_now: Date;
  readonly repo: GhRepoFreshnessRow | null;
  readonly prs: readonly GhPullRequest[];
};

/** 所有者の単位で読んだ`gh_repos`の行。`repo`は小文字のリポジトリ名。 */
export type GhOwnerRepoFreshnessRow = GhRepoFreshnessRow & {
  readonly repo: string;
};

/**
 * 1人の所有者の`gh_repos`の全行、開いているPRの全行、DBの`now()`を、1つの文で読んだ結果。
 * 所有者の行が無ければ、`repos`と`prs`は空になる。
 */
export type GhOwnerOpenPrSnapshot = {
  readonly db_now: Date;
  readonly repos: readonly GhOwnerRepoFreshnessRow[];
  readonly prs: readonly GhPullRequest[];
};

/** Issueの詳細として書く値。 */
export type GhIssueWrite = {
  readonly number: number;
  readonly author_login: string | null;
  readonly author_type: GhAuthorType | null;
  readonly author_id: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

/** `factory.gh_issues`の1行。 */
export type GhIssue = GhIssueWrite & {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly repo_id: number;
  readonly state: GhIssueState;
  readonly written_at: Date;
  readonly usable: boolean;
};

/**
 * 詳細を取り終えた1つのリポジトリの書き込み。
 * `pr_rows`と`issue_rows`は書く行(差分)、`pr_keep`と`issue_keep`は今回の一覧の番号の全体で、載らない開いている行を閉じる判定に使う。
 * `observed_at`は、その周回の観測を始めた時刻で、`last_collected_at`に書く。
 */
export type GhRepoDetailWrite = {
  readonly owner: string;
  readonly repo: string;
  readonly repo_id: number;
  readonly observed_at: Date;
  readonly pr_rows: readonly GhPullRequestWrite[];
  readonly pr_keep: readonly number[];
  readonly issue_rows: readonly GhIssueWrite[];
  readonly issue_keep: readonly number[];
};

/** `writeGhRepoDetail`の結果。検査に通らない書き込みはDBに触れず、通らなかった項目の名前を返す。 */
export type GhRepoDetailWriteResult =
  | { readonly kind: "written" }
  | { readonly kind: "no_repo_row" }
  | { readonly kind: "rejected"; readonly field: string };

// ---------------------------------------------------------------------------
// 収集の詳細として保存する値の述語。例外を投げず、値を戻り値にも文にも含めない。
// ---------------------------------------------------------------------------

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** 40桁の小文字16進のコミットSHAか。 */
export function isGitSha(value: unknown): value is string {
  return typeof value === "string" && GIT_SHA_PATTERN.test(value);
}

/** 保存するブランチ名の長さの上限(UTF-8のバイト数)。 */
const STORED_REF_NAME_MAX_BYTES = 255;

/**
 * 制御文字、書式文字、行と段落の区切り、対になっていないサロゲート。
 * 表示を偽る文字と、UTF-8に直すと別の文字になる文字を保存しない。
 */
const STORED_REF_FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * 保存してよいブランチ名か。`isBranchName`を通り、UTF-8で255バイト以下で、
 * 制御文字、書式文字、行と段落の区切り、対になっていないサロゲートを含まない。
 * 通知やプロンプトに載りうる信頼できない入力なので、表示を偽る文字を保存しない。
 */
export function isStoredRefName(value: unknown): value is string {
  return (
    isBranchName(value) &&
    new TextEncoder().encode(value).length <= STORED_REF_NAME_MAX_BYTES &&
    !STORED_REF_FORBIDDEN_CHARACTERS.test(value)
  );
}

/** GitHubのloginの長さの上限。 */
const GITHUB_LOGIN_MAX_LENGTH = 39;

/** `isGitHubName`を通り、39文字以下のloginか。 */
export function isGitHubLogin(value: unknown): value is string {
  return isGitHubName(value) && value.length <= GITHUB_LOGIN_MAX_LENGTH;
}

/** GitHubの数値IDとして保存できる、正の安全な整数か。 */
export function isGitHubDatabaseId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOneOfValues<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && values.some((entry) => entry === value);
}

export function isGhAuthorType(value: unknown): value is GhAuthorType {
  return isOneOfValues(GH_AUTHOR_TYPES, value);
}

export function isGhMergeable(value: unknown): value is GhMergeable {
  return isOneOfValues(GH_MERGEABLE_VALUES, value);
}

export function isGhPrState(value: unknown): value is GhPrState {
  return isOneOfValues(GH_PR_STATES, value);
}

export function isGhIssueState(value: unknown): value is GhIssueState {
  return isOneOfValues(GH_ISSUE_STATES, value);
}

export function isGhCollectStage(value: unknown): value is GhCollectStage {
  return isOneOfValues(GH_COLLECT_STAGES, value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isIdArray(value: readonly number[] | null): boolean {
  return value === null || value.every(isGitHubDatabaseId);
}

function isNullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

/** 作者の3列の検査。loginと種別は、どちらもあるか、どちらも無いかのどちらか。通らない列の名前を返す。 */
function checkAuthorColumns(row: {
  readonly author_login: string | null;
  readonly author_type: GhAuthorType | null;
  readonly author_id: number | null;
}): string | null {
  const hasLogin = row.author_login !== null;
  if (hasLogin && !isGitHubLogin(row.author_login)) {
    return "author_login";
  }
  if (row.author_type !== null && !isGhAuthorType(row.author_type)) {
    return "author_type";
  }
  if (hasLogin && row.author_type === null) {
    return "author_type";
  }
  if (!hasLogin && row.author_type !== null) {
    return "author_login";
  }
  if (row.author_id !== null && !isGitHubDatabaseId(row.author_id)) {
    return "author_id";
  }
  return null;
}

/**
 * PRの行のすべての列を検査し、通らない最初の列の名前を返す。通れば`null`。
 * 例外を投げず、値を戻り値に含めない。
 */
export function checkGhPullRequestWrite(
  row: GhPullRequestWrite,
): string | null {
  if (!isGitHubDatabaseId(row.number)) {
    return "number";
  }
  if (!isGitSha(row.head_sha)) {
    return "head_sha";
  }
  if (row.head_ref !== null && !isStoredRefName(row.head_ref)) {
    return "head_ref";
  }
  if (row.base_ref !== null && !isStoredRefName(row.base_ref)) {
    return "base_ref";
  }
  if (typeof row.is_draft !== "boolean") {
    return "is_draft";
  }
  if (typeof row.is_cross_repository !== "boolean") {
    return "is_cross_repository";
  }
  if (!isNullableBoolean(row.auto_merge_enabled)) {
    return "auto_merge_enabled";
  }
  const author = checkAuthorColumns(row);
  if (author !== null) {
    return author;
  }
  if (row.mergeable !== null && !isGhMergeable(row.mergeable)) {
    return "mergeable";
  }
  if (!isNullableBoolean(row.has_review_label)) {
    return "has_review_label";
  }
  if (!isNullableBoolean(row.has_fix_label)) {
    return "has_fix_label";
  }
  if (!isIdArray(row.review_requested_user_ids)) {
    return "review_requested_user_ids";
  }
  if (!isIdArray(row.assignee_ids)) {
    return "assignee_ids";
  }
  if (!isNullableBoolean(row.team_review_requested)) {
    return "team_review_requested";
  }
  if (!isValidDate(row.created_at)) {
    return "created_at";
  }
  if (!isValidDate(row.updated_at)) {
    return "updated_at";
  }
  return null;
}

/** Issueの行のすべての列を検査し、通らない最初の列の名前を返す。通れば`null`。 */
export function checkGhIssueWrite(row: GhIssueWrite): string | null {
  if (!isGitHubDatabaseId(row.number)) {
    return "number";
  }
  const author = checkAuthorColumns(row);
  if (author !== null) {
    return author;
  }
  if (!isValidDate(row.created_at)) {
    return "created_at";
  }
  if (!isValidDate(row.updated_at)) {
    return "updated_at";
  }
  return null;
}

/** 番号の並びが、正の整数で重ならないか。 */
function hasUniqueIds(numbers: readonly number[]): boolean {
  return (
    numbers.every(isGitHubDatabaseId) &&
    new Set(numbers).size === numbers.length
  );
}

/**
 * 1つのリポジトリの書き込みの全体を検査し、通らない最初の項目の名前を返す。通れば`null`。
 * 各行の検査に加えて、行の番号が重ならないこと、行の番号が`keep`に含まれること(同じ行を2つの文で変えないため)、
 * `keep`の番号が正の整数で重ならないことを確かめる。
 */
export function checkGhRepoDetailWrite(
  write: GhRepoDetailWrite,
): string | null {
  if (!isGitHubName(write.owner)) {
    return "owner";
  }
  if (!isGitHubName(write.repo)) {
    return "repo";
  }
  if (!isGitHubDatabaseId(write.repo_id)) {
    return "repo_id";
  }
  if (!isValidDate(write.observed_at)) {
    return "observed_at";
  }
  for (const row of write.pr_rows) {
    const column = checkGhPullRequestWrite(row);
    if (column !== null) {
      return `pr_rows.${column}`;
    }
  }
  for (const row of write.issue_rows) {
    const column = checkGhIssueWrite(row);
    if (column !== null) {
      return `issue_rows.${column}`;
    }
  }
  if (!hasUniqueIds(write.pr_keep)) {
    return "pr_keep";
  }
  if (!hasUniqueIds(write.issue_keep)) {
    return "issue_keep";
  }
  const prNumbers = write.pr_rows.map((row) => row.number);
  if (new Set(prNumbers).size !== prNumbers.length) {
    return "pr_rows.number";
  }
  const issueNumbers = write.issue_rows.map((row) => row.number);
  if (new Set(issueNumbers).size !== issueNumbers.length) {
    return "issue_rows.number";
  }
  const prKept = new Set(write.pr_keep);
  if (!prNumbers.every((number) => prKept.has(number))) {
    return "pr_rows.not_kept";
  }
  const issueKept = new Set(write.issue_keep);
  if (!issueNumbers.every((number) => issueKept.has(number))) {
    return "issue_rows.not_kept";
  }
  return null;
}

/** 収集の実行1行(所有者ごと)の終わりに書く内容。 */
export type GhCollectRunOutcome = {
  readonly ok: boolean;
  readonly owner_id: number | null;
  readonly verified: boolean;
  readonly id_checked: boolean | null;
  readonly cost: number | null;
  readonly requests: number;
  readonly remaining: number | null;
  readonly error_code: GhCollectErrorCode | null;
  readonly next_allowed_at: Date | null;
  /** その周回で最初に要求を送った所有者の行だけ真。結果は問わない。要求が1回も無い行は偽。 */
  readonly led: boolean;
  /** `error_code`が生じた段。成功の行は`null`。 */
  readonly stage: GhCollectStage | null;
  /** 詳細を取る対象のリポジトリの数。 */
  readonly detail_targets: number;
  /** 詳細の要求の数。ページ送りと分割を含む。 */
  readonly detail_requests: number;
  /** 詳細を取り終えて書いたリポジトリの数。 */
  readonly detail_done: number;
  /** 詳細が打ち切りか失敗になったリポジトリの数。 */
  readonly detail_incomplete: number;
};

// ---------------------------------------------------------------------------
// factory_config(リソース`f/factory/factory_config`、型`c_factory_config`)
// ---------------------------------------------------------------------------

export type FactoryOwnerKind = "user" | "org";

export type FactoryOwner = {
  name: string;
  kind: FactoryOwnerKind;
  /**
   * GitHubのアカウントの数値ID(正の整数)。
   * 指定すると、`poll_issues`と`poll_prs`が検索の前に現在のIDと照合する。
   * 作業項目を進める準備のステップも、リポジトリを取得する前に、リポジトリのオーナーのIDを照合する。
   * オーナーが改名し、別の人がその名前を取得した場合に、その人のIssueとPRを検索の候補に入れず、保存済みの作業項目も進めないため。
   * 省略すると、名前だけで照合する。
   */
  id?: number;
};

export type LabelerAssociation = "OWNER" | "MEMBER" | "COLLABORATOR";

/**
 * `review_post_mode`の値。
 * `"gated"`では、`pr_review_post.ts`がレビューを記録するだけでGitHubに投稿しない。
 * 承認を経て投稿する仕組みはまだ無い。
 */
export type ReviewPostMode = "comment_only" | "gated";

/**
 * `gh_source_dependabot`と`gh_source_pr_conflict_watch`の値。下流のscriptが候補のPRを列挙する元で、
 * `search`は検索API、`db`は収集が書いた表を指す。
 */
export type GhSource = "search" | "db";

/** 投稿しなかったレビューの集計。`since`は、その最初のレビューの記録時刻。 */
export type GatedReviewStats = {
  readonly since: Date | null;
  readonly unposted_count: number;
};

/**
 * 日次のまとめと通知の判定に使う、投稿しない状態の報告。
 * `off`は投稿するモードで、何も載せない。`read_failed`は集計を読めなかったこと。
 * 型だけをここに置くのは、日次のまとめの文面を作る側が、判定の関数に依存せずに済むため。
 */
export type GatedReviewReport =
  | { readonly kind: "off" }
  | {
      readonly kind: "on";
      readonly since: Date | null;
      readonly unposted_count: number;
      /** `since`からの経過の日数(切り捨て)。投稿しなかったレビューが無ければ`null`。 */
      readonly elapsed_days: number | null;
    }
  | { readonly kind: "read_failed" };

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
  /**
   * `allowed_labeler_logins`のうち、GitHubの数値IDも照合するアカウント。キーがログイン名、
   * 値が数値IDである。載せたアカウントは、同じ名前でもIDが違う人が付けたラベルを許可しない。
   * 載せないアカウントは名前だけで照合する。
   */
  allowed_labeler_ids: Record<string, number>;
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
   * `factory_repo`のGitHubリポジトリの数値ID(正の整数)。
   * 指定すると、Factory自身のcloneを使う処理が取得の前に現在のIDと照合し、食い違うときは取得しない。
   * オーナーが改名して別の人がその名前を取得しても、その人のリポジトリを使わないため。
   * 省略すると、名前だけで取得する。
   */
  factory_repo_id?: number;
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
  // dependabotのセキュリティ更新PRの自動処理。リソース型ではどちらも省略可能で、既定値がある。
  /** dependabotのセキュリティ更新PRを自動で処理するか。既定は`false`。 */
  dependabot_enabled: boolean;
  /**
   * dependabotのフローがマージしてよいか。既定は`false`。
   * 偽の間は、マージできると判断したPRもマージせず、人に回す(試運転)。
   */
  dependabot_merge_enabled: boolean;
  /** 更新先の版が公開されてから、マージしてよくなるまでの日数。正の整数。 */
  dependabot_min_published_days: number;
  /**
   * `watch_pr_ci`がFactoryのPRのCIを観測して通知するか。
   * 観測と通知だけで、PRにもリポジトリにも書き込まない。既定は`true`。
   * `false`でも、直す作業項目が終わった行を戻す回復は動く。回復はオーナーの照合をせず、照合に伴う通知は足さない。
   * ただし、回復がPRを読めず403か404になると、権限の不足の通知は足しうる。判定が動かない間は、解決されない。
   */
  pr_ci_watch_enabled: boolean;
  /**
   * `watch_pr_ci`が、許可された人が作ったPR(開いていて、下書きでなく、forkでなく、Factoryが作っていないもの)のCIの失敗も通知するか。
   * 通知だけで、直す作業項目は起動しない。既定は`false`。
   * 許可された人は、PATのアカウントと`allowed_labeler_logins`のアカウントである。
   * `pr_ci_watch_enabled`が偽のときは、発見も通知もしない。
   */
  pr_ci_watch_human_prs: boolean;
  /**
   * CIの失敗を直す作業項目を、`watch_pr_ci`が起動してよいか。既定は`false`で、偽の間は何も起動しない。
   * 真にするには`pr_ci_fix_enabled_since`が要る。`pr_ci_watch_enabled`が偽のときも起動しない。
   */
  pr_ci_fix_enabled: boolean;
  /**
   * 1つのPRで、CIの失敗を直すラウンドを起動できる回数の上限。1以上10以下の整数。既定は2。
   * 直近に通ったheadより後のラウンドを数え、通ると数え直す。
   */
  pr_ci_fix_max_rounds: number;
  /**
   * この時刻より前に見つけた失敗は、直す対象にしない。「見つけた時刻」は`pr_ci_checks.first_seen_at`で、
   * 比較は`Date`かSQLのtimestamptzで行い、文字列では比べない。
   * 設定には秒まで書いたRFC 3339の日時(タイムゾーン付き)を書き、読み込み後は`Date`になる。
   * `pr_ci_fix_enabled`が真なら`null`にできない。無いと、有効にする前から残る失敗まで、一度に直しに行くためである。
   * 既定は`null`。
   */
  pr_ci_fix_enabled_since: Date | null;
  /**
   * `watch_pr_conflicts`が、FactoryのPRのマージの競合を検知して通知するか。既定は`false`。
   * 検知と通知だけで、PRにもリポジトリにも書き込まない。偽の間は、GitHubもDBも読まず、何も書かない。
   * `pr_ci_watch_enabled`には依らない。
   */
  pr_conflict_watch_enabled: boolean;
  /**
   * 競合を直す作業項目を、`watch_pr_conflicts`が起動してよいか。既定は`false`で、偽の間は何も起動せず、通知の挙動は変わらない。
   * 真にするには`pr_conflict_watch_enabled`も真で、`pr_conflict_fix_enabled_since`が要る。
   */
  pr_conflict_fix_enabled: boolean;
  /**
   * 競合の1回(episode)で、競合を直す作業項目を起動できる回数の上限。1以上5以下の整数。既定は2。
   */
  pr_conflict_fix_max_rounds: number;
  /**
   * 1つのPRで、競合を直す作業項目を起動できる回数の上限。2以上10以下の整数。`pr_conflict_fix_enabled`が真なら、`pr_conflict_fix_max_rounds`より大きくなければならない。既定は5。
   * 競合の行が掃除で消えても戻らないよう、競合の回数はepisodeを超えて数える。
   */
  pr_conflict_fix_max_rounds_per_pr: number;
  /**
   * この時刻より前に始まった競合の回は、直す対象にしない。基準は`pr_conflict_checks.episode_started_at`。
   * 設定には秒まで書いたRFC 3339の日時(タイムゾーン付き)を書き、読み込み後は`Date`になる。
   * `pr_conflict_fix_enabled`が真なら`null`にできない。既定は`null`。
   */
  pr_conflict_fix_enabled_since: Date | null;
  /**
   * 競合の回の開始から通知を待つ時間(分)。0以上1440以下の整数。既定は60。
   * `pr_conflict_fix_enabled`が真なら、10以上でなければならない。巡回の間隔は5分で、0だと最初の巡回から通知が先に出て、起動の判断が一度も回らない。
   * 過ぎれば、保留のままでも、保留が無くても通知する。最終の保留は待たずに通知する。
   */
  pr_conflict_fix_notify_grace_min: number;
  /**
   * `collect_github`が、`owners`の所有者のリポジトリの状態をGitHubから集めてDBに書くか。既定は`false`。
   * `false`の間は、トークンを読まず、行も書かずに終わる。読み取り専用のトークンを入れてから、リモートのリソースで有効にする。
   */
  gh_collect_enabled: boolean;
  /**
   * `collect_github`が、リポジトリの一覧に続けて、開いているPRとトリガーラベル付きのIssueの詳細を集めてDBに書くか。既定は`false`。
   * `false`の間は、詳細の要求を送らず、一覧の下限も変えない。`gh_collect_enabled`が`false`なら、この値によらず何もしない。
   */
  gh_collect_detail_enabled: boolean;
  /**
   * `poll_dependabot`が候補のPRを列挙する元。既定は`search`。
   * `db`にしても、`gh_collect_enabled`と`gh_collect_detail_enabled`のどちらかが偽なら、収集の記録が進まないので周回全体が検索になる。
   */
  gh_source_dependabot: GhSource;
  /**
   * `watch_pr_conflicts`がリポジトリの発見とPRの列挙を行う元。既定は`search`。
   * `db`にしても、`gh_collect_enabled`と`gh_collect_detail_enabled`のどちらかが偽なら、周回全体が検索とREST一覧になる。
   */
  gh_source_pr_conflict_watch: GhSource;
  /**
   * `sample_worker_load`がメモリの通知を出す割合。`mem_anon_bytes / mem_limit_bytes`がこの値以上のとき通知する。
   * 0を超え1以下。既定は0.8。
   */
  worker_alert_memory_ratio: number;
  /**
   * リポジトリごとの検査コマンド(`"<owner>/<repo>": string[]`)。
   * implementフローはこれだけを実行する(`config.ts`の
   * `implementCheckCommandsFor`)。エントリの無いリポジトリでは
   * 検査コマンドを実行しない。
   * 一方、`checkCommandsFor`は`allowed_check_commands`にフォールバックする。
   */
  check_commands_by_repo: Record<string, string[]>;
};

/** 実装ブランチ名(`factory/issue-<N>-wi-<id>`)から作業項目のIDを返す。形が違えばnull。pr_fixが、親の行が無くても同じブランチの実装フローを見つけるのに使う。PRのCIの判定も、Factoryのブランチかの照合に使う。 */
export function parseImplementBranchWorkItemId(branch: string): number | null {
  const match = /^factory\/issue-[1-9]\d*-wi-([1-9]\d*)$/.exec(branch);
  const id = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
