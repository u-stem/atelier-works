# 通知とrate limit

Factoryが人に知らせる仕組みと、GitHubとDiscordのrate limitに当たったときの挙動、GitHub APIの一時的な失敗の再試行を定める仕様である。通知を変更する人が、どの処理が何を送り、失敗したらどうなるかを確かめるために読む。通知を受けた人がすることは[運用](../operations.md)にある。

## 知らせる経路

Factoryは、知らせる内容によって経路を使い分ける。

| 経路 | 載せるもの | 実装 |
| --- | --- | --- |
| Discordの通知 | 人の行動が要るイベントと、日次サマリー | `f/factory/lib/discord.ts` |
| Consoleの**要対応**と**システム** | Discordに送らない事項(notice)。要対応の通知は**要対応**に、情報の通知は**システム**に出る | `factory.notices`、`addNoticeUnlessUnresolved` |
| Consoleの**要対応**と**システム** | フローとスケジュールの失敗の記録。作業項目の失敗は**要対応**に、作業項目に紐づかない失敗は**システム**に出る | `factory.job_failures`、`recordFailure` |
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
| `intake_refreshed` | 取り込み内容を更新 | `requirements_apply` | 却下による作り直しで、取り込んだ題名と本文を現在のIssueの内容に更新した |
| `needs_human` | 人による対応が必要です | 下の表を参照 | 作業項目が人の対応を待つ状態になった。または、Factoryが作ったPRのCIが失敗した |
| `pr_reviewed` | PRレビュー完了 | `pr_review_post` | レビューをGitHubに投稿した |
| `pr_fixed` | PR修正適用 | `pr_fix_finish` | 修正をpushし、再レビューを依頼した |
| `job_failed` | ジョブ失敗 | 下の表を参照 | フローやスケジュールが失敗した |
| `console_fetch_problem` | Consoleの取り込みに問題があります | `console_fetch_watch`(10分ごと) | Consoleの取り込みの失敗、更新の停止、状態が読めないことを検知し、通知を新しく残した |
| `console_worker_check_failed` | Console用のworkerの動きを確かめられません | `self_update`(2分ごと) | Console用のworkerがジョブを受けているかを、最初に確かめられなかった時刻から1時間続けて確かめられなかった |
| `console_worker_missing` | Console用のworkerがジョブを受けていません | `self_update`(2分ごと) | tag `console`のジョブが予定時刻から5分以上待たされていることを検知し、通知を新しく残した |
| `periodic_worker_missing` | 定期ジョブ用のworkerがジョブを受けていません | `self_update`(2分ごと) | tag `periodic`のジョブが予定時刻から11分以上待たされていることを検知し、通知を新しく残した |
| `github_collect_stale` | GitHubの収集が止まっています | `self_update`(2分ごと) | 設定の所有者の収集が閾値を超えて成功していないこと、または所有者の収集は成功していても一部のリポジトリの記録が閾値を超えて古いことを検知し、通知を新しく残した。`repo_allowlist`が空で、設定により収集が止まっていること(収集の無効)を検知したときも、通知を新しく残した。定期ジョブ用のworkerの停止を同じ回に検知したときは残さない。ただし、収集の無効は設定の事実なので、停止の間も残す |
| `default_worker_missing` | defaultのworkerがジョブを受けていません | `default_worker_watch`(5分ごと) | defaultのworkerが受けるtagのジョブが予定時刻から10分以上待たされていて、defaultで動いているジョブが1つも無いことを、60秒おいた読み直しでも確かめ、通知を新しく残した。長いジョブが枠を埋めて待たせているだけでは残さない |
| `host_action_required` | ホスト側の作業が必要です | `self_update`(2分ごと) | 反映した版に、worker自身では反映できない変更(`infra/`、`mise.toml`の`[tools]`・`[env]`)があり、ホストがまだ反映しておらず、通知を新しく残した |
| `main_ci_failed` | mainのCIが失敗しました | `watch_main_ci`(5分ごと) | 対象リポジトリのmainのコミットでCIが失敗し、通知を新しく残した |
| `daily_summary` | 日次サマリー | `notify_daily_summary`(毎日09:00) | 集計の対象の日の、実行回数、コスト、失敗、要件定義の承認・却下の件数、DBの掃除の件数、workerの負荷、`gated`のときの投稿しなかったレビューの期間と件数 |
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
| `auto_retry_pr_review` | GitHubの一時的な失敗で止まったPRレビューが、再開の待ちに猶予の30分を足しても再開されないまま残った。または、自動の再開を3回行っても直らなかった。フローを起動できなかった再開も、再開の遷移で1回に数えて失敗に戻すので、使い切れば同じ通知になる。そのときの次の操作は、Windmillでフローを起動できる状態の確認になる。対象のPRにリンクし(リポジトリ名が不正な行はリンクを省く)、理由と`retry_work_item`を作業項目のIDで実行する次の操作を載せる。届いたときだけ記録し、届くまで巡回の間隔の5分ごとに送り直す |
| `pr_fix_finish` | 修正が人の対応待ちで止まった。Issue化の提案がある |
| `watch_pr_ci` | Factoryが作ったPRのCIが失敗し、通知を新しく残した(理由は`ci_failure`か`ci_other_conclusion`) |
| `poll_dependabot` | dependabotのPRを人に回すと決めた。待ちが上限を超えた、収集かゲートが止めた、リポジトリの照合に落ちた、フローの起動に失敗した、などである。作業項目を作った直後に人の対応待ちにして、1回だけ送る |
| `dependabot_prepare`、`dependabot_finish` | dependabotのフローが、自動でマージできないと判断して人に回した。影響の所見を投稿し、修正のラベルを人に付けてもらうときと、試運転でマージ可と判定したときも送る |

`poll_issues`が、1回のポーリングで複数のIssueについてラベルを外した結果を判断できなかったときは、Issueごとに送らず、リンクを並べた1件の通知にまとめる。
各行は`owner/repo#番号`とリンクで、タイトルとリンクの先は先頭のIssueである。
並べるのは10件までで、残りは件数で示す。
`poll_prs`が、1回のポーリングで複数のPRについてラベルが外れたままになったときも、PRごとに送らず、リンクを並べた1件の通知にまとめる。
各行は`owner/repo#番号`とリンクと外れたラベルで、リンクの先は先頭のPRである。
並べるのは10件までで、残りは件数で示す。

ジョブ失敗(`job_failed`)の通知を送る処理は次のとおり。

| 処理 | 送るとき |
| --- | --- |
| `on_error_flow` | フロー(pipeline、implement、pr_review、pr_fix、manual_intake、dependabotなど)が失敗した。設定を読めないときも、インスタンス名を`unknown`にして送る。GitHubの一時的な失敗で止まったPRレビューは、作業項目を`failed`にでき、再開の巡回の対象になるときだけ送らない。`failed`にできなかったときと、同じPRに置き換えた行か並走する行があるときは、巡回が拾わないので`job_failed`を送る |
| `on_error_schedule` | スケジュールのジョブが失敗した。同じスケジュールの連続した失敗の初回と、前回の失敗からエラー文が変わったときだけ送る。以降の同じ失敗は、下の`schedule_failing`に任せる。直前の実行(飛ばされた回と人が取り消した回を除く)が成功なら初回である。失敗なら、その実行のジョブIDを持つ`job_failures`の最新の行(`step`がNULL)のエラー文と比べる。ジョブ履歴、その記録、直前の実行のどれかを読めないときや、記録が別の実行のものなら、送る側に倒す。`schedule_failing`のnoticeを新しく残したときは、Discordにも`job_failed`を送り直す。初回の通知が届かなかった連続を、Discordで見落とさないためである。GitHubのPATの失効は、`poll_issues`の冒頭の確認が失敗してここに来る。直近3回の実行(飛ばされた回と人が取り消した回を除き、ジョブの上限で打ち切られた回は、`canceled_by`が`timeout`の取り消しとみなして失敗に数える。この値は実機で未確認である)が続けて失敗すると、要対応の通知`schedule_failing`も残す。ジョブ履歴を読めないときは、`schedule_failing_check_failed`を残す |
| `poll_issues`の点検 | 閉じたIssue・PRや孤児のジョブを見つけ、作業項目を取り消しか失敗にした。dependabotの作業項目を、PRが閉じたことで終えたときは送らない。マージされていればマージ済みとして記録し、マージされずに閉じたのはdependabotが置き換えたPRを自分で閉じた場合で、どちらも人の行動が要らないためである |
| `requirements_apply` | 承認の反映の処理が例外で終わった。却下の後の作り直しを起動できなかったときも含む |
| `issue_proposal_apply` | Issue化の提案の反映が失敗した |

### 種類ごとに載る項目

どの通知にも、送ったインスタンスを示す「インスタンス」の欄が付く。`instance_name`と対象のGitHubのオブジェクトを特定する値は、どの種類の`NotifyEvent`も持つ。埋め込みを、ほかの情報を引かないで組み立てるためである。

| 種類 | リンク先 | 主な欄 |
| --- | --- | --- |
| `issue_claimed` | Issue | リポジトリ |
| `approval_requested` | Consoleの承認の画面 | リポジトリ、Issue |
| `requirements_approved` | Consoleの要件定義のページ | リポジトリ、Issue |
| `intake_refreshed` | Issue | リポジトリ。説明に、Consoleで更新後の内容を確かめる旨 |
| `needs_human` | 対象のIssueかPR | 説明に理由、「次の操作」、リポジトリ |
| `pr_reviewed` | PR | 説明に今回の指摘の件数と状態 |
| `pr_fixed` | PR | 再レビュー依頼のAPIが失敗したときだけ「補足」 |
| `job_failed` | なし。dependabotのフローではPR | 説明にエラー、ジョブのID。dependabotのフローでは「次の操作」と「対象」 |
| `console_fetch_problem` | なし | 説明に原因、「次の操作」 |
| `console_worker_check_failed` | なし | 説明に原因、「次の操作」 |
| `console_worker_missing` | なし | 説明に原因、「次の操作」 |
| `periodic_worker_missing` | なし | 説明に原因、「次の操作」 |
| `github_collect_stale` | Consoleの通知 | 説明に閾値と最後の成功と最新の実行の原因(リポジトリ単位の古さでは、記録が古いリポジトリの数と理由別の内訳。収集の無効では、止まっている設定と、設定を戻すか`repo_allowlist`に並べる操作)、「次の操作」、所有者 |
| `default_worker_missing` | なし | 説明に原因、「次の操作」 |
| `host_action_required` | なし | 説明に反映した版と変わったパス、「次の操作」 |
| `main_ci_failed` | 失敗した実行 | 説明にコミットの先頭7文字、「次の操作」、リポジトリ |
| `daily_summary` | なし | 説明に実行件数と費用、失敗、承認、却下、DB掃除、workerの負荷、`gated`のときだけ「レビューの投稿」 |
| `audit_completed` | Consoleの監査のページ | 「次の操作」、`work_item_id` |
| `pr_opened` | PR | 「次の操作」、Issue、「確認して欲しい点」、ラウンドと費用、差分 |

人の対応待ちの通知には、対象(PRかIssueとその番号)、起きたこと、次の操作を必ず載せる。題名とリポジトリだけでは、読み手が次に何をすべきか分からないためである。

次の操作は、理由の文から`pr_workflow_support.ts`の`nextActionFor`が決める。

- 同じ理由でも、実装フローとPRの修正で次の操作が変わるものは、フロー(`NextActionFlow`)を渡して選ぶ。
- 再実行を案内するときは、Windmillで`f/factory/retry_work_item`を作業項目のIDで実行するよう書く(`RETRY_WORK_ITEM_ACTION`)。通常の回の作業項目には、どの種別と状態でも使えるためである。CIの失敗を直す回は例外で、次の項目に続く。
- dependabotの作業項目の理由では、フロー`dependabot`を渡して、再実行を案内しない文を選ぶ。`retry_work_item`はdependabotの作業項目を再開しないためである。フローの失敗の通知(`job_failed`)も、この規則で次の操作を選ぶ。
- CIの失敗を直す回で止まった作業項目では、理由の種類によらず、再実行を案内しない。保留の理由に写せる理由はその固定文、写せない理由はPRへのpushの案内にする。人が基盤を直す手順がある理由は、手順を残して再実行の部分だけを差し替える([PRワークフロー](pr-workflow.md)の「CIの失敗を直す回」)。
- どの規則にも当たらない理由では、`GENERIC_NEXT_ACTION`の文になる。通知の理由とConsoleの**システム**で原因を確かめて取り除き、`retry_work_item`を実行するよう求める文である。

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
| 修正必須の指摘が未解決(`changes_requested`) | 今回の指摘に`[MUST]`があるか、未解決の`[MUST]`のスレッドが残っている |
| 未解決の指摘を読み取れず未確認(`unverified`) | 今回の指摘に`[MUST]`が無く、再レビューで未解決のスレッドの一覧を読めなかった。残りの有無が分からず、人がPRで確かめる |
| 修正必須の指摘なし(`reviewed`) | 上記以外。`[IMO]`、`[NITS]`、`[Q]`が残っていてもこの状態になり、人のApproveを待つ |

一覧を読めなかったときに0件として数えると、未解決の`[MUST]`が残るPRを、人のApproveを待てる状態と示してしまう。そのため、`reviewed`とは別の状態にする。

ConsoleのPR詳細のレビュー行も、同じ状態を出す。
投稿の時点の値を`factory.reviews`の`result`に記録しておくので、今回の指摘が0件でも、未解決の`[MUST]`が残る再レビューは「修正必須の指摘が未解決」と出る。
結果を記録する前に作られた行と、一覧を読めず結果を判定できなかった行は、「修正必須の有無の記録なし」と出る。

PR作成・更新の「確認して欲しい点」には、変更された保護パスを並べる。実装フローは保護パスが変わっても止まらないので、人が先に確かめるためである。検査コマンドを動かさなかったラウンドでは、説明に「検査未実施」と理由が出る。

日次サマリーの「DB掃除」欄は、集計の対象の日のDBの掃除の記録(`cleanup_runs`)から作る。その日の記録が無ければ「その日の掃除記録なし」になる。
集計の対象の日は、通常は前日である。
予定が飛んだ日は、最後に出した日の翌日から古い順に、1日ずつ追い付いて出す。
stateは常に次に出す日の前日を指し、送る前に出す日の最初の日の前日へそろえて保存する。
集計が例外になった日も、Discordに届かなかった日も、そこで止まり、stateを進めない。
集計が例外になった回は、ジョブが失敗になる。
stateが空でも、読めない値でも、未来の日付でも、次の実行は止まった日から始まる。
届かなかった日が前日なら、次の実行が出し直すので、警告だけで成功として終える。
昨日より古い日が届かないときは、その回のジョブが失敗になる。
運用の扱いは[日次のまとめの追い付き](../operations.md#日次のまとめの追い付き)にある。

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

承認待ちの通知が届かなかったときは、Consoleの**システム**の「情報の通知」に`approval_notify_failed`のnoticeを1件残す。通知が無いと、人が承認依頼に気づけないためである。webhookを設定していないときは、Consoleを見る運用なので残さない。noticeの記録が失敗しても、warnを残すだけで例外は投げない。

### 通知を送らない場合

通知は、人の行動が要るものだけを送る。

- 再レビューを依頼する相手がいないときと、候補が全員除外された(PRの作成者かFactoryのアカウント)ときは、通知とnoticeのどちらも残さない。想定内で人がすることは無いので、作業項目の`status_reason`にだけ残す。PR修正適用の通知が、再レビューを依頼したという結果を既に伝えている。
- 再レビュー依頼のAPIの呼び出しが失敗したときは、人がGitHubでレビュアーを依頼する必要がある。PR修正適用の通知の「補足」欄に載せ、`pr_fix_reviewer_request_failed`のnoticeにも残す。依頼の前のPRの取得(`getPr`)の失敗と、Botや削除済みの作成者の名前で依頼を組み立てられない場合も、この扱いになる。
- 承認のコメントをIssueに投稿できなかったときは、Discordには知らせず、`approval_comment_failed`のnoticeだけを残す。承認の通知はそのまま送る。
- 実装フローが取得したIssueの題名か本文が取り込み時点と違っても、通知はしない。PR本文の「確認して欲しい点」に1行書くだけである。
- 監査のスキップと、提案が0件の監査は通知しない。
- レビューを投稿しなかったとき(`review_post_mode`が`gated`)は、PRレビュー完了の通知を送らない。投稿を承認する画面はまだ無く、人が進める操作も無いためである。作業項目の状態は`reviewed`に進み、状態遷移の記録(`work_item_events`)の補足に、投稿しなかった旨を残す。結果はConsoleの作業項目の詳細で確かめられる。判定は設定値ではなく、実際に投稿したかで行う。
- `gated`が続いても、通知は日次のまとめと、一定の日数を超えたConsoleの要対応のnoticeだけである([レビューを投稿しない状態の継続](#レビューを投稿しない状態の継続))。

## Consoleのnotice

noticeは`factory.notices`の1行で、種類(`kind`)と本文(`message`)を持つ。本文には、対象を`<owner>/<repo>#<番号> (work item <id>)`の形で載せるものが多い。

| 種類 | 記録する処理 | 本文に載るもの |
| --- | --- | --- |
| `approval_notify_failed` | `pipeline_request_approval` | 対象、送れなかった理由 |
| `approval_comment_failed` | `requirements_apply` | 対象、理由、要件定義を開くConsoleのリンク |
| `intake_refreshed` | `requirements_apply`、`retry_work_item` | 対象、Consoleで更新後の内容を確かめる旨 |
| `implement_launch_failed` | `requirements_apply` | 対象、理由、次の操作 |
| `implement_needs_human` | `implement_finish` | 対象、止まった理由 |
| `unsandboxed_check_commands` | `implement_verify`、`pr_fix_verify` | 実行する検査コマンドの件数、対象 |
| `check_slot_skipped` | `implement_verify`、`pr_fix_verify` | 飛ばした枠のユーザーとuid、片付けられなかった理由 |
| `check_slot_record_unreadable` | `implement_verify`、`pr_fix_verify` | 枠のユーザーとuid、読めない記録を退避した先のパス |
| `check_runtime_unsafe` | `implement_prepare`、`implement_verify`、`pr_fix_prepare`、`pr_fix_verify`、`cleanup_workspaces`、`watch_pr_ci` | 稼働中のworkerにできた誰でも書き込めるパスか、確かめられなかった理由、パスを閉じるかworkerを作り直す手順 |
| `github_collect_stale` | `self_update` | `<所有者>:`と空白と、最新の実行の記録を確かめる固定の文。リポジトリ単位の古さでは、`<所有者>のリポジトリ:`と空白と、収集のログを確かめて対象を絞る固定の文。収集の無効では、`<所有者>の収集の無効:`と空白と、設定を戻すか`repo_allowlist`に並べる固定の文 |
| `fix_reply_post_failed` | `pr_fix_finish` | 失敗した件数、`review_comment_id`、最初のエラー |
| `pr_fix_reviewer_request_failed` | `pr_fix_finish` | 対象、依頼できなかった理由 |
| `issue_proposal_record_failed` | `pr_fix_finish` | 対象、記録の失敗の理由 |
| `fix_feedback_association_excluded` | `pr_fix_collect` | 対象、除外した投稿者 |
| `labeler_denied` | `poll_issues`、`poll_prs` | 対象、許可されていないトリガーラベル |
| `fork_head_denied` | `poll_prs` | 対象のPR |
| `labeler_check_limit` | `poll_issues`、`poll_prs` | 対象、付与者を判定できないトリガーラベル、付け直す操作 |
| `owner_id_mismatch` | `poll_issues`、`poll_prs`、`collect_github`、`pipeline_prepare`、`implement_prepare`、`pr_fix_prepare`、`pr_review_prepare`、`manual_intake_create_issue`、`issue_proposal_apply`、`implement_finish`、`pr_fix_finish`、`pr_review_post` | オーナー名かリポジトリ名、設定のID、食い違いのときはGitHubの現在のID、`owners`を見直す操作 |
| `factory_repo_id_mismatch` | `self_update`、`poll_issues`、各フローのprepare、`pipeline_generate`、`manual_intake_create_issue`、`issue_proposal_apply`、`drawio_viewer_bump` | リポジトリ名、設定のID、食い違いのときはGitHubの現在のID、`factory_repo`と`factory_repo_id`を見直す操作 |
| `claim_race_lost` | `poll_issues`、`poll_prs`、`manual_intake_register` | 対象、取得できなかった理由 |
| `claim_assignee_missing` | `poll_issues` | 対象、assigneeにできなかったユーザー、確かめる点 |
| `pr_trigger_label_left_removed` | `poll_prs` | 対象のPRと、外れたままのトリガーラベル |
| `supersede_failed` | `insertIssueWorkItemUnlessActive`(`poll_issues`が呼ぶ) | 対象、新しい作業項目のID、操作が要らないこと |
| `deployed_sha_mismatch` | `poll_issues` | `f/factory/deployed_sha`、原因の候補 |
| `host_action_required` | `self_update`、`implement_verify`、`pr_fix_verify`、`watch_pr_ci` | 反映した版(40桁)、変わった`infra/`や`mise.toml`のパスかイメージに足りないもの、`mise run up`を実行する手順 |
| `cleanup_db_failed` | `cleanup_db` | 削除に失敗した対象とエラー |
| `cleanup_worktrees_skipped` | `cleanup_workspaces` | 掃除を見送ったリポジトリ |
| `cleanup_worktree_busy` | `cleanup_workspaces` | 作業項目のID、worktreeのパス、worktreeを使っているプロセス |
| `workspace_disk_usage` | `cleanup_workspaces` | 作業領域のディスク使用量(MiB) |
| `main_ci_failed` | `watch_main_ci` | `<owner>/<repo>:`で始まる固定文、コミットの先頭7文字、失敗した実行のリンク、次の操作 |
| `main_ci_check_denied` | `watch_main_ci` | `<owner>/<repo>:`で始まる固定文、権限を足す操作 |
| `pr_ci_failed` | `watch_pr_ci` | `<owner>/<repo>#<PR番号>:`で始まる固定文、コミットの先頭7文字、理由コード、自動修正の保留の理由(あれば)、リンク、次の操作 |
| `pr_ci_check_denied` | `watch_pr_ci` | `<owner>/<repo>:`で始まる固定文、権限を足す操作 |
| `config_misfit` | `watch_pr_ci` | PRにも設定の値にも依らない固定文、見直す設定の項目(`claude_timeout_sec`と`allowed_check_commands`) |
| `pr_conflict` | `watch_pr_conflicts` | `<owner>/<repo>#<PR番号>:`で始まる固定文、自動で直さなかった理由(あるときだけ)、次の操作、PRのリンク |
| `worker_load_high` | `sample_worker_load` | 原因(メモリの割合、OOMの増加)、閾値、システムの画面のリンク、次の操作 |
| `review_gated_prolonged` | `notify_daily_summary` | 投稿しない状態が続く日数、作業項目の画面のリンク、次の操作 |

`fix_reply_post_failed`は、返信の投稿に1件以上失敗したとき1件だけ残す。Discordには通知しない。`unsandboxed_check_commands`は、検査コマンドを実行するときに、作業項目ごとに残す。
`check_slot_skipped`は、枠を飛ばすときに残す。Discordには通知しない。
`check_slot_record_unreadable`は、読めない記録を退避するときに残す。退避した記録は読み直さないので、同じ記録では1回だけ残る。Discordには通知しない。
検査の枠のnoticeを記録できなかったときは、検査を止めずに`check slot notice could not be recorded`をログに出す。
`cleanup_worktree_busy`は、1回の掃除でworktreeのパスごとに1件残す。同じ本文の未解決のnoticeがあるあいだは、[重複の抑止](#重複の抑止)のとおり新しく作らない。Discordには通知しない。

`main_ci_failed`は、失敗を確定したコミットごとに1件残す。Discordには、noticeを新しく残したときに通知する。同じコミットの本文は同じなので、通常は重複しない。
次のどちらかのときは、noticeとDiscordのどちらも出さない。詳細は[mainのCI監視の仕様](main-ci.md)にある。

- より新しいコミットが既に通っている。
- 最初に見てから24時間以上たち、より新しい行が記録済みである。

本文は固定文で、workflowの名前や結論は載せない。外部の文字列は、`main_ci_runs`の`summary`列にだけ残す。
同じリポジトリのより新しいコミットが通ると、`watch_main_ci`が種類と接頭辞で選んで解決する。
`main_ci_check_denied`は、実行を読めないリポジトリごとに1件残し、Discordには通知しない。読めるようになると、同じ方法で解決する。
詳細は[mainのCI監視の仕様](main-ci.md)にある。

`pr_ci_failed`は、失敗を確定したPRのheadごとに、通常は1件残す。
保留が続いたと知らせた後で決定的な保留へ変わると、2件目が残る。本文は違う([PRのCI監視の仕様](pr-ci.md)の既知の限界)。
Discordには、noticeを新しく残したときに、種類`needs_human`で通知する。リンクはPRのページで、説明に理由コード、「次の操作」を載せる。
自動で直す対象の失敗は、確定した時点では残さず、直せるかが決まってから残す。本文には自動修正の保留の理由を足し、「次の操作」はその理由の固定文にする。リンクはPRのページになる。
直す作業が止まった保留(`fix_stopped`)は、止めたフローがDiscordに通知しているので、noticeだけを残す。
本文は固定文で、workflowの名前、結論、ログは載せない。外部の文字列は、`pr_ci_checks`の`summary`列にだけ残す。
同じheadの再実行が通ったとき、新しいheadが通ったとき、PRが閉じたときに、`watch_pr_ci`が種類と`<owner>/<repo>#<PR番号>:`の接頭辞で選んで解決する。
`pr_ci_check_denied`は、PRか実行を読めないリポジトリごとに1件残し、Discordには通知しない。読めるようになると、同じ方法で解決する。
詳細は[PRのCI監視の仕様](pr-ci.md)にある。

`config_misfit`は、時間設定が修正・検証ステップのtimeoutに収まらないとき、設定全体で1件だけ残す。失敗中のPRの数には依らない。
本文は固定文で、設定の値は載せない。値が変わるたびに別の通知になり、古い1件が残るためである。
Discordには、noticeを新しく残したときに、その回の行のPRを宛先にして、種類`needs_human`で1回だけ通知する。
設定が収まったとき、`watch_pr_ci`が、保留の理由が`config_misfit`の行の保留を外してから、種類で選んで解決する。
詳細は[PRのCI監視の仕様](pr-ci.md#保留した失敗の通知)にある。

`pr_conflict`は、PRの競合1回につき、通常は1件残す。競合のままheadが進んでも、重ねない。
Discordには、通知した時刻を記録できたときに、種類`needs_human`で通知する。
本文は固定文で、PRの題名やブランチ名は載せない。
競合を直す設定が有効なときは、競合の回の開始から猶予(`pr_conflict_fix_notify_grace_min`)が過ぎるまで通知を待ち、その間に直す作業項目を起動する。
最終の保留(人が直す理由)になった行は、猶予を待たずに通知する。
直す作業項目が動いている間は、通知しない。
保留の理由を持つ行を通知するときは、本文に自動で直さなかった理由の固定の説明を足し、Discordの理由を`merge_conflict(自動修正の保留: <理由>)`にする。
「次の操作」は、通常は競合を解消してpushする固定文である。mainの更新が`.github/workflows/`を変えるときだけ、ローカルかwebで解消する案内にする。
競合を直す設定が無効なときは、理由を載せず、設定を足す前と同じ本文で通知する。
競合が解けたとき、PRが閉じたとき、設定が対象から外したときに、`watch_pr_conflicts`が種類と`<owner>/<repo>#<PR番号>:`の接頭辞で選んで解決する。
直す作業項目が成功したときは、通知も、Discordへの成功の通知も出さない。結果は、Consoleの作業項目の状態で読む。
直す作業項目が失敗したときの通知は、`watch_pr_conflicts`だけが出す。競合を直す回のフローは、通知を登録せず、Discordにも送らない。
起動の直後に落ちた作業項目を、`poll_issues`の照合が`failed`にしたときは、照合の`job_failed`も届く。
詳細は[PRのCI監視の仕様](pr-ci.md#競合の検知)にある。

`worker_load_high`は、原因(メモリの割合、OOMの増加)ごとに本文が決まっている。
本文には閾値だけを載せ、測定した値は載せないので、同じ原因の未解決の通知は重ならない。
Discordには通知せず、Consoleの要対応に出す。
閾値を下回っても自動では解決せず、人が確かめて解決する。
判定と既定値の根拠は、[閾値の通知](../operations.md#閾値の通知)にある。

### レビューを投稿しない状態の継続

`gated`のときは、レビューをPRに投稿せず、PRレビュー完了の通知も送らない。
そのまま放置されると、人はレビューが止まっていることに気づけない。
そこで`notify_daily_summary`が、毎日09:00(JST)に次の2つを行う。

- 日次サマリーに、「レビューの投稿」欄を足す。`gated`のときだけ出し、投稿するモードのときは出さない。欄には、投稿しなかった期間と件数が載る。
- 投稿しなかった期間が3日以上になったら、`review_gated_prolonged`のnoticeを残す。Discordには届かず、Consoleの要対応に出る。

期間は、最後に投稿したレビューより後の、投稿しなかった最初のレビューの記録時刻から数える。
欄に出す起点の日付は、JSTの日付である。
設定を変えた時刻は残らないので、`gated`にしてからレビューが1件も無い間は、期間が無く、noticeも出ない。
件数は、同じ起点から数えた、投稿しなかったレビュー(`reviews.posted_review_id`が空の行)の数である。
日次サマリーの各日の欄は、その日の終わりまでの記録で数える。
noticeの本文には日数と件数を載せない。数字は日次サマリーで見る。
種類の未解決のnoticeが1件でもあれば、新しくは足さない。本文のリンクの先が変わっても、重ならないようにするためである。
`review_post_mode`が投稿するモードに戻ったら、次の実行で、種類と本文の固定の先頭が合う未解決のnoticeを自動で解決する。
本文のリンクの先が変わった後でも、古いnoticeを解決できる。
`gated`を意図して続けるときは、人が解決する。解決しても、続く間は翌日の実行で出直す。
集計を読めなかった実行は、noticeを足さず、解決もしない。日次サマリーの欄に、読めなかったことだけを出す。

#### 受け入れた挙動

次の挙動は、人の手間や記録の複雑さに見合わないので、受け入れる。

- 投稿するモードに戻したあと、1件も投稿しないまま`gated`へ戻したときは、前の期間から続けて数える。間に投稿したレビューが1件以上あるときだけ、前の期間が切れる。
- レビューの記録は、終端の作業項目と一緒に`retention_work_items_days`の保持期間で消える。消えると、起点と件数が変わりうる。
- 設定を切り替えた瞬間は、日次サマリーの数字とモードがずれる。サマリーは、実行時点の設定のモードで、その日の終わりまでの記録を読むためである。
- `gated`を意図して続けると、人がnoticeを解決しても、翌日の実行で出直す。

### 重複の抑止

noticeは、作業領域のディスク使用量(`workspace_disk_usage`)を除き、すべて`addNoticeUnlessUnresolved`で作る。
同じ種類と本文の未解決のnoticeがあるあいだは、新しく追加しない。
同じ状況が続く間、スケジュールや実行のたびに、見分けの付かないnoticeが積み上がるのを防ぐためである。
本文が対象(作業項目、PR、版など)で決まるので、対象が違えば別のnoticeになる。
解決済みのnoticeは数えないので、解決した後に同じ状況が起きれば、再び追加する。

DBには、未解決のnoticeの種類と本文のmd5に対する部分一意索引があり、並行した追加の重複も拒む。
`resolved_by`が`migration`の解決済みnoticeは、索引を作るmigrationが、同じ種類と本文の未解決のうち作成が最古の1件を残して解決したものである。

### ディスク使用量のnotice

ディスク使用量のnoticeは、本文に測った使用量が入るので、本文での判定では値が変わるたびに別のnoticeになる。
そのため、作業領域の掃除は`recordWorkspaceDiskUsageNotice`で記録し、本文が違っても未解決のnoticeを1件に保つ。

- 未解決のnoticeがあれば、新しく作らず、本文を新しい使用量に、作成時刻を現在に更新する。時刻の更新は1日の間隔を空けず、記録のたびに行う。掃除は1日1回なので、実質1日1回である。
- 未解決のnoticeが無ければ、1件作る。解決済みのnoticeは変えず、履歴として残る。
- 未解決のnoticeが2件以上あれば、作成が最も新しい1件を更新し、残りを解決済みにする(`resolved_by`は`cleanup_workspaces`)。
- 使用量を測れなかったときは、noticeを作成せず、更新しない。記録に失敗しても、掃除の他の処理の結果は変わらず、警告のログだけを残す。

DBには、この種類の未解決のnoticeを1件までにする部分一意索引(`notices_unresolved_disk_usage_key`)があり、掃除が同時に2つ動いても2件目を拒む。
記録はこの索引を`ON CONFLICT`の衝突先にして、既存の1件の更新に回る。
索引を作るmigrationは、未解決のうち作成が最も新しい1件を残し、残りを解決済みにする(`resolved_by`は`migration`)。

### 作成時刻の更新

既存の未解決のnoticeが重要度「情報」の種類で、作成(`created_at`)から1日を過ぎていれば、作成時刻を現在に更新する。
「情報」のnoticeはConsoleの一覧に作成から7日しか出ず、解決はDBの掃除(既定30日)まで起きない。
更新しないと、状況が続いていても8日目から一覧に出ない。新しいnoticeも作られないためである。
1日の間隔は、スケジュールのたびに行を書き換えないために空ける。
「情報」の種類の一覧は、Consoleの一覧と掃除が使う`INFO_NOTICE_KINDS`と同じものを使う。

「要対応」のnoticeは、Consoleが期間で絞らずに出すので更新しない。
更新すると、詳細の発生時刻と受信箱の並び(作成時刻の降順)が変わるためである。
「要対応」のnoticeの作成時刻は、最初に起きた時刻のままである。
時刻からは、状況が今も続いているかを判断できない。

更新だけの呼び出しは、新しい行のIDを返さない。Discordの通知を、追加したときだけ送る呼び出し元の動作は変わらない。
更新は「情報」のnoticeの作成時刻を進めるので、時刻を基準にする集計と処理には次の影響がある。

- 監査の通知の集計は、更新された未解決のnoticeを、更新後の時刻の期間に数える。更新の前の期間を後から集計すると、その通知は含まれない。
- 古い情報のnoticeを解決済みにする掃除は、更新後の時刻から保持期間を数える。状況が続く間は解決済みにならない。

### 反映の順序

`self_update`は、`wmill sync push`を先に、`wmill datatable migrate up`を後に実行する。
両者の間は通常数秒で、新しいコードの`ON CONFLICT`が索引なしのまま失敗しうる。
migrationが失敗したときは、次の自己更新(2分後)まで、noticeを作れない。migrationの失敗は、自己更新の失敗として知らされる。
どちらも受け入れる。

### 種類ごとの記録の条件

`supersede_failed`は、新しいサイクルの挿入の後に、古い承認済みの作業項目を取り消す文が失敗したときに残す。Discordには通知しない。
`deployed_sha_mismatch`は、反映が止まったときだけ残す。
mergeの直後から自己更新が反映するまでの間は、版が必ず食い違うためである。
`poll_issues`は、食い違いを最初に見た時刻を、このスケジュールのWindmillのstateのキー`deployed_sha_check`の下に保存する。
mergeから反映までの通常の見込みは17分である。
内訳は、自己更新の周期の2分、反映の外部コマンド2回の10分(1回の上限は5分)、`poll_issues`の周期の5分である。
`poll_issues`の5分は、食い違いを最初に見た時刻から数えるための見積もりとする。
猶予の30分は、この17分に余裕を持たせて決めている。
17分は実測の上限ではない。
自己更新の1回の実行は、最悪で約52分(ジョブの上限は3100秒)かかる。
ロックの待ち(最大5分)と、ネットワークを使うgitが加わるためである。
このため、正常な反映でも30分を超えうる。
このほかに、defaultの枠が埋まっていると、実行の開始前に待たされる。
食い違いが30分を超えて続いたときに、1件残す。
超えたときは通知が出るが、反映が成功すると自動で解決される。
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

`host_action_required`は、`self_update`が反映の記録を`deployments`へ入れた後に残す。
対象は、`infra/`か`mise.toml`の`[tools]`・`[env]`を変える版である。
本文は、反映した版(40桁)と変わったパスで決まる。同じ版で通知が重なるのは、同じ本文の未解決のnoticeがあるあいだは追加しないためである。
パスは10件まで並べ、残りは件数で示す。
Discordには、noticeを新しく残したときだけ送る。noticeの記録とDiscordの送信が失敗しても、反映は成功のまま終わり、警告のログだけを残す。

実装とPR修正の準備と検証のステップと、作業領域の掃除も、workerのイメージが古く検査コマンドを実行できないときに`host_action_required`を残す。
本文には、自己更新が反映した版(`f/factory/deployed_sha`)と、イメージの満たさない前提(足りない道具、枠のユーザー、ベースのイメージが開いたままのディレクトリ)が載る。
稼働中のworkerの問題も一緒に見つかれば、その問題はこの本文に載せず、下の`check_runtime_unsafe`に残す。
この通知は`mise run up`の後に自動で解決されるが、ボリュームのマウントポイントは作り直しでは閉じないためである。
CIの失敗を直す回は、監視(`watch_pr_ci`)が起動の前に同じ確認をして、同じ通知を残す。
その回は止まった作業項目を作らず、行を保留する。環境を直すと、保留は次の巡回で自動的に外れる。
同じ本文の未解決のnoticeがあるあいだは追加しない。
版を40桁で読めたときは、下の判定で自己更新が自動で解決する。読めないときは本文に版を含めず、人が解決する。
通知が自動で解決されると、止まった実装とPR修正を自動で再開する([実装フロー](implement.md#イメージが古くて止まったとき))。
CIの失敗を直す回は再開しない。
人が解決した通知では再開しない。
下の判定のうち内容の比較も、この通知に及ぶ。
workerのイメージを作る`infra/`と`mise.toml`がHEADと同じなら、イメージもその版の前提を満たすはずだからである。
`mise.local.toml`の上書きのように、gitで追跡しない値が原因のときも解決されうる。
そのときは、次に検査コマンドを実行できなかった作業項目が、通知を残し直す。
Discordには送らない。止まった作業項目の通知が、別に届くためである。
noticeを記録できなくても、作業項目は止まり、警告のログだけを残す。

解決は、`self_update`が反映の要否によらず毎回、反映の判断と記録の後に行う(`resolved_by`は`self_update`)。
解決の処理が遅れても、反映を遅らせないためである。
判定の入力は、ホストのcheckoutのHEADである。
`mise run up`と`mise run deploy`が、Caddyの再起動と`caddy validate`の後に、`/var/lib/factory/host_applied_sha`へ書く。
一時ファイルに書いて`mv -fT`で置き換えるので、読む側は書きかけの値を読まない。

判定は2段で行う。

1. noticeの版が、このHEADと同じか、self cloneの履歴でHEADの祖先なら、反映済みとする(`git merge-base --is-ancestor`)。
   ホストがその版以降を含んで起動し直されたことを示すためである。
2. 祖先でなければ、HEADとnoticeの版で内容が異なるパスを挙げ(`git diff --name-only --no-renames -z`)、`classifyChangedPaths`で分類し直す。
   ホスト側の作業を要するパスが1つも無ければ、反映済みとする。
   PRのブランチで先に`mise run up`してからマージすると、マージの版はHEADの祖先にならないが、反映すべき内容は同じだからである。

反映を記録するときも、未解決のnoticeを解決するときも、同じ判定を使う。
比べるのは、その回の変更のパスに限らず、`infra/`と`mise.toml`のすべてである。
その回の変更のパスだけを比べると、並行する2つのPRを両方とも先に`mise run up`してからマージしたときに、もう一方のPRの`infra/`の違いを見落とすためである。
解決するときは、noticeの本文のパスを使えない。置き換えと省略を経ていて読み戻せないためである。

`mise.toml`は、`[tools]`と`[env]`を取り出さず、ファイル全体で比べる。
節を取り出すには版ごとにファイルを読む必要があり、gitを呼ぶ回数が増えるためである。
`[tasks.*]`だけが違うときも反映済みとしないので、通知が残ることはあっても、反映していない変更を見逃すことはない。
異なるパスの一覧が1MiBを超えたときは、全部を読めないので、内容を比べずに反映済みとしない。

印は、symlinkでない通常のファイルで、128バイト以下のときだけ読む。読むのは先頭の64バイトである。
self cloneにあるかは、実行ごとに1回だけ`git cat-file -e`で確かめる。無ければ、全件を1回の警告で飛ばす。
印のファイルが無いだけのときは、警告を出さない。

1回の実行で調べる未解決のnoticeは、本文から版を読めたものの古い順に3件までである。
版を読めないnotice(本文が書き換えられたものなど)は、枠を使わない。
通知ごとにgitを最大2回呼ぶので、数を固定して最悪の長さを抑える。
残りは、解決が進んだ次の回に調べる。

反映を記録するとき、印がその版を含むか、内容が同じなら、noticeとDiscordのどちらも出さない。
運用者が先に`mise run deploy`やPRのブランチでの`mise run up`で反映した場合に、操作の要らない通知を送らないためである。
内容が同じで出さなかったときは、infoのログに`skipped: host already applied the same content`を残す。
`deployments.needs_host_action`は、通知を出したかによらず、ホスト側の作業が要る変更を含んだかを表す。
本文に並べるパスの見えない文字(制御文字、双方向制御、行と段落の区切り)は`?`に置き換え、`\`を含むMarkdownの書式文字は`\`でエスケープする。gitのファイル名は、これらを含められるためである。

次のときは解決しない。人が、ホストの反映が済んだことを確かめて、Consoleで解決してよい。

- 印のファイルが無い、通常のファイルでない、大きすぎる、版として読めない
- 印の版がself cloneに無い、または祖先かどうかを確かめられない
- noticeの版が印の版の祖先でなく、ホスト側の作業が要るパスの内容が違うか、内容を比べられない

印はworkerのジョブが書ける場所にあるので、ホストの反映の証明にはならない。
偽の印で黙らせられるのは、この通知だけである。影響は、ホストでの反映の遅れに気づけなくなるところまでで、突くにはdefaultのworkerでのコード実行が要る([セキュリティ](../security.md)の「ホストの反映の印」)。

実装とPR修正の準備と検証のステップと、作業領域の掃除は、`check_runtime_unsafe`も残す。
稼働中のworkerに誰でも書き込めるパスができたか、それを確かめられなかったときである。
イメージも前提を満たさなければ、`host_action_required`と両方を残す。
本文には、パスか確かめられなかった理由と、パスを閉じるかworkerを作り直す手順が載り、版は載せない。
ボリュームのマウントポイント(`/workspaces`と`/var/lib/factory`)は、作り直しでは閉じないので、`chmod`で閉じるよう書き分ける。
`mise run up`では直らないので、自己更新は解決せず、人が解決する。
同じ本文の未解決のnoticeがあるあいだは追加しない。
Discordには送らない。止まった作業項目の通知が、別に届くためである。
CIの失敗を直す回の監視(`watch_pr_ci`)も、この通知を残す。
ただし、問題が稼働中のworkerのパスの列挙の失敗だけで、実在するパスが1件も無い回は残さず、警告のログだけにする。
一時的な失敗で、人が解決するまで残る通知を出さないためである。
イメージが古い回は、列挙に失敗していても、イメージの通知とこの通知の両方を残す。

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

この範囲で待てるのは、`retry-after`のある二次レート制限(多くは60秒)である。1時間ごとの一次レート制限を使い切ったときの待ちは収まらない。

### 待てないときは失敗する

次のときは、`GitHubRateLimitError`を投げてステップを失敗させる。

- 必要な待ちが120秒を超える。この場合は待たない。
- 待って再試行しても、またrate limitで拒まれた。
- GraphQLの一次レート制限に当たった。この場合は待たない。

メッセージは`GitHub rate limit on <endpoint>: ... (rerun after the limit resets)`の形である。投げるのは要求がGitHubに拒まれた後なので、その要求の副作用は起きていない。

失敗した作業項目と人の対応待ちの作業項目は、解除を待ってからConsoleの**要対応**で再実行する。
人の対応待ちの通知でも、rate limitが原因のときは、次の操作に解除を待ってから再実行するよう表示する。
rate limitで失敗したときに各ステップが何を済ませているかは、[実装フローの仕様](implement.md)と[PRワークフローの仕様](pr-workflow.md)にある。

### RESTの検索の拒否

`callGhApi`は、RESTの検索APIのendpointを、`gh`を起動せずに例外で拒む。
検索の枠は小さく、周期の同じフローが5分の境目に重なって呼ぶと拒まれるので、呼び出しを入口で止める。
判定は、endpointの先頭の`/`とホストを落とし、小文字にして、`search/`で始まるかを見る。
`/search/issues`、`SEARCH/issues`、`https://api.github.com/search/issues`は拒む。
`repos/o/search-x/issues`のように、リポジトリ名やクエリに含むだけの要求は拒まない。
`paginateGhApi`と`callGhApiRawBody`は`callGhApi`を通るので、次のページのURLも同じ判定を受ける。
例外のメッセージにendpointを載せない。クエリに値が入りうるためである。
対象はRESTだけで、GraphQLの`search`のフィールドは拒まない。

静的テスト`tests/scripts/no_search_api.test.ts`は、次の2つを固定する。

- `f/factory`のテスト以外に、`search/`の字面、`gh search`、`--search`が無い。
- 5つのフローが、`search`で始まる名前を`github.ts`から読み込まない。

`search/`の字面を書けるのは、拒否の接頭辞を持つ定数の1行だけである。

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
