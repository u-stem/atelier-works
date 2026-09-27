# アーキテクチャ

## 概要

Software FactoryはGitHub Issueを起点に、要件定義から自己改善までをWindmill上のフローとして自動化する仕組みである。

主なコンポーネント:

- **GitHub**: Issueの起票・ラベル付け・PR・コメントのやり取り先。`factory`ラベルが付いたIssueが入力になる。
- **Windmill server / worker**: フローとスケジュールの実行基盤。workerはカスタムイメージで動き、`claude`(Claude Code CLI)、`gh`、`gtr`(git worktree runner)、`wmill`を同梱する。workerはdefaultワーカーグループの1コンテナで、`NUM_WORKERS=3`により内部で3つのワーカープロセスが並列動作する(メモリ上限は1コンテナ分の4096Mのまま)。
- **Data Tables**: 作業の状態・要件定義ドラフト・承認履歴・実行ログ・失敗記録などを保持するPostgresベースのテーブル群。
- **App(ダッシュボード)**: 承認Inbox、要件定義書の一覧・全文表示(Confluenceの文書ページに近い見た目、図はインライン描画)、パイプラインの一覧、コスト等の分析、失敗の再実行、通知一覧を提供するUI。
- **Discord**: 各イベント(拾い上げ、承認待ち、承認、却下、要対応、失敗など)をWebhook経由で通知する。

## パイプライン(工程1 → 5)

実装済みは工程1(作業を拾う)、工程2(要件定義の生成と承認・差し戻し)、工程3の一部(PRレビュー・修正)、
ダッシュボード(Factory Console)、自己更新と失敗ハンドラ。工程3の「Issueから実装してPRを作る」、
工程4・5は拡張点として後続で実装予定。

| 工程 | 内容 | 状態 |
| --- | --- | --- |
| 1. 拾う | `factory`ラベル付きIssueを検知してclaimする | 実装済み |
| 2. 要件定義 | headless Claudeが要件定義ドラフトを生成し、人が承認・差し戻しする | 実装済み |
| 3. 実装 | worktree上で実装しPRを作成する | 未実装(拡張点) |
| 3. PRレビュー・修正 | 既存PRをレビュー・修正する(`pr_review` / `pr_fix`) | 実装済み |
| 4. CI監視 | マージ後のCIを監視する | 未実装(拡張点) |
| 5. 自己改善 | 失敗や却下の履歴から改善提案をIssue化する | 未実装(拡張点) |

```mermaid
flowchart TD
    A[Issue に factory ラベル] --> B[poll_issues が検知して claim]
    B --> C[pipeline.flow 起動]
    C --> D[generate_requirements: headless Claude が要件定義ドラフトを生成]
    D --> E[request_approval: approval_requests へ pending 行を記録して終了]
    E --> J[人が Console で承認 / 却下]
    J -->|approve| F[Issue に Console リンクを1件投稿]
    J -->|reject| G{再試行回数 < 上限}
    G -->|yes| D
    G -->|no| H[needs_human]
    E -->|poll_issuesの期限切れ判定| I[expired]
```

承認は`approval_requests`テーブルの`pending`行で待つ(Windmillのsuspendステップは使わない)。`request_approval`ステップは`kind = 'requirements'`の`pending`行を記録して即座に終了し、フロー自体はそこで完了する。人がConsoleから承認 / 却下すると`approval_decide`が決定を`approval_requests`へ記録し(`decideApprovalRequestIfPending`による楽観ロック)、`kind`に応じたapplyスクリプト(`steps/requirements_apply` / `steps/issue_proposal_apply`)を`runScriptByPathAsync`で起動して実際の反映処理を行う。期限(7日、`approval_requests.expires_at`)は`poll_issues`のreconcile後に行う期限切れスイープが判定し、`expired`への遷移と通知を行う。

工程2の要件定義書はテンプレート(`.claude/skills/factory-requirements/template.md`)を単一の正とし、生成物は`requirements_doc`で機械検査する。headless ClaudeのカレントディレクトリはIssue単位・試行単位の要件定義ファイル置き場(`/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<work_item_id>/attempt-<attempt>/`、workerコンテナ専用のvolumeでコミットしない)そのものであり、`requirements.md`(テンプレートのコピー)を`Edit`で埋め、図があれば`<name>.drawio`を`Write`で書く。対象リポジトリのworktreeは`--add-dir`で読み取り専用に見せるだけで、カレントディレクトリにはしない。構造化出力は`{summary, open_questions}`に縮小し、本文と図は生成後にファイルから読み戻して検査・保存する(`f/factory/steps/pipeline_generate.ts`)。Factory ConsoleのbackendランナブルもCLIワーカーと同じworkerコンテナ(defaultワーカーグループ)で同じvolumeを読む前提であり、workerを複数コンテナに分ける場合は共有ストレージが必要になる。Console側の接続は`f/factory/steps/console_query.ts`の`requirements_doc`ビュー(query view。`f/factory/lib/requirements_doc.ts`の生成物検査ロジックとは別物)が`doc_dir`から`requirements.md`と各図のファイルを読み戻し、raw appの`components/RequirementsDocument.tsx` / `Markdown.tsx` / `DrawioViewer.tsx`がConfluenceの文書ページに近い見た目で本文・目次・図をインライン描画する形で実装済み(要件定義タブ、およびInboxタブの要件定義詳細の双方から使う)。`doc_dir`が読めない場合(pre-2026-09-27の行など)はDBの`markdown`列にフォールバックする。

## 状態遷移(work_items.status)

```mermaid
stateDiagram-v2
    [*] --> picked
    picked --> requirements_generating
    requirements_generating --> awaiting_approval
    awaiting_approval --> approved
    awaiting_approval --> rejected
    rejected --> requirements_generating: attempt+1
    awaiting_approval --> expired: poll_issuesの期限切れスイープ(7日)
    picked --> needs_human
    requirements_generating --> needs_human
    rejected --> needs_human: 試行上限超過
    picked --> failed
    requirements_generating --> failed
    picked --> cancelled: Issueがclosed
    requirements_generating --> cancelled: Issueがclosed
    awaiting_approval --> cancelled: Issueがclosed
    approved --> implementing: 工程3(未実装、拡張点)
    implementing --> requirements_generating: gap(工程3実装からのgap、未実装、attempt+1)
    implementing --> pr_open
    approved --> requirements_generating: gap(pr_fixのrequirements_gap、parent_work_item_id経由、attempt+1)
    [*] --> reviewing: PRレビュー起動(kind=pr_review)
    reviewing --> reviewed
    reviewing --> cancelled: PRがclosed/merged
    [*] --> fixing: PR修正起動(kind=pr_fix)
    fixing --> rereview_requested
    fixing --> blocked
    fixing --> requirements_generating: requirements_gap(親Issueが存在、attempt+1)
    fixing --> needs_human: requirements_gap(元Issueが分からない場合)
    fixing --> cancelled: PRがclosed/merged
    blocked --> needs_human
    needs_human --> [*]
    failed --> [*]
    expired --> [*]
    cancelled --> [*]
    reviewed --> [*]
    rereview_requested --> [*]
```

### status一覧

| status | 意味 | 工程 |
| --- | --- | --- |
| `picked` | Issueをclaimした直後 | 1 |
| `requirements_generating` | 要件定義ドラフトを生成中 | 2 |
| `awaiting_approval` | 承認Inboxで承認待ち | 2 |
| `approved` | 要件定義が承認された | 2 |
| `rejected` | 却下され再生成待ち(attempt+1) | 2 |
| `needs_human` | 自動処理を打ち切り人の対応が必要(試行上限超過、requirements_gapの元Issue不在、等) | 2/PRワークフロー |
| `failed` | 実行時エラーで失敗 | 1/2 |
| `expired` | 承認タイムアウト(7日、`poll_issues`の期限切れスイープが判定) | 2 |
| `cancelled` | Issueがclosed | 1/2 |
| `implementing` | 実装中(worktree上で実装 → レビュー → PR作成) | 3(未実装、拡張点) |
| `pr_open` | 実装が完了しPRを作成した | 3(未実装、拡張点) |
| `reviewing` | PRレビューを実行中(`kind=pr_review`) | PRワークフロー |
| `reviewed` | PRレビューをCOMMENTとして投稿済み(終端、`kind=pr_review`) | PRワークフロー |
| `fixing` | レビュー指摘・コメントの修正を実行中(`kind=pr_fix`) | PRワークフロー |
| `rereview_requested` | 修正をpushし再レビューを依頼した(終端、`kind=pr_fix`) | PRワークフロー |
| `blocked` | 禁止された変更パターンの検出、差分上限超過、または安全策の前提が崩れて中断(`kind=pr_fix`) | PRワークフロー |

**Issue・PR共通(2026-09-27方針変更)**: トリガーラベル(Issueの`factory`、PRの`factory:review` / `factory:fix`)はclaim時(Issueはassignee付与直後、PRはトリガーラベル自体の削除直後)に一度だけ消費する。以降のどの状態遷移(終端遷移を含む)でもIssue / PR側のラベルは付け外ししない — 状態は`work_items.status`のみが正で、GitHubのラベルは「人からFactoryへのトリガー」の役割に限定される。`retry_work_item`のように終端statusから再起動する経路も、`runFlowAsync`を呼ぶだけでラベルの再付与は行わない。最初からやり直すには人が改めてトリガーラベルを付け直す(新しいcycle)。

PRは終端statusになってもトリガーラベルの消費以外の付け外しが起きないため、再発見はGitHub検索(`searchPrs`)ではなくDB(`work_items`)側で行う: `poll_prs`の`listTrackedPrs`が`kind IN ('pr_review', 'pr_fix')`かつ`status != 'cancelled'`かつ`tracked_pr_days`(既定30日、`factory_config`)以内に更新された行を再発見し、そのPRがまだopenであることを`getPr`で確認してから候補にする。人が新しいcommitをpushすれば(pr_reviewの場合)、または改めてトリガーラベルを付け直せば、この再発見経路から自動的に次のサイクルが始まる。

### 状態遷移の詳細

**工程2 (要件定義)から工程3へ:**
- `approved` → `implementing`(工程3実装ステップで実装を試みる)。
- `implementing` → `requirements_generating: gap`(工程3実装ステップが`requirements_gap`を返した場合、attempt+1で要件定義を再生成。状態遷移図では省略)。

**PRワークフローの`requirements_gap`:**
- `pr_fix`フロー実行中に`outcome: "requirements_gap"`が返された場合、`parent_work_item_id`で元Issueのwork itemを特定する。
- 元Issueが存在する場合、そのwork itemを`requirements_generating`にattempt+1で再起動(issueの工程2に戻す)。
- 元Issueが見つからない場合(PRがfactory製ではなくmanualで投入された場合など)は`needs_human`に遷移。

## データモデル

Data Tablesはスキーマ`factory`に置く。migrationは追加のみで、renameは禁止する(列定義の詳細はmigrationファイル自体を正とする)。

### テーブル

| テーブル | 役割 |
| --- | --- |
| `work_items` | Issue単位の作業状態。`(owner, repo, issue_number, cycle)`で一意 |
| `work_item_events` | 状態遷移のイベント履歴 |
| `requirement_drafts` | 要件定義ドラフト(markdown、図の参照`{name, file}`、未確定事項、`doc_dir`)。attemptごとに保存。図のXML自体はDBではなく`doc_dir`配下のファイルにある |
| `approvals` | 旧テーブル。過去の承認・却下履歴のみを保持し、新規の書き込みはない(`approval_requests`に統一済み) |
| `agent_runs` | Claude実行1回ごとのログ(トークン数、コスト、所要時間、終了コード等) |
| `job_failures` | フロー実行時のエラー(トークンはマスク済み) |
| `deployments` | self_updateによるデプロイ結果 |
| `notices` | 要対応事項(ホスト操作要、PAT失効、SHA不一致など) |
| `issue_proposals` | pr_fixの`propose_issue`返信が提案するIssue(title / body)と、その承認 / 却下の判断履歴。`title` / `body` / `review_comment_id` / `thread_id`の一次情報源(`approval_requests`はこれらを複製しない) |
| `approval_requests` | 承認依頼の汎用テーブル。`kind`は`requirements`(要件定義承認、`subject_id`は`requirement_drafts.id`)/ `issue_proposal`(Issue化提案、`subject_id`は`issue_proposals.id`)、`status`は`pending` / `approved` / `rejected` / `expired`。`approval_decide`が読み書きする唯一のテーブルで、suspendベースの承認と`approvals`テーブルへの書き込みを置き換えた |
| `cleanup_runs` | `cleanup_db`が実行するたびの削除件数の記録(work item・失敗記録・デプロイ記録・通知など) |

### view(Appはこれらのみを参照する)

`v_inbox`、`v_pipeline`、`v_agent_cost_daily`、`v_approval_stats`、`v_lead_time`、`v_failures`、`v_notices`、`v_issue_proposals`、`v_approval_requests`

## フローとスケジュール

| 名称 | 種別 | 概要 |
| --- | --- | --- |
| `poll_issues` | schedule(5分毎) | Issueの検知・claim・reconcile(closed検知、孤児ジョブ検知)・再投入検出・承認依頼の期限切れスイープ |
| `manual_intake` | flow(フォーム起動) | フォーム入力からIssueを作成し同じパイプラインに乗せる |
| `pipeline` | flow | 要件定義生成 → 承認依頼の記録(`approval_requests`)。承認 / 却下 / タイムアウトの分岐はフロー外(`approval_decide`とpoll_issuesの期限切れスイープ)で行う |
| `self_update` | schedule(10分毎) | self cloneをpullし、変更があれば`wmill sync push`とmigrationを適用する |
| `cleanup_workspaces` | schedule(毎日03:00) | 期限切れworktreeの削除、古いtranscriptの削除 |
| `cleanup_db` | schedule(毎日03:30) | 保持期限を過ぎたDBのレコード(終端状態の作業項目とその関連データ、失敗記録・デプロイ記録・解決済みの通知)の削除 |
| `daily_summary` | schedule(毎日09:00) | 前日のコスト・件数・失敗・DB掃除件数をDiscordに通知 |

各scheduleのcronはタイムゾーン`Asia/Tokyo`、Windmillの6フィールド形式で`*.schedule.yaml`に持つ。多重実行防止はadvisory lockを使わず、各scheduleの`no_flow_overlap: true`で行う(前回実行中はスキップする)。複数インスタンスを同時運用する場合の排他はWindmill側ではなくGitHub側のclaim(Issueはassignee付与、PRはトリガーラベルの消費。いずれも再取得して確認する)で担保する。error handlerで失敗を記録し、すべてのフロー(pipeline / pr_review / pr_fix)の`failed`終端処理(Discord通知。ラベルはclaim時に既に消費済みのため除去は行わない)は`on_error_flow`に一本化される。承認のタイムアウト(7日)は`poll_issues`のreconcile後に行う期限切れスイープが`approval_requests.expires_at`を見て判定する(`pipeline.flow`はsuspendを使わない)。

## 命名規則

WindmillのUIはsummaryでソートされるため、種別を示すタグをsummaryの先頭に付ける(pathは英数字のみに固定し変更しない)。

| タグ形式 | 対象 |
| --- | --- |
| `[SF-<工程>-<順>] <日本語の表示名>` | 自動フロー / schedule |
| `[SF-<工程>-<順>/<n>] <日本語>` | フロー内ステップscript |
| `[OP-<工程>-<順>] <日本語>` | 人がUIから手動実行するもの |
| `[SYS-<順>] <日本語>` | 基盤・運用の自動処理 |
| `[LIB] <日本語>` | 共有ライブラリ |

工程番号は1=作業を拾う、2=要件定義、3=実装・PR、4=CI監視、5=自己改善に対応する。

### 割り当て表

| path | summary |
| --- | --- |
| `f/factory/poll_issues`(script + schedule) | `[SF-1-1] Issue を巡回して担当を確定` |
| `f/factory/poll_prs`(script + schedule) | `[SF-1-2] PR を巡回してレビュー / 修正を起動` |
| `f/factory/manual_intake__flow` | `[OP-1-1] 手動投入フォーム(Issue を作成して工程に乗せる)` |
| `f/factory/steps/manual_intake_create_issue` | `[OP-1-1/1] Issue を作成` |
| `f/factory/steps/manual_intake_register` | `[OP-1-1/2] 作業項目を登録して工程 2 を起動` |
| `f/factory/pipeline__flow` | `[SF-2-1] 要件定義の生成と承認` |
| `f/factory/steps/pipeline_prepare` | `[SF-2-1/1] 作業領域の準備` |
| `f/factory/steps/pipeline_generate` | `[SF-2-1/2] 要件定義の生成(Claude)` |
| `f/factory/steps/pipeline_request_approval` | `[SF-2-1/3] 承認依頼` |
| `f/factory/steps/requirements_apply` | `[SF-2-2] 要件定義の承認結果を反映` |
| `f/factory/approval_decide` | `[OP-2-1] 承認 / 差し戻しを記録して反映` |
| `f/factory/retry_work_item` | `[OP-2-2] 作業項目を再実行` |
| `f/factory/pr_review__flow` | `[SF-3-1] PR の自動レビュー` |
| `f/factory/steps/pr_review_prepare` | `[SF-3-1/1] PR の取得と検証` |
| `f/factory/steps/pr_review_generate` | `[SF-3-1/2] レビューの生成(Claude)` |
| `f/factory/steps/pr_review_post` | `[SF-3-1/3] レビューの投稿` |
| `f/factory/pr_fix__flow` | `[SF-3-2] レビュー指摘の修正と再レビュー依頼` |
| `f/factory/steps/pr_fix_prepare` | `[SF-3-2/1] worktree の準備と安全確認` |
| `f/factory/steps/pr_fix_collect` | `[SF-3-2/2] 指摘の収集` |
| `f/factory/steps/pr_fix_apply` | `[SF-3-2/3] 修正の適用(Claude)` |
| `f/factory/steps/pr_fix_verify` | `[SF-3-2/4] 変更の検証` |
| `f/factory/steps/pr_fix_finish` | `[SF-3-2/5] push と再レビュー依頼` |
| `f/factory/steps/issue_proposal_apply` | `[SF-3-3] Issue化提案の承認結果を反映` |
| `f/factory/steps/pr_workflow_support` | `[LIB] PR ワークフロー共通処理` |
| `f/factory/self_update`(script + schedule) | `[SYS-1] Software Factory 自身を最新化` |
| `f/factory/cleanup_workspaces`(script + schedule) | `[SYS-2] 作業領域を掃除` |
| `f/factory/notify_daily_summary`(script + schedule) | `[SYS-3] 日次サマリ通知` |
| `f/factory/on_error_flow` | `[SYS-4] フロー失敗ハンドラ` |
| `f/factory/on_error_schedule` | `[SYS-5] schedule 失敗ハンドラ` |
| `f/factory/cleanup_db`(script + schedule) | `[SYS-6] DB を掃除` |
| `f/factory/lib/config` | `[LIB] 設定の読み込み` |
| `f/factory/lib/db` | `[LIB] Data Table アクセス` |
| `f/factory/lib/github` | `[LIB] GitHub API ラッパー` |
| `f/factory/lib/workspace` | `[LIB] git worktree と作業領域` |
| `f/factory/lib/claude` | `[LIB] headless Claude 実行` |
| `f/factory/lib/drawio` | `[LIB] draw.io 図の生成` |
| `f/factory/lib/discord` | `[LIB] Discord 通知` |
| `f/factory/lib/log` | `[LIB] ログとマスク` |
| `f/factory/lib/prompts` | `[LIB] プロンプト定義` |
| `f/factory/lib/types` | `[LIB] 共通型` |
| `f/factory/lib/poll_support` | `[LIB] 巡回の純粋ロジック` |
| `f/factory/lib/summary_support` | `[LIB] 日次サマリの集計` |
| `f/factory/lib/approval_support` | `[LIB] 承認依頼の純粋ロジック` |
| `f/factory/factory_console__raw_app` | `[OP-0-1] Factory Console(承認・進捗・分析)` |
| `f/factory/steps/console_query` | `[OP-0-1/1] Console 用データ取得` |
| `f/factory/lib/self_update_support` | `[LIB] 自己更新の純粋ロジック` |
| `f/factory/lib/cleanup_support` | `[LIB] 作業領域掃除の純粋ロジック` |
| `f/factory/lib/requirements_template` | `[LIB] 要件定義テンプレートの定義` |
| `f/factory/lib/requirements_doc` | `[LIB] 要件定義ファイルの検査` |
| `f/factory/lib/cleanup_db_support` | `[LIB] DB 掃除の純粋ロジック` |

## PRワークフロー(pr_review / pr_fix)

工程1→2(Issueの要件定義)とは別に、既存のPR(人が作ったPR、または将来factory自身が作るPR)をレビュー・修正するワークフローを持つ。

- **起動条件**:
  - `pr_review`: PRに`factory:review`ラベルが付与されたとき(claim時にラベルを消費)、またはPRのreview-requested / assigneeがこのインスタンスのGitHubアカウントで、`head_sha`が未処理のとき(このパスはラベルを伴わないため消費するものがない)。
  - `pr_fix`: PRに`factory:fix`ラベルが付与されたとき(claim時にラベルを消費)。修正への指示は、ラベルを付ける前にPRへ通常のコメントとして書いておく(他の人間のコメントと同様にフィードバックとして収集される)。
- **自己再発火の防止**: factoryが投稿するIssueコメント・PRレビュー・レビュー返信には必ずmarker(`<!-- factory:<kind>:<work_item_id> -->`)を埋め込む。GitHub上の自分のログイン名と一致する投稿、またはmarker付きの投稿は「人間の入力」として扱わず、起動条件の判定から除外する。
- **作業ディレクトリ**: `/workspaces/<owner>/<repo>/main`はfetch専用(working treeをcheckoutしない)。
  - `pr_review`は`git worktree add --detach /workspaces/<owner>/<repo>/review-<pr>-<sha7> <sha>`でPRごとのdetached worktreeを使い、終了時に削除する。
  - `pr_fix`は`git gtr new`で作るPRブランチのworktreeを使う。
- **pr_review**: PR本文・差分・変更ファイル一覧(factory製PRなら承認済み要件も)を入力にレビューし、結果は常にGitHubのCOMMENTレビューとして投稿する(スキル内部の`verdict`は記録用で、投稿種別には反映しない)。完了すると`reviewed`(終端)。
- **pr_fix**: レビュー指摘・未解決コメント・要件を入力に修正し、push後に各コメントへ返信して再レビューを依頼する(`rereview_requested`)。要件変更が必要な場合は自分で要件や設計を書き換えず`requirements_gap`として中断し、元Issueのwork item(`parent_work_item_id`で紐付け)を`requirements_generating`にattempt+1で戻す。安全策の詳細は [docs/security.md](security.md)を参照。
- **propose_issue(Issue化提案、ユーザー決定2026-09-26)**: pr_fixの各返信は`fixed` / `skipped`に加え`propose_issue`を選べる。指摘は妥当だがこのPRの範囲外という判断で、Claudeは修正を強行せずIssueのtitle/bodyを`factory.issue_proposals`に記録する(`pr_fix_finish`が挿入し、レビューコメントのthread idを`listReviewThreads`でベストエフォート解決する)。1件でも提案があるその回のpr_fixは`rereview_requested`ではなく`needs_human`で終わり、Discordに`ConsoleのInboxで提案を承認または却下してください`という通知が飛ぶ。人が`f/factory/approval_decide`(Console Inboxから、kind = issue_proposal)で承認すると、`f/factory/steps/issue_proposal_apply`がその提案のIssueを対象リポジトリに作成してスレッドへ返信・resolveし、却下すると理由を返信してスレッドは開いたままにする(承認・却下いずれも要件定義の承認と同じ「人が判断してから進む」枠組み)。対象work itemの提案がすべて決定すると、status(`work_items.status`)はその回でコミットをpushしていれば`rereview_requested`、していなければ`reviewed`へ切り替わる(`decidePostProposalStatus`、pr_workflow_support.ts)。返信対象がPRレビューコメントかプレーンなissueコメントかは行挿入時に`is_inline`列へ記録し(`matchReviewThreadForComment`もコメントの`databaseId`で一致させ、`(path, line)`には依存しない)、`issue_proposal_apply`はそれをもとに決定的に返信先を選ぶ。承認は`decided_by`(要件定義の承認と同じfail-closed導出)と`status = 'pending'`条件付きUPDATEによる楽観ロック、作成したIssue本文へ埋め込む`<!-- factory:issue_proposal:<id> -->`マーカー(`findIssueByMarker`で再検索して再利用)によって、途中でクラッシュしても再実行が安全になっている(Issueの二重作成や決定の上書きは起きない)。詳細な手順は [docs/operations.md](operations.md)の「Issue化提案の承認 / 却下」を参照。
- **PRに書くのはレビュー本体と返信のみ**: pr_reviewの指摘・総評、pr_fixの返信のみをPRに投稿し、失敗・要人手・ブロック・requirements_gap・Issue化提案の承認/却下結果といった運用系の内容も、通知はPRに書かずDiscordに送る(Issue化提案の承認/却下自体への返信はPRのスレッドに書く。上記参照)。
- **DB上の追跡と再発見(2026-09-27方針変更)**: factoryが扱ったPRにトリガーラベル以外のラベルは付かない。人が今このPRが何を待っているか確認するのはConsoleのPipelineタブ(`work_items.status`)で行う。`poll_prs`の`listTrackedPrs`(lib/db.ts)が`kind IN ('pr_review', 'pr_fix')`かつ`status != 'cancelled'`かつ`tracked_pr_days`以内に更新された行をDBから再発見するので、トリガーラベルが外れた後も追跡が続く(詳細は [docs/operations.md](operations.md)の「ラベルと終端状態」を参照)。
- **watermark**: 処理済みwatermark(`last_review_id` / `last_comment_id` / `last_review_comment_id`)はpr_fixがpushに成功したとき、またはrequirements_gapで元Issueへ差し戻したときにのみ進める。それ以外の終端(`failed` / `needs_human` / `blocked`)では進めず、`retry_work_item`による再実行で同じフィードバックを再収集できるようにする。push成功時にIssue化提案があって`needs_human`に終わる場合も、watermarkは(pushが実際に成功しているため)通常のpush成功と同様に進める。

## 自己更新の仕組み(self_update)

1. worker内のself clone(このリポジトリ自身)をpullする。SHAが変わっていなければ何もしない。
2. 変更があれば、Console raw appの依存を`npm ci`で揃えたうえで`wmill sync push --yes --keep-deleted`と`wmill datatable migrate up`をworker内から実行し、Windmill側のscript/flow/scheduleとData Tableの定義を最新化する。
3. `infra/**`・`mise.toml`(workerイメージやcompose定義、composeが読むツールのバージョンと環境変数)に変更がある場合は、workerの自己更新だけでは反映できないため`deployments.needs_host_action = true`として記録し、DiscordとダッシュボードのNoticesで「`mise run deploy`を実行してください」と通知する。`mise run deploy`はホスト側checkoutで`git pull --ff-only` → worker imageのビルド → `compose up -d` → `wmill sync push` → migrationの順で実行する。
4. Claudeが参照するスキル(`.claude/skills/**`)はself cloneを`--add-dir`で直接読むため、pull直後から反映される。
5. 初回の反映(schedule自体の登録や初回push)は`scripts/bootstrap.sh`がホストから行う。

## 拡張点

### 工程3: 実装(未実装、拡張点)

承認後に`gtr`でworktreeを作成して実装し、レビュー・PR作成・CI監視まで進める。書き込み権限を持つClaude実行に対する追加ガードの設計は実装時に確定するが、要件定義(工程2)との整合を保つため、次の設計原則を先に定める。

- **実装からの自動差し戻し**: 実装ステップの出力は`outcome: "done" | "requirements_gap"`と`gap_report`を持つ。
- `outcome: "requirements_gap"`の場合、実装ステップは要件や設計を自分で書き換えず、`gap_report`(どの要件を満たせないか、理由、要件側で必要な変更案)を添えて中断する。
- `gap_report`をfeedbackとして工程2(要件定義生成)をattempt+1で自動的に再起動し、生成し直した要件定義に対して再度人の承認を待つ(状態遷移: `implementing → requirements_generating`、理由`gap`)。
- 実装が要件を満たして完了した場合はPRを作成し`pr_open`へ遷移する(`implementing → pr_open`)。
- **実装中に要件や設計を書き換えることは禁止する**(実装が要件解釈を勝手に変えて帳尻を合わせることを防ぐ)。この制約は工程3で作成する`factory-implementation`スキルで規定する。

### 工程4: CI監視(未実装、拡張点)

マージ後のCIを監視するscheduleを追加する。

### 工程5: 自己改善(未実装、拡張点)

`job_failures` / `approvals`(却下)/ `notices`を入力に、改善提案をIssueとして起票し工程1に戻すフローを追加する。

### Discord双方向化

ボタンによる承認操作はInteractions Endpointの公開URLが必要なため、共有インスタンス化(VPS等)の際に検討する。

上記のうち、工程3以降の具体的なガード設計や監視scheduleの詳細は実装時に確定する。
