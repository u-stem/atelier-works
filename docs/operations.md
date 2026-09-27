# 運用

## 運用ルール

- Issueを拾ったインスタンスの所有者が、そのIssueの承認を行う。
- 各インスタンスは稼働前に`f/factory/factory_config`の`instance_name`を必ず設定する(Discord通知・承認Inboxの担当表示に使われる)。
- 1つのIssueは1つのインスタンスが占有する。claim(assignee設定 + `wip`ラベル付与)に成功したインスタンスだけがそのIssueを処理し、後から来た他インスタンスは撤退する。
- 処理が終端status(承認済み・要対応・タイムアウト・失敗・レビュー済み・再レビュー依頼・ブロック・キャンセル)になると、`wip`ラベルとトリガーラベル(`factory` / `factory:review` / `factory:fix`)は自動で外れる(承認済みは`factory:approved`に付け替わる)。**もう一度処理させたい場合は、人が改めてラベルを付け直す**(ラベルを残したままにしない設計により、孤児失敗したIssue / PRが自動で無限に再試行されることを防いでいる)。

## 日常運用

- Issueに`factory`ラベルを付けると拾われる(付与者はOWNER / MEMBER / COLLABORATORのいずれかである必要がある)。
- 手動フォームからも同じパイプラインにIssueを投入できる想定(`manual_intake`フロー)。
- **承認はFactory Console App(`f/factory/factory_console`)のInboxタブから行う**。Discord通知に記載されたURL、またはConsoleを直接開き、対象の作業項目を選択して要件定義・図(draw.ioビューアー)・未確定事項を確認したうえで承認 / 却下する(却下時は理由の入力が必須、補足は任意)。承認者は実行ユーザー(`WM_USERNAME`)として記録される。Windmillのapproval page URL(承認URL)から直接resumeしない(approvalがスキップされて`needs_human`に落ちる)。Appを使わない代替手順として、Windmill UIで`f/factory/approval_decide`を直接開き、`work_item_id` / `decision`(approve / reject) / `reason` / `note`を入力してRunすることもできる。
- Issueに自動投稿されるコメントは、要件定義が承認されたときのConsoleリンク1件のみ。着手・承認待ち・却下・期限切れ・失敗・要人手といった運用上の状態はIssueには書かず、Discord通知とConsoleで確認する(GitHubには成果物のみを残す方針、2026-09-27)。
- Rejectすると要件定義が再生成され(`attempt`が加算される)、再度承認待ちになる。試行回数が上限を超えると`needs_human`になる。
- 失敗したwork itemはFactory Console AppのFailuresタブから再実行できる(`retry_work_item`)。再実行時は`wip`ラベルと該当するトリガーラベル(`factory` / `factory:review` / `factory:fix`)を再付与して再起動する。
- 通知の種類: `picked` / `awaiting_approval` / `approved` / `rejected` / `needs_human` / `failed` / `expired` / `cancelled` / `self_update`(ホスト操作が必要)/ `daily_summary`(前日のコスト・件数・失敗)。

## 通知

- 通知は行動が必要なものだけ送る。例えば再レビュー依頼の対象レビュアーが全員除外されて誰にも依頼できなかった場合、状態ラベル(`factory:rereview`)がそれをすでに表しているため、追加の通知はしない(再レビュー依頼のAPI呼び出し自体が失敗した場合は、`pr_fixed`通知の補足欄に記録する)。
- `needs_human`通知には対象(PR / Issue番号)・起きたこと・次の操作(何をすればよいか)が必ず載る。

## PRの使い方(pr_review / pr_fix)

- Claudeが生成してGitHubに投稿する文章(指摘・コメント・返信・要約)は共通の文体規則に従う: 半角英数字と日本語の間に半角スペースを入れない(インラインコード・コードブロックの内部は対象外)、です・ます調、1文1行(要点が複数あれば箇条書き)。詳細は`.claude/skills/factory-review/SKILL.md` / `.claude/skills/factory-fix/SKILL.md`の「文体」節を参照。

### 起動条件

- PRに`factory:review`ラベルを付ける、またはPRのレビュー依頼・assigneeがこのインスタンスのアカウント(未処理のcommitがある場合)で自動起動。
- トリガーラベルが外れた後でも、PRに下記いずれかの状態ラベルが付いていれば`poll_prs`が再発見する(例: レビュー完了 → `factory:reviewed`が付いたPRに、後日`factory:fix`ラベルを付け直した場合)。
- コメント投稿者・レビュー者の`author_association`が`allowed_labeler_associations`に含まれることを確認してから起動する。

### PRレビュー(`pr_review`)

- 指摘がGitHubのCOMMENTとして投稿される。完了状態は`reviewed`。
- Factoryはレビューの開始コメントを投稿しない。レビュー指摘(インラインコメント + コード提案)と総評のみを投稿する。
- 運用者自身のアカウントで投稿するため、総評・インラインコメントとも1行目に`[pr_review 自動レビュー] @<author>`というロールタグ + メンションが付く。
- レビュー総評はClaudeの自由記述ではなく、次の固定4パターンのいずれかをflowが組み立てて投稿する: (1)指摘を投稿した場合(初回・再レビュー共通、行に紐づけられず投稿できなかった指摘があるだけの場合も含む)は件数 + 「確認お願いします。」(この場合、最終判断の一文は付かない)、(2)このPRへのfactoryレビューが過去にあり指摘0件の再レビューは「修正を確認しました。LGTMです。」+「最終的なApprove判断は人が行ってください。」、(3)初回レビューで指摘0件は「指摘はありません。LGTMです。」+ 同じ最終判断の一文、(4)このPRへのfactoryレビューが過去にあり指摘0件の再レビューだが、過去の`[MUST]`指摘で今回のresolve処理でも解決できなかったものが残っている場合は「新しい指摘はありません。未対応の指摘がN件残っています。確認お願いします。」(最終判断の一文は付かない)。Claudeの`summary`は`factory.reviews`に記録されるのみでGitHubには投稿されない。
- 再レビューでは、このPRに対するfactory自身の未解決の指摘一覧がClaudeへの入力に含まれる。実質的に同じ内容の指摘は新規指摘として再度投稿されず、新規・変化があった指摘のみ報告される(diffで既に解消済みと判断できるものは何も報告されない。スレッドのresolveは別処理が行う)。
- スレッドの自動解決(resolve)は、factory自身のインラインコメントスレッドのうち、そのスレッドの最後のコメントもfactoryが書いたものである場合に限られる。スレッド内に人が返信している場合は自動解決の対象にならず、開いたままになる。このPRへのfactoryレビューが過去にある(=再レビューである)たびに、pr_fixがcommit sha付きで「対応: `<sha>`」と返信済みのスレッドをresolveする(「対応: 見送り」「対応: 変更なし」は人の判断が必要なためresolveしない)。加えて指摘0件の再レビュー(上記パターン2・4のいずれでも)では、factory自身の指摘のまま何も返信されていないスレッド(人が手で直した等)もresolveする。初回レビュー(過去のfactoryレビューがない)では何もresolveしない。resolve処理後もなお開いたままの`[MUST]`スレッドが1件以上あると、パターン4になる。
- レビュー形式は`.claude/skills/factory-review/SKILL.md`の「投稿形式」節を参照。
- 運用通知(失敗・要人手・ブロック)はPRに投稿せずDiscordに送る。

### PR修正(`pr_fix`)

- PRに`factory:fix`ラベルを付けると実行される。すでにfactoryがレビュー済み(`reviewed`)のPRでも有効。修正への指示は、ラベルを付ける前にPRへ通常のコメントとして書いておく(`pr_fix_collect`が他の人間のコメントと同様にフィードバックとして収集する)。
- 運用通知(失敗・要人手・ブロック)はPRに投稿せずDiscordに送る。
- レビュー指摘・未解決コメントの修正を行い、各コメントへ返信してから再レビューを依頼(`rereview_requested`)。
- 返信は運用者自身のアカウントで投稿するため、1行目のロールタグ・本文・末尾の対応行(コミットshaまたは「見送り」)という固定構造でflow側がレンダリングする。形式は`.claude/skills/factory-fix/SKILL.md`の「返信形式」節を参照。
- コミットメッセージはClaudeが提案する件名(`commit_subject`、50文字以内を目安・72文字を超えると拒否・Conventional Commits形式)と任意の本文(`commit_body`、箇条書き)をflowが結合して作る。トレーラー(`Co-Authored-By` / `Generated-By`)はflow側が自動で付与する。コミットメッセージにも英数字と日本語の間のスペース除去が適用される(コードスパン内は除く)。
- 要件変更が必要な場合は修正を中断し、元のIssueをrequirements_generatingにattempt+1で再起動(`requirements_gap` → 親Issue)。
- Factory自身の投稿は「viewer(FactoryのGitHubアカウント)と同じログイン **かつ** factoryマーカー付き」の両方で判定する。同一アカウントで運用しているため、人が投稿したコメントはログインが一致してもマーカーが無いのでhuman feedbackとして扱われる。同様にFactory自身の一次レビュー(`pr_review`)とその未解決のインラインコメントもマーカー無し(または`pr_review`マーカー)であればfeedbackとして扱われ、pr_fixはその指摘を修正対象にする。除外されるのはFactory自身の`pr_fix`返信(`pr_fix`マーカー付き)のみ。

#### 各コメントへの返信の3値(`decision`)

各レビューコメント・未解決コメントへの返信は、`fixed` / `skipped` / `propose_issue`のいずれかになる(ユーザー決定、2026-09-26)。

| `decision` | 意味 | 返信末尾 |
| --- | --- | --- |
| `fixed` | このPRの範囲内で修正した | `対応: <commit sha7>` |
| `skipped` | 対応しないと判断した(理由は`body`に書く) | `対応: 見送り` |
| `propose_issue` | 指摘は妥当だがこのPRの範囲外。Issue化を提案する | `対応: Issue化を提案(承認待ち)` |

`propose_issue`の提案は`factory.issue_proposals`に記録され、その回のpr_fixは`needs_human`で終わる(状態ラベルは`factory:needs-human`)。1件でも提案が残っている間はこの状態が続く。

#### Issue化提案の承認 / 却下(ConsoleのInbox)

- ConsoleのInboxタブ(要件定義の承認待ち一覧の下)に「Issue化提案」セクションがあり、そこから承認 / 却下する。左の一覧でPR番号・PRタイトル・提案タイトル・作成日時・担当者を確認して提案を選ぶと、右に提案本文(Markdown)と操作欄が表示される。「起票と同時にfactoryラベルを付けて要件定義に進める」のチェックボックス(既定オフ)で`with_factory_label`を切り替え、却下時のみ理由欄が必須になる。Appを使わない代替手順として、Windmill UIで`f/factory/issue_proposal_decide`を直接開き、`proposal_id` / `decision`(approve / reject) / `reason`(却下時は必須) / `with_factory_label`(承認時のみ意味を持つ)を入力してRunすることもできる。
- **承認**すると、提案の`title` / `body`でIssueを対象リポジトリに作成し(`body`中の`{{pr_url}}`は元PRのURLに置換され、末尾に起票元を示す一文が付く)、レビュースレッドに`Issue #Nを起票しました。`と返信してスレッドを解決(resolve)する。`with_factory_label`を`true`にすると、作成したIssueに`factory_config.trigger_label`(既定`factory`)が付き、そのまま要件定義工程に乗る。ラベルを付けない場合は起票のみで、必要になったら人が後から`factory`ラベルを付ける。
- **却下**すると、レビュースレッドに`見送りとします。`+ 入力した理由を返信するが、スレッドは開いたままになる(人が改めて判断する)。
- 対象work itemに未決定の提案が残っていなければ、PRの状態ラベルを`needs-human`から`rereview`(その回でコミットをpushしていた場合)または`reviewed`(pushしていなかった場合)へ自動で切り替える。未決定の提案が他に残っている間は`needs-human`のまま。
- **同じ`decision`での再実行は安全**(冪等)。承認は`status = 'pending'`条件付きのUPDATEで一度だけ決定を記録し、作成したIssueの本文へ`<!-- factory:issue_proposal:<id> -->`というマーカーを埋め込む。途中(決定の記録後、Issue作成前後)でjobが失敗して同じ`proposal_id` / `decision`で再実行しても、このマーカーで既存のIssueを検索して再利用するため、Issueが二重に作られることはない。すでに承認 / 却下が完了している提案に対して異なる`decision`を投げた場合は、上書きせずエラーで拒否する。
- **起票に失敗した提案はInboxに残る**。Issueの作成自体が失敗した場合は決定前の`pending`に戻り、Issue作成後の返信・スレッド解決・ラベル付け替えが失敗した場合は`承認済み・起票未完了`として(「起票未完了」バッジ付きで)Inboxに表示され続ける。いずれの場合も改めて承認を実行すれば、続きから起票する。

### ラベルと終端状態

- トリガーラベル(人が付与し、起動時に外れる): `factory:review`(レビュー起動) / `factory:fix`(修正起動)。`factory:pr`ラベルはfactory自身が作成したPRの目印(将来の工程3で使用)。このリポジトリ自身の基盤整備PR(foundation PR)には`factory:review` / `factory:fix` / `factory:pr`のいずれも付けない。
- 状態ラベル(factory自身が設定・付け替え、PRには常に高々1つだけ付く):

  | ラベル | 意味 | 付与タイミング |
  | --- | --- | --- |
  | `factory:changes-requested` | 一次レビューで修正が必要な指摘(must)があった、または今回は新規指摘がなくても未解決の`[MUST]`が残っている(上記パターン4) | pr_review完了時 |
  | `factory:reviewed` | 一次レビュー完了、修正不要(人のApprove待ち) | pr_review完了時(mustなし、かつ未解決の`[MUST]`も残っていない) |
  | `factory:rereview` | 修正をpushして再レビューを依頼中 | pr_fixがpushに成功して終了したとき |
  | `factory:needs-human` | 人の対応が必要 | pr_fixが`needs_human` / `blocked` / `failed`で終了したとき、pr_review自体が失敗したとき、またはIssue化提案(`propose_issue`)が1件以上あるとき |

  状態ラベルは人への状態表示に加え、`poll_prs`がトリガーラベル脱落後のPRを再発見する手段にもなる(前節「起動条件」参照)。PRがクレームされて新しいレビュー・修正サイクルが始まると、それまでの状態ラベルはすべて一旦外れる。Issue化提案による`factory:needs-human`は例外で、`issue_proposal_decide`が全件を承認 / 却下し終えたときにだけ`factory:rereview`または`factory:reviewed`へ切り替わる(前節「Issue化提案の承認 / 却下」参照)。
  - ラベルは対象リポジトリに事前作成しなくても、初回付与時にGitHubが既定色(灰色)・説明なしで自動作成する(`factory:wip` / `factory:approved`が実際にそうなっている)。一覧で見分けやすくしたい場合は、対象リポジトリで4つの状態ラベルを色と説明付きで先に作っておく。
  - 状態ラベルが付いたPRは以後も`poll_prs`の発見対象であり続けるため、人が新しいcommitをpushするたびに自動で再レビューが起動する(1 pushにつきClaude実行1回)。再レビューを止めたいPRは状態ラベルを手で外す。
  - `review_post_mode: "gated"`ではレビューを投稿しないため状態ラベルも付けない(gatedは検証用の予約モードで、PRはレビュー依頼・assignee経由でのみ再発見される)。
- 対象は`factory_config`の`repo_allowlist`(未指定なら`owners`に含まれるリポジトリ全体)に含まれるリポジトリのみ。試験的に対象を絞りたい場合は`repo_allowlist`に対象リポジトリを明示する。
- 終端状態: `reviewed` / `rereview_requested` / `blocked` / `needs_human`。終端状態になると`wip`ラベルとトリガーラベル(`factory:review` / `factory:fix`)は自動で外れる。

### pr_fixの再実行

- `retry_work_item`で`failed` / `needs_human` / `blocked`のpr_fix行を再実行できる。処理済みwatermark(`last_review_id` / `last_comment_id` / `last_review_comment_id`)はpush成功時(または要件定義への差し戻し、`requirements_gap`)にしか進まないため、それ以外の終端(`failed` / `needs_human` / `blocked`)から再実行すると前回と同じフィードバックが再収集される。
- 次のroundを明示的に始めたいときは、PRに`factory:fix`ラベルを付け直す(または新しいレビューを投げる)。

### 人が作ったPRと要件の紐づけ

- PR本文に`Closes #123`(`Fixes` / `Resolves`も可)と書くと、そのIssueに対応する承認済み要件と照合され、pr_review / pr_fixのClaude入力に要件が渡る。

## 更新の反映

- 通常の更新は`git pull`してから`mise run deploy`を実行する(ホスト側checkoutで`git pull --ff-only` → workerイメージのビルド → `docker compose up -d` → `wmill sync push` → migrationを一括実行する)。
- workerの並列数(`NUM_WORKERS`)のような`infra/docker-compose.yml`の変更は、通常の`git pull`だけでは反映されない。`mise run deploy`を実行してworkerイメージの再ビルドとコンテナの再起動まで行う。
- `wmill sync push`に **`--include-secrets`を付けてはいけない**。付けるとリポジトリ内の`f/factory/*.variable.yaml`(値は空のままコミットされている)で4つのsecret変数(`claude_oauth_token` / `github_token` / `wmill_token` / `discord_webhook_url`)が空に上書きされる。`mise run push`(`wmill sync push --yes --keep-deleted`)は`--include-secrets`を付けない設定になっている。
- secret変数(`f/factory/*.variable.yaml`)とinstance固有の`factory_config` resourceは同期対象外のため、これらの **説明文(description)を変えても`mise run push`では既存instanceに反映されない**。既存instanceではWindmill UI(Variables / Resourcesの編集画面)で説明文だけを更新する。新規instanceはbootstrapがリポジトリの説明文で作成する。
- `f/factory/deployed_sha`変数も同期対象外(理由は他の2つと異なり、instance固有の設定ではなく`self_update`が書き込む実行時状態のため)。`mise run push`を実行しても値は変わらない。`bootstrap`は初回のみ空値で作成し、既に存在する場合は値を変更しない。値をリセットしたい場合はWindmill UIから直接編集する。
- `self_update`スケジュール(10分毎)が`infra/`・`mise.toml`の変更を検知すると、DiscordとダッシュボードのNoticesで「`mise run deploy`を実行してください」と通知する。`scripts/`(ホスト側のbootstrap / doctor / lint)や`mise.local.toml.example`の変更はworkerの動作に影響しないため通知しない。`f/`・`migrations/`・`.claude/skills/`の変更は`self_update`が自動で反映するので、ホスト側の操作は不要である。

### Windmillの`admins`ワークスペースにある組み込み項目

- Windmillは起動時に`admins`ワークスペースへ「Synchronize Hub Resource types with instance」などの組み込みscript / scheduleを自動作成する。これらはWindmill本体の一部であり、本リポジトリの管理対象ではない(`mise run push`や`self_update`の同期対象にも含まれない)。summaryが英語のままなのはそのためで、日本語化や削除はしない。
- Factoryの資産はすべて`factory`ワークスペースの`f/factory/**`にある。
- ダッシュボードApp(Factory Console、`f/factory/factory_console__raw_app/`)はraw appとしてコードでリポジトリ管理する。編集はWindmill UIではなくリポジトリのソース(`App.tsx` / `tabs/*.tsx` / `backend/*.yaml`等)を直接編集し、`mise run push`でデプロイする。バックエンドrunnableを追加・変更した場合は`wmill generate-metadata`でロック情報を更新してからコミットする。

## 秘密のローテーション

1. GitHub PAT / Claude Code OAuthトークンを再発行する(手順は [docs/security.md](security.md)を参照)。
2. 新しい値を`mise set -E local KEY=value`(`read -rs`経由を推奨)で投入する。
3. `mise run bootstrap`を再実行する。`bootstrap.sh`は冪等なので、既存のWindmill変数は新しい値で上書き更新される。

## バックアップ

- Windmillのデータ(ワークスペース設定、Data Table、ジョブ履歴など)はすべて`db_data`というDocker volume(Postgres)に入っている。バックアップの対象はこのvolume。
- `docker compose -f infra/docker-compose.yml down -v`は`db_data`を含むすべてのvolumeを削除する破壊的操作である([docs/setup.md](setup.md)のトラブルシュートも参照)。

## 保持期間

- `cleanup_db`スケジュール(毎日03:30)が、保持期限を過ぎたDBのレコードを削除する。
  - 終端状態(承認済み・要対応・タイムアウト・失敗・レビュー済み・再レビュー依頼・ブロック・キャンセル)になった作業項目は、既定90日(`factory_config`の`retention_work_items_days`)を過ぎると削除される。要件定義ドラフト・承認履歴・承認依頼・状態遷移の履歴(`work_item_events`)・Claude実行の記録(`agent_runs`。コスト分析`v_agent_cost_daily`の元データ)も、外部キーの`ON DELETE CASCADE`によりあわせて削除される。コスト分析を保持期間より長く見たい場合は`retention_work_items_days`を延ばす。
  - 失敗記録・デプロイ記録・解決済みのお知らせは、作業項目とは独立に既定30日(`retention_logs_days`)を過ぎると削除される(未解決のお知らせは対象外)。
  - どちらの日数も`f/factory/factory_config`から変更できる。
  - 既知の制約: 同じIssueの作業項目がすべて削除された後にそのIssueを再度拾うと、cycle番号は1から採番し直される(`nextCycleForIssue`は残っている行の最大値から決めるため)。過去の通知やDiscordの履歴に残るcycle番号とは意味が衝突しうる。
  - 削除件数は`cleanup_runs`テーブルに記録され、翌朝09:00の日次サマリ通知(Discord)の「DB 掃除」欄に反映される。

## 未実装の機能

次はまだ実装されていない。実装され次第このドキュメントを更新する。

- 工程3の「Issueから実装してPRを作る」フロー(factory自身が実装worktreeを作成してPRを投稿する機能)
- 工程4のマージ後CI監視
- 工程5の自己改善提案(失敗・却下の履歴から改善Issueを自動作成する機能)
- Discord双方向化(ボタン操作による承認)
