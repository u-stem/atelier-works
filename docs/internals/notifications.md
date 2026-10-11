# 通知とrate limit

Factoryが人に知らせる仕組みと、GitHubとDiscordのrate limitに当たったときの挙動、GitHub APIの一時的な失敗の再試行を定める仕様である。通知を変更する人が、どの処理が何を送り、失敗したらどうなるかを確かめるために読む。通知を受けた人がすることは[運用](../operations.md)にある。

## 知らせる経路

Factoryは、知らせる内容によって経路を使い分ける。

| 経路 | 載せるもの | 実装 |
| --- | --- | --- |
| Discordの通知 | 人の行動が要るイベントと、日次サマリー | `f/factory/lib/discord.ts` |
| Consoleの**通知**タブ | Discordに送らない要対応の事項(notice) | `factory.notices`、`addNotice` |
| Consoleの**失敗**タブ | フローとスケジュールの失敗の記録 | `factory.job_failures`、`recordFailure` |
| GitHub | 成果物だけ | Issueへの承認のコメントと、承認を取り消したときのコメント、PRのレビューと返信 |

GitHubには成果物だけを書く。Issueに自動で投稿するのは、要件定義が承認されたときのConsoleへのリンクと、新しいサイクルが始まって承認済みの要件定義を取り消したときの説明の、2種類のコメントだけである。着手、承認待ち、却下、期限切れ、失敗、人の対応待ちといった運用上の状態は、Issue・PRに書かない。DiscordとConsoleで知らせる。
承認を取り消したときのコメントは、運用上の通知ではない。Issueで承認が見えなくなった理由を、Issueに残す記録なので、人の操作が要らなくても投稿する。

## Discordの通知の種類

通知の種類は`NotifyEvent`の`kind`で決まる。

| 種類 | タイトル | 送る処理 | 送るとき |
| --- | --- | --- | --- |
| `issue_claimed` | Issue着手 | `poll_issues`、`manual_intake_register` | Issueを取得し、要件定義の生成を始めた |
| `approval_requested` | 承認待ち | `pipeline_request_approval` | 要件定義の承認依頼を記録した |
| `requirements_approved` | 要件定義承認 | `requirements_apply` | 要件定義が承認された |
| `needs_human` | 人による対応が必要です | 下の表を参照 | 作業項目が人の対応を待つ状態になった |
| `pr_reviewed` | PRレビュー完了 | `pr_review_post` | レビューを投稿した |
| `pr_fixed` | PR修正適用 | `pr_fix_finish` | 修正をpushし、再レビューを依頼した |
| `job_failed` | ジョブ失敗 | 下の表を参照 | フローやスケジュールが失敗した |
| `console_fetch_problem` | Consoleの取り込みに問題があります | `console_fetch_watch`(10分ごと) | Consoleの取り込みの失敗、更新の停止、状態が読めないことを検知し、通知を新しく残した |
| `console_worker_check_failed` | Console用のworkerの動きを確かめられません | `self_update`(10分ごと) | Console用のworkerがジョブを受けているかを、1時間(6回)続けて確かめられなかった |
| `console_worker_missing` | Console用のworkerがジョブを受けていません | `self_update`(10分ごと) | tag `console`のジョブが予定時刻から5分以上待たされていることを検知し、通知を新しく残した |
| `daily_summary` | 日次サマリー | `notify_daily_summary`(毎日09:00) | 前日の集計 |
| `audit_completed` | 監査レポートができました | `audit_generate` | 改善提案が1件以上ある監査レポートを保存した |
| `pr_opened` | PR作成 / PR更新 | `implement_finish` | 実装フローがPRを作成か更新した |

人の対応待ち(`needs_human`)の通知を送る処理は次のとおり。

| 処理 | 送るとき |
| --- | --- |
| `pipeline_generate` | 日次の予算を超えていたので、要件定義の生成を始めなかった |
| `requirements_apply` | 試行回数の上限まで却下された。承認の後に実装フローを起動できなかった |
| `poll_issues` | 承認依頼が期限切れになった(理由は`approval timed out`)。Issueを取得した後に作業項目を登録できなかった(理由は`claimed issue could not be registered`)。トリガーラベルを外した結果が分からなかった(理由は`claim ownership could not be determined`) |
| `poll_prs` | PRのトリガーラベルを外した後に取得を確認できず、ラベルが外れたままになった(理由は`claimed pr trigger label was left removed`) |
| `implement_finish` | 実装フローが人の対応待ちで止まった |
| `pr_review_generate` | レビューの生成を止めた |
| `pr_fix_finish` | 修正が人の対応待ちで止まった。Issue化の提案がある |

`poll_issues`が、1回のポーリングで複数のIssueについてラベルを外した結果を判断できなかったときは、Issueごとに送らず、リンクを並べた1件の通知にまとめる。
各行は`owner/repo#番号`とリンクで、タイトルとリンクの先は先頭のIssueである。
並べるのは10件までで、残りは件数で示す。
`poll_prs`が、1回のポーリングで複数のPRについてラベルが外れたままになったときも、PRごとに送らず、リンクを並べた1件の通知にまとめる。
各行は`owner/repo#番号`とリンクと外れたラベルで、リンクの先は先頭のPRである。
並べるのは10件までで、残りは件数で示す。

ジョブ失敗(`job_failed`)の通知を送る処理は次のとおり。

| 処理 | 送るとき |
| --- | --- |
| `on_error_flow` | フロー(pipeline、implement、pr_review、pr_fix、manual_intakeなど)が失敗した |
| `on_error_schedule` | スケジュールのジョブが失敗した。GitHubのPATの失効は、`poll_issues`の冒頭の確認が失敗してここに来る。直近3回の実行(飛ばされた回と人が取り消した回を除き、ジョブの上限で打ち切られた回は、`canceled_by`が`timeout`の取り消しとみなして失敗に数える。この値は実機で未確認である)が続けて失敗すると、要対応の通知`schedule_failing`も残す。ジョブ履歴を読めないときは、`schedule_failing_check_failed`を残す |
| `poll_issues`の点検 | 閉じたIssue・PRや孤児のジョブを見つけ、作業項目を取り消しか失敗にした |
| `requirements_apply` | 承認の反映の処理が例外で終わった。却下の後の作り直しを起動できなかったときも含む |
| `issue_proposal_apply` | Issue化の提案の反映が失敗した |

### 種類ごとに載る項目

どの通知にも、送ったインスタンスを示す「インスタンス」の欄が付く。`instance_name`と対象のGitHubのオブジェクトを特定する値は、どの種類の`NotifyEvent`も持つ。埋め込みを、ほかの情報を引かないで組み立てるためである。

| 種類 | リンク先 | 主な欄 |
| --- | --- | --- |
| `issue_claimed` | Issue | リポジトリ |
| `approval_requested` | Consoleの承認の画面 | リポジトリ、Issue |
| `requirements_approved` | Consoleの要件定義のページ | リポジトリ、Issue |
| `needs_human` | 対象のIssueかPR | 説明に理由、「次の操作」、リポジトリ |
| `pr_reviewed` | PR | 説明に指摘の件数と状態 |
| `pr_fixed` | PR | 再レビュー依頼のAPIが失敗したときだけ「補足」 |
| `job_failed` | なし | 説明にエラー、ジョブのID |
| `console_fetch_problem` | なし | 説明に原因、「次の操作」 |
| `console_worker_check_failed` | なし | 説明に原因、「次の操作」 |
| `console_worker_missing` | なし | 説明に原因、「次の操作」 |
| `daily_summary` | なし | 説明に実行件数と費用、失敗、承認、却下、DB掃除 |
| `audit_completed` | Consoleの監査のページ | 「次の操作」、`work_item_id` |
| `pr_opened` | PR | 「次の操作」、Issue、「確認して欲しい点」、ラウンドと費用、差分 |

人の対応待ちの通知には、対象(PRかIssueとその番号)、起きたこと、次の操作を必ず載せる。題名とリポジトリだけでは、読み手が次に何をすべきか分からないためである。

次の操作は、理由の文から`pr_workflow_support.ts`の`nextActionFor`が決める。

- 同じ理由でも、実装フローとPRの修正で次の操作が変わるものは、フロー(`NextActionFlow`)を渡して選ぶ。
- 再実行を案内するときは、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行するよう書く。人の対応待ちとブロックの作業項目は、`job_failures`の行が無ければConsoleの**失敗**タブに出ないためである。
- どの規則にも当たらない理由では、`GENERIC_NEXT_ACTION`の文になる。通知の理由とConsoleの**通知**タブで原因を確かめて取り除き、`retry_work_item`を実行するよう求める文である。

### 理由の区切りを無効にする

状態の理由(`status_reason`や人の対応待ちの理由)は、`"; "`でつないだ項目の一覧である。
表示する文(`describeReason`)は、`"; "`で分けた項目ごとに訳す。
次の操作(`nextActionFor`)は、先頭から見て最初に規則と一致した項目で選ぶ。

理由に埋め込む詳細のうちClaudeや検査コマンドが書けるものは、`escapeReasonSeparator`で`"; "`を`", "`に置き換えてから使う。
対象は次のとおりである。

- Claudeの実行の失敗の詳細(stderr、結果の文、構造化出力の検証エラー)
- gitのエラー文
- 変更の判定に載るファイル名
- pr_fixのClaudeが理由として書く`blocked_reason`

区切りを入れて別の理由の訳文を表示させたり、既知の理由を足して次の操作を選ばせたりできないようにするためである。
`blocked_reason`の全体を既知の理由と同じ文にすることは防げない。

PRレビュー完了の状態は、次の規則で決まる(`reviewResultFor`)。

| 状態 | 条件 |
| --- | --- |
| 修正が必要な指摘あり(`changes_requested`) | 今回の指摘に`[MUST]`があるか、未解決の`[MUST]`のスレッドが残っている |
| 指摘なし(`reviewed`) | 上記以外。人のApproveを待つ |

PR作成・更新の「確認して欲しい点」には、変更された保護パスを並べる。実装フローは保護パスが変わっても止まらないので、人が先に確かめるためである。検査コマンドを動かさなかったラウンドでは、説明に「検査未実施」と理由が出る。

日次サマリーの「DB掃除」欄は、前日のDBの掃除の記録(`cleanup_runs`)から作る。その日の記録が無ければ「前日の掃除記録なし」になる。

監査レポートの通知は、改善提案が1件以上あるときだけ送る。監査をスキップしたときと、提案が0件のときは送らない。

### 埋め込みの上限

埋め込みは、Discordの上限に収めてから送る(`capEmbedToDiscordLimits`)。

| 対象 | 上限 |
| --- | --- |
| タイトル | 256文字 |
| 説明 | 4096文字 |
| 欄の値 | 1024文字 |
| 全体(タイトル、説明、全欄の名前と値の合計) | 6000文字 |

まず項目ごとの上限で切り、次に全体の上限に収める。切った文の末尾は省略記号にする。全体を削るときは、説明から削る。エラーメッセージや差し戻しの理由など、外から来た長い文は説明に入りやすいためである。

### 通知に載せないもの

- メンション: `allowed_mentions`を空にして、@everyone、@here、ロールへのメンションを一切起こさない。埋め込みには信頼できない文が入りうるためである。
- Windmillの承認ページのURL: 承認待ちのリンクには、認証の要るConsoleのURLだけを入れる。署名付きの承認ページのURLを見た人は、`approval_decide`を通さずにフローを再開・取り消しでき、承認の記録が残らないためである。
- webhookのURL: URLのパスに秘密のトークンが入るので、エラーメッセージとログに含めない。
- 要件定義の図: 図の内容とURLのどちらもDiscordに送らない。

## 送信の失敗とrate limit

### Discordのrate limit

DiscordがHTTP 429を返したら、待ってから1回だけ再送する。待つ時間は次の順で決める。

1. `retry-after`ヘッダー(秒)。空、空白だけ、数として読めない値は無いものとして扱う。空のヘッダーを0と読んで、待たずに再送しないためである。
2. JSONの本文の`retry_after`(秒)。
3. どちらも無ければ1秒。

待つのは最大30秒(`DISCORD_RETRY_MAX_WAIT_MS`)である。それより長く待つ必要があるときは、待たず再送もせずにその通知を諦める。ジョブのログには`discord notify skipped: rate limit wait exceeds cap`のwarnを残す。

30秒を超える待ちは、チャンネルやアカウント全体の制限に当たっているときに起きる。待っても再送が通る見込みは薄い。上限は、最も短いステップのtimeout(PRの修正の指摘の収集の600秒)より十分に短くしてある。1つのステップで何度か通知しても、ステップが打ち切られないようにするためである。

### 通知の失敗でフローを止めない

通知が失敗しても、フローは失敗しない。待ちが上限を超えたとき、再送も429で拒まれたとき、2xx以外の応答、その他の送信の失敗のどれでも、呼び出し元が捕まえて処理を続ける。

通知の多くはDBやGitHubへの副作用の後に送る。通知の失敗でステップが止まると、済んだ副作用の続き(次のフローの起動や状態の遷移)が行われないまま残るためである。

| 呼び出し元 | 失敗の記録 |
| --- | --- |
| ふつうのステップ | ジョブのログにwarn |
| 失敗の記録と通知を受け持つ処理(`on_error_flow`、`on_error_schedule`、`requirements_apply`の例外処理など) | ジョブのログにerror |

届かなかった通知は再送しない。webhookのURLが空のインスタンスでは、何も送らない。

`notifyBestEffort`は、結果を3つの値で返す。送れた(`sent`)、webhookが無い(`no_webhook`)、送れなかった(`not_sent`)である。届かなかったことを人に知らせる必要がある呼び出し元は、この戻り値で判断する。`not_sent`の理由は秘密情報をマスク済みで、そのままログやnoticeに載せてよい。

### 届かなかったことを残す通知

承認待ちの通知が届かなかったときは、**通知**タブに`approval_notify_failed`のnoticeを1件残す。通知が無いと、人が承認依頼に気づけないためである。webhookを設定していないときは、Consoleを見る運用なので残さない。noticeの記録が失敗しても、warnを残すだけで例外は投げない。

### 通知を送らない場合

通知は、人の行動が要るものだけを送る。

- 再レビューを依頼する相手がいないときと、候補が全員除外された(PRの作成者かFactoryのアカウント)ときは、通知とnoticeのどちらも残さない。想定内で人がすることは無いので、作業項目の`status_reason`にだけ残す。PR修正適用の通知が、再レビューを依頼したという結果を既に伝えている。
- 再レビュー依頼のAPIの呼び出しが失敗したときは、人がGitHubでレビュアーを依頼する必要がある。PR修正適用の通知の「補足」欄に載せ、`pr_fix_reviewer_request_failed`のnoticeにも残す。依頼の前のPRの取得(`getPr`)の失敗と、Botや削除済みの作成者の名前で依頼を組み立てられない場合も、この扱いになる。
- 承認のコメントをIssueに投稿できなかったときは、Discordには知らせず、`approval_comment_failed`のnoticeだけを残す。承認の通知はそのまま送る。
- 実装フローが取得したIssueの題名か本文が取り込み時点と違っても、通知はしない。PR本文の「確認して欲しい点」に1行書くだけである。
- 監査のスキップと、提案が0件の監査は通知しない。
- 自己更新がホスト側の操作が要る変更を検知しても、通知しない。

## Consoleのnotice

noticeは`factory.notices`の1行で、種類(`kind`)と本文(`message`)を持つ。本文には、対象を`<owner>/<repo>#<番号> (work item <id>)`の形で載せるものが多い。

| 種類 | 記録する処理 | 本文に載るもの |
| --- | --- | --- |
| `approval_notify_failed` | `pipeline_request_approval` | 対象、送れなかった理由 |
| `approval_comment_failed` | `requirements_apply` | 対象、理由、要件定義を開くConsoleのリンク |
| `implement_launch_failed` | `requirements_apply` | 対象、理由、次の操作 |
| `implement_needs_human` | `implement_finish` | 対象、止まった理由 |
| `unsandboxed_check_commands` | `implement_verify`、`pr_fix_verify` | 実行する検査コマンドの件数、対象 |
| `fix_reply_post_failed` | `pr_fix_finish` | 失敗した件数、`review_comment_id`、最初のエラー |
| `pr_fix_reviewer_request_failed` | `pr_fix_finish` | 対象、依頼できなかった理由 |
| `issue_proposal_record_failed` | `pr_fix_finish` | 対象、記録の失敗の理由 |
| `fix_feedback_association_excluded` | `pr_fix_collect` | 対象、除外した投稿者 |
| `labeler_denied` | `poll_issues`、`poll_prs` | 対象、許可されていないトリガーラベル |
| `fork_head_denied` | `poll_prs` | 対象のPR |
| `labeler_check_limit` | `poll_issues`、`poll_prs` | 対象、付与者を判定できないトリガーラベル、付け直す操作 |
| `claim_race_lost` | `poll_issues`、`poll_prs`、`manual_intake_register` | 対象、取得できなかった理由 |
| `claim_assignee_missing` | `poll_issues` | 対象、assigneeにできなかったユーザー、確かめる点 |
| `pr_trigger_label_left_removed` | `poll_prs` | 対象のPRと、外れたままのトリガーラベル |
| `supersede_failed` | `insertIssueWorkItemUnlessActive`(`poll_issues`が呼ぶ) | 対象、新しい作業項目のID、操作が要らないこと |
| `deployed_sha_mismatch` | `poll_issues` | `f/factory/deployed_sha`、原因の候補 |
| `cleanup_db_failed` | `cleanup_db` | 削除に失敗した対象とエラー |
| `cleanup_worktrees_skipped` | `cleanup_workspaces` | 掃除を見送ったリポジトリ |
| `cleanup_worktree_busy` | `cleanup_workspaces` | 作業項目のID、worktreeのパス、worktreeを使っているプロセス |
| `workspace_disk_usage` | `cleanup_workspaces` | 作業領域のディスク使用量(MiB) |

`fix_reply_post_failed`は、返信の投稿に1件以上失敗したとき1件だけ残す。Discordには通知しない。`unsandboxed_check_commands`は、検査コマンドを実行するたびに残す。
`cleanup_worktree_busy`は、1回の掃除でworktreeのパスごとに1件残す。Discordには通知しない。
次のnoticeは、同じ本文の未解決のものがあるあいだは追加しない。
対象は、次の7種類である。

- `labeler_denied`
- `fork_head_denied`
- `labeler_check_limit`
- `claim_assignee_missing`
- `claim_race_lost`
- `supersede_failed`
- `pr_trigger_label_left_removed`

`claim_race_lost`のうち、`poll_issues`と`manual_intake_register`が残すものは対象である。
`poll_prs`が残すものは、確認できずにトリガーラベルを付け直したときだけ対象にする。
`poll_prs`のその他の`claim_race_lost`は、毎回追加する。
`supersede_failed`は、新しいサイクルの挿入の後に、古い承認済みの作業項目を取り消す文が失敗したときに残す。Discordには通知しない。
同じ状況が続く間、ポーリングのたびに積み上がるのを防ぐためである。
`deployed_sha_mismatch`は、反映が止まったときだけ残す。
mergeの直後から自己更新が反映するまでの間は、版が必ず食い違うためである。
`poll_issues`は、食い違いを最初に見た時刻を、このスケジュールのWindmillのstateのキー`deployed_sha_check`の下に保存する。
自己更新の2周期(20分)に、`poll_issues`の1周期(5分)と反映にかかる時間の見込み(5分)を足した30分を超えて続いたときに、1件残す。
反映にかかる時間は見込みで、実測の上限ではない。
自己更新は反映のために外部コマンドを最大3回呼び、1回の上限は5分である。正常な反映も、見込みを超えうる。
超えたときは通知が出るが、反映が成功すると自動で解決される。
2つのスケジュールは毎時0分で位置が重なるので、20分ちょうどでは判定が反映より先に動いて誤って知らせうる。
数え直すのは、反映済みの版(`f/factory/deployed_sha`)が変わったとき、つまり反映が進んだときだけである。
止まったままmergeが続き、self cloneのHEADだけが変わっても、数え直さない。
`f/factory/deployed_sha`が空のときは、変数が無いときと同じく、何もしない。stateとnoticeは変えない。
本文は反映済みの版を中心にし、今のself cloneのHEADを含めない。
重複の判定は本文の一致で行うので、HEADを含めると、止まっている間にmergeのたびにnoticeが増える。時刻も入れない。
今のHEADは、`poll_issues`のログで分かる。
noticeを新しく残したときは`deployed_sha_mismatch notice recorded`に、noticeのIDを添えて出る。
同じ本文の未解決のnoticeがあったときは`deployed_sha_mismatch notice already open`に出る。
本文には、直近の反映の記録(`factory.deployments`)から読んだ原因の候補を添える。
記録の行の対象の版が今のHEADで、結果が失敗のときだけ、反映の失敗を候補にする。
それ以外は、自己更新が止まっているか、まだ今のHEADを試していないことを候補にする。
記録を読めない場合と、1行も無い場合でも、noticeは残す。そのときは候補を添えない。
候補が変わると本文も変わるので、同じ反映済みの版でも、候補ごとに最大で1件ずつ残る。
stateを読めないとき、書けないときは、猶予を数えられない。反映の停止を見逃さないよう、待たずに残す。

`poll_issues`は、`f/factory/deployed_sha`が空でない実行のたびに、判定の結果によらず、先にnoticeを解決する。
解決するのは、未解決の`deployed_sha_mismatch`のうち、次の行より前に作られたものだけである(`resolved_by`は`poll_issues`)。
今の`f/factory/deployed_sha`への反映が成功した行のうち、最も新しい行である。
成功した行は、`factory.deployments`の`result`が`success`で`sha_to`が反映済みの版の行を指す。
時刻の比較は、noticeの`created_at`と、行の`occurred_at`で行う。どちらも行を入れたときのDBの`now()`で決まる。workerの時計とstateは使わない。
判定と更新は1つの文で行う。その版への成功した行が無ければ、何も解決しない。

この条件には、次の意味がある。

- 普通の反映では、自己更新が成功の行を記録する。それより前に作られた停止のnoticeは、古い版を名指しするので解決される。版が一致した場合も同じである。
- 反映が止まったままなら、新しい成功の行が無いので、noticeは残る。
- `deployed_sha`を過去に成功した版へ書き戻しても、その成功の行より後に作られたnoticeは解決されない。
- stateを書き換えても、解決には影響しない。
- 自己更新が変数を更新した後、記録の前に動いた回は、成功の行がまだ無いので何も解決しない。次の実行が、記録された行を見て解決する。
- 自己更新が変数をself cloneのHEADへ更新した後、変更したパスの取得か反映の記録が失敗すると、その版への失敗の行だけが残る。次の回は版が一致して「変更なし」で終わり、成功の行が作られない。この間に作られた停止のnoticeは、次に別の版の反映が成功するまで残る。人が解決してよい。
- 人が変数を今のHEADへ手で書き換えて版を一致させたときも、その版への成功の行が無いので、止まっていた版を名指しするnoticeは自動では解決されない。人が解決してよい。

解決を先に行うので、その後で残す新しいnoticeは、成功の行より後に作られ、解決されない。
ただし、`poll_issues`が変数を読んだ後、noticeを作る前に、`self_update`が反映を終えて成功を記録することがある。
このとき、古い版を名指しするnoticeが、成功より後の時刻で作られる。
このnoticeは、次に別の版の反映が成功するまで残ることがある。
人がConsoleで解決してよい。
解決したあとも、self cloneのHEADが反映済みの版と一致していれば、noticeは再び作られない。
解決の失敗は警告のログだけにし、判定と通知は続ける。
反映が進んだときに、新しい版のstateを記録できなければ、通知へ進む。
版が一致してもstateのキーを消せなかったとき、またはstateを読めず消さなかったときは、古い記録が残る。
次のmergeで同じ版の食い違いが起きると、猶予を待たずに通知することがある。次に版が一致すれば、自動で解決される。
stateは、このキーだけを書き換え、消すときもこのキーだけを除く。ほかのキーは保つ。

Issueの取得に成功すると、`poll_issues`は未解決の`labeler_denied`を解決済みにする。
対象は、本文が`<owner>/<repo>#<番号>:`と空白1つで始まるすべてのnoticeで、`resolved_by`は`poll_issues`になる。
PRのトリガーラベルの取得に成功したときは、`poll_prs`が、同じPRと同じラベルの未解決の`labeler_denied`を、本文の完全一致で解決済みにする。
`resolved_by`は`poll_prs`になる。
解決に失敗しても取得の成否は変わらず、警告をログに残す。
この種類はConsoleから解決できない。運用者が内容を確かめないまま消せると、許可されていない人の操作が見えなくなるためである。
許可された人が付け直して取得できたときは、見送りの原因が解けているので、機械が解決しても、この目的と両立する。

`poll_prs`は、PRの作業を始めた後に、そのPRとラベルの未解決のnoticeを解決済みにする。
作業の開始が例外になったときは解決しない。
対象は、確認できずにラベルを戻したときの`claim_race_lost`と、`pr_trigger_label_left_removed`である。
本文が完全に一致する行だけを選ぶので、`review`と`review-fix`のようにラベル名が互いの接頭辞でも、別のラベルの行には触れない。`resolved_by`は`poll_prs`になる。

`pr_trigger_label_left_removed`は、ラベルが外れたままのPRを検出した場所で、PRごとにすぐ残す。
Discordの通知が届かなくても、Consoleから該当のPRを確かめられる。
記録に失敗しても、警告のログを残すだけで、Discordの通知は送る。この種類は、人がConsoleから解決できる。

解決済みのnoticeは、解決してから`retention_logs_days`(既定30日)を過ぎるとDBの掃除が消す。解決の時刻(`resolved_at`)が無い行は、作成の時刻から数える。
重要度が「情報」の未解決のnoticeは、作成から同じ期間を過ぎると、削除せず解決済みへ変える(`resolved_by`は`cleanup_db`)。
Consoleの一覧から7日で外れて誰も解決しないため、溜まり続けるからである。
機械が黙って消さず、解決済みの履歴に痕跡を残す。その後は、解決の時刻から同じ期間で消える。
「要対応」の未解決のnoticeは消さない。

noticeには重要度がある。種類ごとの重要度と、Consoleから解決できない種類は、`lib/console_support.ts`が定める。表に無い種類は「要対応」として扱う。解決できる種類は、`notice_resolve`が1件ずつ解決し、解決者(`resolved_by`)と時刻を残す。

## GitHub APIのrate limit

GitHub APIの呼び出しは`f/factory/lib/github.ts`が`gh api -i`で行う。応答のヘッダーを、2回目の要求なしに読むためである。

### rate limitと判定する応答

HTTP 403か429で、次のどちらかを満たす応答をrate limitとみなす。

- `retry-after`ヘッダーがある。
- `x-ratelimit-remaining`が`0`である。

GraphQLでは、HTTP 200で`errors[].type`が`RATE_LIMITED`の応答を一次レート制限とみなす。

### 待って再試行する

RESTのrate limitでは、解除まで待って1回だけ再試行する。待つ時間は次の順で決める。

1. `retry-after`ヘッダー(秒)。
2. `x-ratelimit-reset`の時刻までの時間に、1秒の余裕を足したもの。ヘッダーの時刻は秒単位で、workerとGitHubの時計もずれうるので、解除の直前に再試行してまた拒まれないようにする。
3. どちらも無ければ60秒。

待つのは最大120秒(`GITHUB_RATE_LIMIT_MAX_WAIT_MS`)である。1回の待ちは、どのステップのtimeoutよりも短い。最も短いのはPRの修正の指摘の収集の600秒なので、1つのステップで何度か待っても打ち切られない。

この範囲で待てるのは、search APIの1分ごとの上限と、`retry-after`のある二次レート制限(多くは60秒)である。1時間ごとの一次レート制限を使い切ったときの待ちは収まらない。

### 待てないときは失敗する

次のときは、`GitHubRateLimitError`を投げてステップを失敗させる。

- 必要な待ちが120秒を超える。この場合は待たない。
- 待って再試行しても、またrate limitで拒まれた。
- GraphQLの一次レート制限に当たった。この場合は待たない。

メッセージは`GitHub rate limit on <endpoint>: ... (rerun after the limit resets)`の形である。投げるのは要求がGitHubに拒まれた後なので、その要求の副作用は起きていない。

ジョブが失敗した作業項目は、解除を待ってからConsoleの**失敗**タブで再実行する。
人の対応待ちの通知でも、rate limitが原因のときは、次の操作に解除を待ってから再実行するよう表示する。
人の対応待ちの作業項目は、`job_failures`の行が無ければ**失敗**タブに出ないので、Windmillで`retry_work_item`を実行する。rate limitで失敗したときに各ステップが何を済ませているかは、[実装フローの仕様](implement.md)と[PRワークフローの仕様](pr-workflow.md)にある。

## GitHub APIの一時的な失敗

rate limitのほかに、次の3つの一時的な失敗は、`f/factory/lib/github.ts`が短く待って1回だけ再試行する。PRとIssueのポーリングは5分ごとに動くので、一過性の失敗でその回の検出が抜けることを防ぐ。

| 失敗 | 判定 | 再試行する要求 |
| --- | --- | --- |
| ghプロセスの起動失敗 | `Bun.spawn`の失敗を表す`SpawnError`で、コードが`EAGAIN`、`EMFILE`、`ENFILE`、`ENOMEM`(資源の一時不足) | すべての要求 |
| ステータス行の無い失敗(通信断など) | 標準出力にステータス行が無く(HTTP 0)、プロセスがtimeoutしていない | GETと、読み取りのGraphQL(`listReviewThreads`) |
| サーバーエラー | ステータスが500から599 | GETと、読み取りのGraphQL(`listReviewThreads`) |

待つ時間は2秒(`GITHUB_TRANSIENT_RETRY_DELAY_MS`)である。テストでは`GhClient`の`transientRetryDelayMs`と`sleep`で差し替える。再試行は要求ごとに1回までで、rate limitの再試行とは別に数える。rate limitの待ちの上限は変わらない。
rate limitの再試行の中でも一時的な失敗の再試行が起こりうるので、1回の`callGhApi`でghを最大4回起動する。

### 変更を伴う要求を再送しない理由

起動に失敗した要求はGitHubに届いていない。そのため、コメント、レビュー、ラベル、PRの作成でも、再送して二重にならない。
`SpawnError`は`Bun.spawn`の呼び出しだけを包む。起動の後の失敗(出力の読み取りの失敗など)は、同じコードを持っていても対象にしない。

通信断では、要求が届いた後で応答だけを失った可能性がある。届いていた場合に再送すると、コメントやレビューが二重に投稿され、PRやIssueが重複して作られる。
そのため、GETでない要求は通信断を再試行せず、HTTP 0の失敗として記録する。GETでない要求とは、POST、PUT、PATCH、DELETEである。GraphQLはqueryでもPOSTで送るので含む。

サーバーエラーでも、変更が途中まで効いている可能性は通信断と同じである。
そのため、5xxを再試行するのもGETと読み取りのGraphQLだけで、GETでない要求は5xxの応答のまま失敗にする。
例外として、読み取りのGraphQL(`listReviewThreads`)だけは、呼び出し側が冪等だと明示して再試行する。mutation(`resolveReviewThread`)は再試行しない。

### 再試行しないもの

次の失敗は、再試行せずに記録する。

- HTTPの4xx応答。応答が返っているので、呼び出し側が失敗として扱う。
- 待っても直らない起動の失敗。ghの実行ファイルが無い場合(`ENOENT`)と、実行権限が無い場合(`EACCES`)である。
- ghプロセスのtimeout。待ちが長引き、ステップのtimeoutに近づくため。
- 再試行しても失敗したもの。起動失敗は元のエラーで、通信断はHTTP 0の失敗で、サーバーエラーはその5xxの応答のままステップを失敗にする。
