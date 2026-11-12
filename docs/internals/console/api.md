# ConsoleのAPI層の仕様

ConsoleがWindmillのAPIとscriptを呼ぶ層と、ログイン切れとWindmillに届かないときの扱いを書く。
API層と、取得と書き込みの経路を変更する人が読む。
画面をまたぐ仕様と、画面ごとの仕様の置き場は、[Consoleの仕様](../console.md)にある。

## API層

Consoleは、`src/api/windmill.ts`の`runScript`だけを通してWindmillのscriptを呼ぶ。
`POST /api/w/factory/jobs/run_wait_result/p/<path>`を、`credentials: "same-origin"`と`cache: "no-store"`で呼ぶ。
ログインのCookieだけで動くので、トークンは持たない。

`runScript`は`src/api/`の中にとどめる。
画面は、取得の`queries.ts`と書き込みの`writes.ts`にある型付きの関数だけを使う。
`src/api/`の外が`windmill.ts`をimportしないことは、契約テストが確かめる。

呼べるscriptは、`SCRIPT_PATHS`の許可リストにある次の18個だけである。
どれもtag`console`を持ち、Console用のworkerで動く。

| 名前 | 用途 | 型付きの関数 |
| --- | --- | --- |
| `console_query` | 読み取り | `fetchSummary`など(`queries.ts`) |
| `console_holds` | 全停止の状態と、有効な保留と凍結と、反映の承認待ちの読み取り | `fetchHolds`(`holdsQueries.ts`) |
| `console_jobs` | ジョブの一覧と詳細の読み取り | `fetchActiveJobs`、`fetchJobHistory`、`fetchJobDetail`(`jobsQueries.ts`) |
| `console_schedules` | scheduleの状態の読み取り | `fetchSchedules`(`jobsQueries.ts`) |
| `console_config` | 設定の全項目の読み取り | `fetchConfig`(`jobsQueries.ts`) |
| `approval_decide` | 承認依頼への承認か却下の記録 | `decideApproval` |
| `retry_work_item` | 止まった作業項目の再開 | `retryWorkItem` |
| `audit_kickoff` | 監査の手動起動 | `kickoffAudit` |
| `notice_resolve` | 通知1件の解決 | `resolveNotice` |
| `manual_intake_submit` | 手動投入の受付 | `submitManualIntake` |
| `pr_review_submit` | PRのレビューの投入の受付 | `submitPrReview` |
| `hold_release` | 保留1件の解除 | `releaseHold` |
| `freeze_release` | 凍結かdeployの保留1件の解除 | `releaseFreeze` |
| `console_job_cancel` | 実行中か待ちのジョブ1件の中止 | `cancelJob` |
| `console_job_rerun` | 失敗した定期ジョブ1件の再実行 | `rerunJob` |
| `console_config_update` | 設定の1項目を、無効にする向きか下げる向きに変更 | `updateConfig` |
| `console_hold_place` | 保留か凍結の設置 | `placeHold` |
| `console_schedule_stop` | scheduleの無効化 | `stopSchedule` |
| `console_deploy_decide` | 保護パスの変更の反映の承認か却下 | `decideDeploy` |

保留や凍結を置くscriptは`console_hold_place`の1本で、置ける種類と期限の上限を固定する。
スケジュールを止める`console_schedule_stop`は、止めてよいスケジュールの表を持つ。
有効に戻すscriptは許可リストに無い。

パスは呼び出し側の名前から引き、外から受け取った文字列では呼ばない。
Consoleは管理者のCookieで動くので、呼べる範囲を固定する。
許可リストに足すscriptは、tag`console`を付け、秘密値を読む範囲を[Console用workerの境界](../../security.md#console用workerの境界)に合わせる。

`runScript`は例外を投げず、応答を`classifyRunResponse`で分類して返す。
中断(`AbortSignal`)だけは、取り消しとして扱えるよう例外を再び投げる。

分類は、成功、`invalid_response`、`unauthorized`、`forbidden`、`timeout_or_unknown`、`job_failed`、`http`、`network`である。
応答の状態と本文から分類を決める規則は、[`console/src/api/errors.ts`](../../../console/src/api/errors.ts)の`classifyRunResponse`が定める。
状態ごとの分類は[`classifyRunResponse on failure statuses`](../../../console/src/api/errors.test.ts)で確かめる。
ジョブの失敗(500)は[`classifyRunResponse on a failed job (500)`](../../../console/src/api/errors.test.ts)で確かめる。
待ちの上限の定型文は[`classifyRunResponse on a timeout message`](../../../console/src/api/errors.test.ts)で確かめる。
本文から取り出して持つ文の長さの上限は、同じファイルの`MAX_MESSAGE_LENGTH`と`MAX_DETAIL_LENGTH`が定める。
ジョブの失敗の分類は、スタックを持たない。

本文はContent-Typeを見ずに読む。
失敗の本文は、JSONの`error.message`、`message`、文字列の`error`の順に探し、JSONでなければ本文のテキストを使う。
`timeout_or_unknown`は、ジョブが終わったか分からない状態を表す。
書き込みでは、ジョブの失敗、待ちの上限、形が違う応答、通信の失敗、5xxで、処理が途中まで進んでいる可能性がある。
そのため`describeWriteFailure`は、書き込みのこれらの失敗を「結果が分かりません。一覧を読み直して確かめてください」と案内する。
scriptの例外が届く状態は、経路で変わりうる。
500以外の状態で届いた例外は、`job_failed`に分類されないので、種類で決める書き込みの判定から外れる。
読み取りの失敗は、共通の部品`QueryFailureAlert`が出す。
文は`describeQueryFailure`が、何が起きたかの主文、次の操作、サーバーの文に分けて作る。
サーバーの文は内部の名前を含みうるので、主文に混ぜず、折りたたむ「詳細」だけに出す。
詳細は、書き込みの失敗と同じく、見えない文字と書字方向の制御文字を代替文字に置き換えてから描く。
`view`の不一致を受けたときは、Consoleとバックエンドの版がずれている可能性を主文で伝える。
Consoleが新しい場合も、バンドルが古い場合も起こる。
次の操作は、待つこと、版を見比べること、ログを確かめることの順に案内する。
反映は2分ごとなので、まず待つ。
直らなければ、システムの画面で「反映した版」と「Consoleの取り込み」を見比べる。
反映が失敗していれば、`self_update`のジョブのログを確かめる。
`system_status`が断られたときは、システムの画面も開けないので、画面を案内先にしない。
不一致は状態や分類で決めず、本文の`"view" must be one of`で判定する。
この文は`console_query`が投げるもので、`tests/scripts/`の契約テストが、実際の文でこの判定を確かめ、文が変わったことを検出する。
4xxの案内は、ジョブが作られる前に断られた場合を含むので、workerのtagと権限、またはジョブのログを挙げる。
500を除く5xxの本文はHTMLなどになりうるので、画面に出さない。
ジョブの失敗の結果は`{"error":{"name","message","stack"}}`の形で、`stack`には内部のパスが入る。
画面には`message`だけを出す。

### 実測した応答

| 状況 | 応答 | 確認 |
| --- | --- | --- |
| Cookieなしで`run_wait_result`を呼ぶ | 401、`text/plain; charset=utf-8`、本文`Unauthorized` | 実測 |
| `Sec-Fetch-Site: cross-site`で`/api/*`を呼ぶ | Caddyが403を返す | 実測 |
| 別のサイトの`Origin`で`/api/*`を呼ぶ | Caddyが403を返す | `scripts/check-caddy-origin.sh`で実測 |
| `Sec-Fetch-Dest: image`で`run_wait_result`をGETする | Caddyが403を返す | `scripts/check-caddy-origin.sh`で実測 |
| `Sec-Fetch-Mode: navigate`で`/api/*`へPOSTする | Caddyが403を返す | `scripts/check-caddy-origin.sh`で実測 |
| `Sec-Fetch-Dest: empty`と`Sec-Fetch-Mode: navigate`で`run_wait_result`をGETする | Caddyが403を返す | `scripts/check-caddy-origin.sh`で実測 |
| WindmillのUI(`/`と`/user/login`)の応答 | `Referrer-Policy`のヘッダーも`<meta name="referrer">`も無い。参照元の扱いはブラウザの既定に任される | 実測(1.817.0、`curl`) |
| superadminでない主体が、tag`console`のscriptを呼ぶ | 400、JSON文字列`"Bad request: Tag console is not included in the allowed CUSTOM_TAGS, ..."` | 実測 |
| ジョブの失敗の結果(CLIで確認) | `{"error":{"name","message","stack"}}`。HTTPの状態は未実測 | 結果の形だけ実測 |
| ジョブが失敗する | 状態は経路で変わりうる。本文はJSONでもテキストでも読める | `console_query`が`view`を断った失敗は、実機で422だった。ほかの失敗の状態は未実測 |
| 待ちの上限を超える | 408か504を想定する。500でも、本文の文が定型文に合えば同じ扱いにする | 状態は未実測 |
| ログイン画面 | `/user/login`(200)。戻り先の引数は`rd` | 実測 |

運用者のアカウントはsuperadminなので、tag付きのscriptも呼べる。
ジョブのトークンなど、superadminでない主体から呼ぶと、400の本文が画面の`http`の文言に添えて出る。

### 応答の型ガード

応答は、`src/api/guards/`の型ガードを通してから使う。
形が崩れた応答(必須の項目の欠落、型の違い、idの不正)は、一部だけを使わず、全体を`invalid_response`にする。
表示にしか使わない列挙(承認の種類と状態、Issue提案の発生元、通知の重要度と種類、失敗の種類と状態)は、文字列として受ける。
知らない値は`labels.ts`の決まった文言に落とす。
承認・却下などの操作の分岐は、種類や状態を見て決める。
その操作の側で、受け付ける値を列挙して絞る。
backendが先に新しい値を反映した間や、配信を前の版に固定している間に、要対応の一覧が丸ごと消えないためである。
時刻の文字列は、`Z`か`+09:00`のオフセットが付いた形だけを通す。
オフセットが無いと、ブラウザがローカル時刻として読み、閲覧する場所で絶対時刻がずれるためである。
`summary`の型は、`f/factory/steps/console_query.ts`の`ConsoleSummary`に合わせてある。
`tests/scripts/console_summary_contract.test.ts`が、次の8点を確かめる。

- backendの変換結果が型ガードを通ること
- 後の監査で報告済みの失敗の印(`superseded`)と、報告済みになっていない監査の失敗の件数(`audit_failures_open`)が、型ガードを通り、Consoleの件数の計算に届くこと
- 日次のまとめの案内が付ける作業項目の画面のURL(`?scope=all`)を、画面が読めること
- 古いbackendの応答のように、この2つの項目が欠けても、型ガードが受け入れること
- backendの列挙の値が`labels.ts`の表に漏れていないこと
- backendの時刻にオフセットが付くこと
- 承認フローの投稿するConsoleのリンクが、画面が読む引数(`approval`、`attempt`)を持つこと
- 承認フローの投稿するConsoleのリンクの経路が、旧Consoleのフラグメントの読み替え先と同じになること

リンクが経路の表(`screens.ts`)の経路に解決できることは、`console/src/app/consoleLinks.test.ts`が確かめる。
ルートのテストは`.tsx`の画面を読み込めないので、経路の表を引くこのテストはConsoleの側に置く。

新しい値に気づくのは、この契約テストの役目である。
`deployments`viewの型は`DeploymentHistoryRow`に合わせてある。
`tests/scripts/console_deployments_contract.test.ts`が、次の3点を確かめる。

- 変換結果が型ガードを通ること
- 作り手と結果の値が`labels.ts`の表に漏れていないこと
- PRのリンクを画面が受け取れること

`pipeline`viewの型は、`PipelineRow`のうち画面が読む列に合わせてある。
`tests/scripts/console_pipeline_contract.test.ts`が、次の5点を確かめる。

- 変換結果が型ガードを通ること
- 状態と種別の値が`labels.ts`の表と、並び替えの順に漏れていないこと
- IssueとPRのリンクを画面が受け取れること
- Consoleが終端とみなす状態が、backendの`TERMINAL_WORK_ITEM_STATUSES`と一致すること
- 進行中の範囲が、`blocked`を含み、要対応に載る状態(`ACTIONABLE_WORK_ITEM_STATUSES`)を含まないこと

### 取得の方針

自動で取り直すのは、`summary`と、ジョブの画面の実行中と待ちの一覧と、ジョブの画面が読む実行中の状態だけである。
`summary`は120秒ごとに、タブが見えている間だけ取る。
ジョブの詳細の状態は15秒ごと、実行中と待ちのタブの今のステップは30秒ごとに取る。
どちらも、止める条件は[ジョブの画面](jobs.md#ジョブの画面)にある。
実行中と待ちの一覧は60秒ごとに取る。
止める条件は[ジョブの画面](jobs.md#ジョブの画面)にある。
作業項目の詳細の概要は、進めているflowのジョブの状態を15秒ごとに取る。
止める条件は[進行](work-items.md#進行)にある。
更新履歴と作業項目の進捗は自動で取り直さない。
サイドバーの件数と、要対応の一覧は、`summary`の1つの取得を共有する。
再試行するのは、通信の失敗、待ちの上限(`timeout_or_unknown`)、500を除く5xxだけで、2回までにする。
500はジョブの失敗として分類される。
401、403、4xx、形が違う応答、ジョブの失敗は再試行しない。
再び取っても同じ結果になり、120秒ごとの取得に失敗が積み増されるためである。
書き込みは再試行しない。
結果が分からないまま2回実行しないためである。

起動の図の起点の箱は、スケジュールのタブと同じ取得(`schedulesQueryKey`のクエリ)を読む。
古いとみなすのは60秒で、60秒より古ければ、画面を開いたときに1回だけ取る。
自動では取り直さず、先読みもしない(`screens.ts`の先読みは、実行中と待ちの一覧だけである)。
ジョブの終了を検知したときの取り直し(`invalidateAfterFinish`)は、購読のあるこの取得にも効く。
取得は、定期ジョブが見つかったときの本体だけが始める。
見つからないとき、データを読めないとき、名前が無くて一覧へ戻すときは、取得しない。
新しいscriptも定期の取得も足さないので、タブを開くごとに増えるのは、キャッシュが古いときの最大1件である。

1つのタブが`summary`を取り直すと、1日に720件のジョブができる(120秒ごと)。
システムの画面を開いたタブは、`console_holds`の取得でも1日に720件を足す。
ジョブの詳細で実行中のジョブを開いたタブは、15秒ごとの状態の取得で1日に最大5,760件を足す。
実行中と待ちのタブで、実行中のflowが2件あるときは、30秒ごとに2件ずつ読むので、同じく1日に最大5,760件を足す。
作業項目の詳細の概要を開いたタブは、進めているflowのジョブが実行中か待ちのあいだ、15秒ごとに1件読むので、同じく1日に最大5,760件を足す。
実行中と待ちのタブを開いたタブは、60秒ごとの一覧の取得で、1日に最大1,440件を足す。
タブを複数開くと、タブごとに取得する。
取得はタブのキャッシュを分け合わないので、件数はタブの数に比例する。
画面が15分操作されないあいだは、実行中と待ちの一覧と、今のステップと、作業項目の進行の取得を止める。
ジョブの保持期間は、#138で扱う。

### 書き込み

書き込みのscriptは、`src/api/writes.ts`の型付きの関数だけから呼ぶ。
関数は失敗を`ApiFailure`で投げ、戻りを`src/api/guards/writeResults.ts`の型ガードに通してから返す。
形が違う戻りは`invalid_response`にする。

| 決まり | 理由 |
| --- | --- |
| 認可はWindmillのログインに任せる | Consoleは独自の認可を持たない。ログインしていない呼び出しは、Windmillが401にする |
| 承認者と解決者は引数に取らない | 画面から渡した名前は信用できない。scriptがジョブの実行文脈(`WM_USERNAME`、無ければ`WM_EMAIL`)から導き、導けなければ拒否する |
| 同一オリジンの`fetch`でPOSTし、本文はJSONにする | 他のサイトや注入されたリンクから、運用者のCookieで操作させないため。副作用のあるGETと、ページの移動による書き込みは、Caddyが403にする([セキュリティ](../../security.md)の「Consoleの配信」)。Consoleの呼び出しはPOSTの`fetch`なので、この規則に当たらない |
| 操作の値をConsole側で固定する | 監査は`force: false`、`source: "manual"`、`days: 7`で起動する。承認の補足(`note`)は固定の文にする。画面から変えさせない |
| 再試行しない | 結果が分からないまま2回実行しないため |

承認は、同じ決定が記録済みの行にもう一度呼ぶと、ハンドラの起動をやり直す。
二重の送信は、画面側で止める。

PRのレビューを投入する`pr_review_submit`の型付きの関数は`submitPrReview`で、引数は`owner`、`repo`、`prNumber`である。
戻りの型ガードは`isPrReviewSubmitResult`である。
断りの符号は[`src/api/guards/writeResults.ts`](../../../console/src/api/guards/writeResults.ts)の`PR_REVIEW_SUBMIT_REFUSAL_REASONS`が定める。
`already_reviewing`は、同じPRの稼働中のレビューがあることを、同期に返す。
投入のフローの登録のステップが断る符号は、同じファイルの`PR_REVIEW_REGISTER_REFUSAL_REASONS`と、型ガード`isPrReviewRegisterResult`にある。
この符号は、起動したフローのジョブの結果に現れる。
画面は[PRレビューの投入の画面](work-items.md#prレビューの投入の画面)で、2つの符号の表を日本語の固定文に直す。
仕組みは[PRワークフローの仕様](../pr-workflow.md#consoleからの投入)にある。

却下の理由の長さの上限は、[`src/api/writes.ts`](../../../console/src/api/writes.ts)の`MAX_REASON_LENGTH`が定める。
文字はコードポイントで数える。
`decideApproval`は、上限を超える理由を送らず、`RangeError`で断る。
画面は、送る前に長さを確かめて入力欄で知らせる。
理由はDBに記録され、Issueやレポートに出るためである。
script側には上限が無く、Windmillのapiを直に呼ぶ者には効かない。
script側の上限は、別のIssueで扱う。

#### 共通のフック

`useWriteMutation`(`src/api/mutations.ts`)が、ロック、実行、読み直しをつなぐ。
結線は、Reactから切り離した`createWriteRunner`(`src/api/writeRunner.ts`)に置く。
`bun test`が、実際のQueryClientで確かめる。
実行の流れは`executeWrite`、ロックは`runLocked`と`writeLocks`、読み直せなかったときの待ちは`holdUntilFresh`に切り出してある。

- 対象のキー単位でボタンをロックする。
  キーは`writeTargetKey`が作り、承認の承認と却下のように、同じ対象への操作は同じキーで止める。
  ロックは画面全体で共有するので、同じ対象のボタンが複数の場所にあっても、同時には動かない
- ロックはmutationの実行の中で取る。
  同じ瞬間に2回押されても、実行は1回になる
- 成功と、結果が分からない失敗の後に、関連する取得(既定はsummary)を読み直す。
  読み直しが終わるまでロックを残す
- 画面の知らせの関数は、結果用も一覧が古いこと用も、例外を投げても読み直しとロックの扱いを変えない
- 401は取得と同じ経路でログインの帯に流す
- 成功の知らせの文は、`src/lib/writeNotices.ts`の純関数が作る。
  解決済みだった通知の解決は成功として扱う
- 結果の知らせと、一覧が古いことの知らせは、`announce`(`src/components/announce.ts`)がトーストで出す。
  例外は設定の変更で、成功以外を設定のタブの残る知らせに出す([残る知らせ](system.md#残る知らせ))

書き込みの結果のトーストは、`announce`だけが出す。
sonnerを直に読み込んでよいファイルは、`src/components/announce.test.ts`の許可リストが限る。
成功のトーストは、sonnerの既定の4秒で消える。
成功以外(断り、確かめる警告、失敗)のトーストは、閉じるまで残す(`staysUntilClosed`)。
トーストはどの画面にいても見え、並行する操作の結果が重なっても互いを消さない。
一覧を読み直せなかった警告は、成功以外でも残さず、4秒で消す(`announceStaleList`)。
一覧が更新されると要らなくなり、残すと内容が古くなるためである。
知らせが次の操作(`nextStep`)を持つときは、文の下の説明に続けて出す。

トーストの置き場(`src/components/ui/sonner.tsx`)は、残ったトーストを畳まず、縦へ並べる(`expand`)。
並べる数の上限も置かない(`visibleToasts`)。
sonnerは、畳んだトーストの中身と、上限を超えたトーストを透明にするためである。
並べたトーストが画面の高さを超えると、古いものは画面の上へはみ出す。
新しいものを閉じると、古いものが下りてくる。

閉じるボタンは、成功のトーストを含むすべてのトーストに付ける(`closeButton`)。
名前は「知らせを閉じる」である。
キーボードでは、Alt+Tでトーストの並びへ移り、Tabでトーストと閉じるボタンへ進む。
トーストは文書の末尾にあるので、Tabを押し続けても届く。
sonnerは、Alt+Tで並びへ移ると消えるまでの時間を止め、トーストが1件以下に減るまで止めたままにする。
成功のトーストにも閉じるボタンが要るのは、このとき、キーボードで閉じる手段がほかに無いためである。
トースト本体にフォーカスがあるときは、閉じるボタンと同じ輪を出す。
影の指定がsonnerのフォーカスの影を上書きするので、輪は置き場の側で付ける。

結果が分からない失敗は、ジョブの失敗、待ちの上限、形が違う応答、通信の失敗、5xxである。
401、403、4xxは、ジョブが動く前に断られたので、読み直さない。
ジョブの失敗(`job_failed`)は、結果が分からないものとして扱う。
scriptの断り(理由なしの却下、記録済みの別の決定など)と、副作用の後の失敗が、同じ形で返り、本文から区別できないためである。
区別するには、scriptが断りを固定の接頭辞で投げる必要がある。

読み直しが失敗したか、30秒以内に終わらなかったときは、一覧が古いことを知らせる(`STALE_LIST_NOTICE`)。
その対象は、読み直せなかった取得のすべてが次に成功するまで、押せないままにする。
読み直せた取得は待たない。
古い一覧のままだと、済んだ操作をもう一度押せるためである。
summaryは120秒ごとに取り直すので、通信が戻れば解ける。

ロックを持つのは、このタブの中だけである。
複数のタブや、リロードの後の二重の送信は止められない。
サーバー側の冪等性の課題で、Consoleの外で扱う。

Issueに由来する文字は、`displayableIssueText`(`src/lib/intakeText.ts`)を通してプレーンテキストで描く。
書き込みの失敗の文に入るジョブの失敗の文と4xxの詳細も、同じ関数を通す。
見えない文字や並びの見た目を入れ替える文字を、代替文字に置き換えるためである。
置き換える分類は、backendの`countHiddenCharacters`と同じである。
全コードポイントで同じことを、`tests/scripts/console_hidden_characters_contract.test.ts`が確かめる。
リンクは`safeGitHubUrl`を通したものだけにする。

#### 契約テスト

`tests/scripts/console_write_contract.test.ts`は、次を確かめる。

- 許可リストの行き先が、tag`console`を持つ実在のscriptであること
- 型付きの関数の引数は、scriptの入力の項目と必須の項目に合うこと
- 各scriptの戻りが、型ガードを通ること
- `src/api/`の外が、`windmill.ts`をimportせず、`run_wait_result`の経路を直に書かず、`fetch`、`XMLHttpRequest`、`sendBeacon`も使わないこと。
  例外は、版の確認の`useReleaseWatch.ts`だけである。
  `fetch`を別名に代入してから呼ぶ形は見ない
- `runScript`と`SCRIPT_PATHS`が、`windmill.ts`の外へ再エクスポートされないこと
- 書き込みのscriptの名前が、許可リストと型付きの書き込みの関数と戻りの型ガードのファイルにだけ出ること。
  対象は、`console-scripts.ts`の`WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES`が挙げる8本である。
  画面や部品が名前を持つと、許可リストを通らない呼び出しの足場になる
- 操作の記録を足した書き込みの戻りが、記録の成否(`action_audit`)を型ガードに通すこと。
  知らない値は通らない
- 置くscriptの期限の上限と、止めるscriptの止めてよいスケジュールの表と待ちの分数が、画面の定数(`holdPlace.ts`)と一致すること。
  突き合わせは`tests/scripts/console_hold_place.test.ts`と`console_schedule_stop.test.ts`にある
- 許可リストで、名前に`place`を含むものが、`console_hold_place`の1つだけであること

Console用workerのscriptが読むsecret変数は、`tests/scripts/console_worker_boundary.test.ts`が数える。
走査がたどれない形と、見ないものは、[セキュリティ](../../security.md)の「Console用workerの境界」に書く。

### ジョブ、schedule、設定の読み取り

ジョブの画面とシステムの画面が読む3つのscriptは、読み取り専用である。
型と型ガード、取得、クエリのキーと設定は`src/api/jobsQueries.ts`にある。
backendの型との一致は、`tests/scripts/console_jobs_contract.test.ts`が確かめる。
返す項目の絞り方と、ログと結果の伏せ字は、[Consoleの安全策の内部仕様の「ジョブのログと結果の読み取り」](security.md#ジョブのログと結果の読み取り)に書く。

| script | 入力 | 戻り |
| --- | --- | --- |
| `console_jobs`の`active` | なし | 実行中、待ち、予定のジョブ。フローのステップは含めず、この順に並べる。画面は予定を除いて出す。キューの1ページ(100件)に達したときは、`truncated`を真にする |
| `console_jobs`の`history` | `status`、`script_path`、`before`、`include_console`、`limit` | 完了したジョブを、新しい順に1ページ(50件まで)。フローのステップは含めない。次のページのカーソルを`next_before`で返す。累積が200件に達したら、カーソルは`null`になる |
| `console_jobs`の`detail` | `job_id`、`include_output` | ジョブ1件。許可した項目、引数、フローのステップの一覧(条件で飛ばしたステップは`skipped`が真)、ログ、結果、結果を読めなかった理由、失敗の保存済みの原因 |
| `console_schedules` | なし | `f/factory/`のscheduleの状態。有効/無効、一時停止の期限、cron、次回の予定、直近5件の実行(新しい順)、リポジトリの定義との差異。全ページを読む(最大10ページ)。ページの上限かキューの1ページに達したときは、`truncated`を真にする |
| `console_config` | なし | `factory_config`の全項目。参照を含む値は、値の代わりに参照の印。加えて、設計工程の効いている値`design_stage`(`enabled`、`ignored`、`indeterminate`) |

一覧は、既定でtag`console`のジョブ(Consoleの呼び出し自身)を除く。
Windmillの一覧のAPIが、tagの否定(`!console`)を受けるためである。
Consoleの画面は、`include_console`を送らない。
`status`は、`success`、`failure`、`canceled`を受ける。
時間切れで止められたジョブは、実機で`failure`でなく`canceled`に入ることを確かめた。
`script_path`は、リポジトリの定義から生成した定数(`lib/console_known_paths.ts`)にあるscriptかフローに限る。
外れた値は、取得せずに`filter_rejected`で返す。
定数は`scripts/gen-console-known-paths.ts`で作り直す。
リポジトリの定義との一致は、`tests/scripts/console_known_paths.test.ts`が確かめる。
履歴のカーソルは、`<時刻>|<これまでに返した件数>|<境界の時刻で返したジョブのid>`の形である。
idは、同じ時刻のジョブが続くときだけ複数になり、20件までである。
形の違うカーソルは、先頭のページとして扱う。
履歴のAPIは、`created_before`を含む境界で返すので、前のページの最後のジョブが再び返る。
scriptは、カーソルのidのジョブだけを落とす。
同じ時刻の別のジョブは残す。
取る件数は、ページの件数に、落とす分と、次のページがあるかを見る1件を足した数である。
そのため、ページの件数が1件でも、累積は進み、200件に届く。
件数が200に達したら、scriptは取得せずに空の一覧を返す。
最後のページは、残りの件数に絞って取る。
200件は、画面が読み進める上限である。
カーソルを偽造すれば数え直せるので、悪意のある呼び出しには効かない。
1回の要求は50件までに限る。
この契約は、`tests/scripts/console_jobs.test.ts`が、境界のジョブを再び返す偽のAPIで確かめる。

詳細は、ジョブの取得、パスと種類の確認、ログと結果の取得の順に呼ぶ。
確認を通らないジョブは`{ found: false }`で返す。
存在しないid、UUIDの形でないid、`f/factory/`の外のジョブ、プレビューなど許可していない種類のジョブが当たる。
フローのルートのログは短く、ステップの出力は子のジョブにある。
そのため、ステップの一覧に子のジョブのidを添え、画面は子の詳細へ移る。
詳細の親のジョブは、`f/factory/`の許可した種類のジョブと確かめられたものだけを返す。
親を持つジョブと、フローのステップは、ルートまでの親(8段まで)がすべて許可した種類のときだけ返す。
確認に使う印は、ステップの印ではなく、親の有無である。
一覧は、親のidを返さない。
プレビューのフローは、ステップの種類がscriptでパスが`f/factory/`になるので、親をたどって見分ける。
次のときも、存在しないジョブと同じ応答にする。
ステップの親が存在しない、許可した種類でない、8段より深い、親が無いのいずれかである。
親の取得の失敗は、404以外なら投げ直す。
結果の取得が404のときは結果なしとし、ほかの失敗は読めなかった理由(`result_error`)で返す。
ログと失敗の原因は、結果の失敗に関わらず返す。
読めなかった理由は、伏せた後の先頭の300字までである。
失敗したジョブと取り消したジョブには、失敗の検知が保存した原因(`job_failures`)も添える。
保存済みの原因は伏せてあるが、返すときにもう一度伏せ、伏せた後の先頭の2000字までを返す。
表の`error`列は、実機の44行で最長が661字だった。
読めなかったときは、原因の欄だけが失敗を示し、詳細の全体は返る。

`include_output`を偽にすると、ログと結果とDBの読み取りを省く。
実行中のジョブの状態の取り直しに使い、ログを取り直さないためである。
履歴とスケジュールの一覧は、開いたときと更新の操作のときだけ取り、自動では取り直さない。
実行中と待ちの一覧は、条件がそろうあいだだけ60秒ごとに取り直す。
止める条件は[ジョブの画面](jobs.md#ジョブの画面)にある。
詳細は、ログと結果を含む取得を1回だけ行う。
実行中か待ちのジョブの状態だけを、タブが見えている間、15秒ごとに取り直す。

### 取得の負荷

Console用のworkerの枠は1つなので、読み取りの重さは承認などの呼び出しの待ちに表れる。
実機(ローカルのWindmill)で測った値は次のとおりである。

| 項目 | 値 |
| --- | --- |
| 履歴の最大の実ログ | 8KB(直近の8000件のジョブ。`self_update`) |
| その取得と伏せ字 | 取得が約3ミリ秒、伏せ字が約2ミリ秒 |
| 256KBに切る入力(600KBの合成ログ)の伏せ字 | 約15ミリ秒 |
| 敵対的な入力(1KBの行を並べた256KB、512KB、1MB)の伏せ字 | 最大で約14、27、27ミリ秒(ローカルのbunで、JWTの先頭を繰り返す入力)。入力を倍にしても、所要時間は倍に近い。テストは、3秒未満と、256KBから512KBで3倍未満を固定する |
| 改行の無い1行の長い入力(`eyJ-`の繰り返し)の伏せ字 | 256KBで約63ミリ秒、512KBで約130ミリ秒(JSON行に包んだ512KBは、上限で切るので1ミリ秒未満)。テストは1秒未満を固定する |
| 3000件の配列を持つ結果の伏せ字 | 約13ミリ秒 |
| 約100KBの葉3000枚を持つ結果の伏せ字 | 約18ミリ秒(葉の合計が上限の2倍を超えたら捨てる) |
| Console用workerの常駐メモリ | 60MB(上限は1024M) |
| 新しいscriptを流している間の`summary`と`console_holds`の待ち | 単独より約140〜180ミリ秒長い(最大で約265ミリ秒) |
| 今のステップの取得(`console_jobs`の`detail`、`include_output`は偽)1件の実行 | 中央値31ミリ秒、最大46ミリ秒(5組の10回) |
| 詳細を読んでいる間の`summary`の待ち | 単独で中央値77ミリ秒(67〜94)。詳細2件と重ねて、中央値74ミリ秒(35〜94)で、増分は見えない |
| 詳細を読んでいる間の`console_holds`の待ち | 単独で中央値52ミリ秒(43〜58)。詳細2件と重ねて、中央値68ミリ秒(34〜78)で、増分は約16ミリ秒 |
| 作業項目の進行の取得(`console_jobs`の`detail`、`include_output`は偽)1件 | 今のステップの取得と同じ呼び出しを1件だけ読む。同時に開く画面は1つなので、毎分最大4回で、2件を読む今のステップの取得より軽い |

待ちの増分は、デプロイ前のscriptをプレビューした値である。
毎回のコンパイルを含む。
デプロイ後は、これより短い。
詳細の取得は、配備済みのscriptを`wmill script run`で実行し、Windmillが記録した作成、開始、完了の時刻から求めた。
コマンドの起動に揺れがあり、重なりの度合いは制御していない。
今のステップの取得は、詳細を直列に読むので、ほかの呼び出しが待つのは、最大で詳細1件の実行時間である。
`approval_decide`は書き込むので、測っていない。
`summary`と同じworkerの枠を使うので、待ちの型は同じと考える。
いずれも、設計の上限の1秒を下回る。

実ログのAPIは、末尾だけを取る形を持たない。
scriptは全文を受け取ってから、末尾を切って伏せる。
このため、取得の大きさはログの全文で決まる。
実ログの最大が小さい間は問題にならない。
大きなログを持つジョブが増えたら、取得と伏せ字の時間を測り直す。

### workerの生死の取得

workerの一覧(`WorkerService`)は、ワークスペースの管理者のジョブトークンで呼ぶと403になる。
そのため、Consoleは、workerの生死とグループを読まない。
停止は、既存の通知で知る。
Console用workerの停止は`console_worker_missing`、defaultのworkerの停止は`default_worker_watch`、負荷は`worker_load`が知らせる。

## ログイン切れの扱い

取得か書き込みが401を返すと、画面の上部にバナーを出す。
一覧の側は、同じ内容の警告を重ねない。
すぐにはログインの画面へ移さない。
入力の途中の内容を失わないためである。
操作者が「ログイン」を押すと、Windmillのログイン画面`/user/login`へ移る。

戻り先は、引数`rd`に`pathname + search + hash`を入れて渡す。
`rd`は`URLSearchParams`で組み立てる。
現在のパスが`/console/`で始まらないとき、または`//`、`..`、`\`を含むときは、`/console/`に戻す。
別のオリジンや別のパスへ飛ばされないようにするためである。

その後の取得が成功すると、バナーは消える。
書き込みの成功では消えない。
401以外の失敗では消えない。
通信が戻ったとは限らないためである。

## Windmillに届かないとき

Windmillを呼ぶ`runScript`が、Windmillに届かなかった失敗で終わると、画面の上部に帯を出す。
次に応答を得ると、帯を消す。
帯の元は、`runScript`の結果だけである(`connectionState.ts`)。
`runScript`が終わるたびに、結果を報告先(`setConnectionReporter`)へ渡す。
読み取りと書き込みは、どちらも`runScript`を通る。
中断(abort)は報告しない。
`status.json`のように`runScript`を通らない取得は、帯に影響しない。
`status.json`の取得は、失敗しても`null`を返して終わるので、成功と区別できず、Windmillに届かない間も成功になるためである。

届かなかった失敗は、ネットワークの失敗と、転送が返す502と503である。
ConsoleのAPIはCaddyがWindmillへ転送するので、Windmillだけが止まると、Caddyが502か503を返す。
504は届かなかった失敗に含めない。
転送先の待ちの上限でも、Windmillの待ちの上限でも出て、見分けられないためである。
401、4xx、500、ジョブの失敗、待ちの上限は、Windmillが答えたものなので、届いているとして帯を消す。

ブラウザの接続状態(`navigator.onLine`とTanStack Queryの`onlineManager`)は見ない。
ConsoleはWindmillを同じ端末(127.0.0.1)で配信するので、他のネットワークが切れていても、Windmillには届く。
ブラウザの接続状態で取得を止めると、Wi-Fiを切った端末で、届く取得まで止まってしまう。
そのため、取得は`networkMode`を`always`にし、ブラウザの接続状態で止めない。
書き込みは、もとから`always`である。

帯が出ている状態から消える状態に変わったとき、失敗した取得(状態がエラーの取得)だけを読み直す(`watchConnectionRecovery`)。
帯が消えた後も、節が失敗の表示のまま残らないようにするためである。
成功した取得は、既定の`staleTime`と、ウィンドウに戻ったときの取り直し(`refetchOnWindowFocus`)に任せる。
取得の失敗は、通信の失敗として2回まで再試行する。
