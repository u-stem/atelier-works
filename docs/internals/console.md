# Consoleの仕様

Consoleのアプリ(`console/`)の構成と、成果物を配信する仕組みを書く。
アプリの構成は、画面とAPI層を変更する人が読む。
配信の仕組みは、`console_fetcher`とCaddyを変更する人が読む。
何を守るかと残るリスクは、[セキュリティ](../security.md)の「Consoleの配信」にある。

## アプリの構成

ConsoleはSPAである。
Vite、React、TypeScript、Tailwind CSS、shadcn/uiの部品で作る。
経路はReact Router、データの取得はTanStack Queryで扱う。
画面の判定は純関数に切り出して`bun test`で確かめる。
画面の部品のテストは書かない。

| ディレクトリ | 役割 |
| --- | --- |
| `src/api/` | scriptの呼び出し、失敗の分類、応答の型ガード、取得 |
| `src/app/` | 外枠、サイドバー、経路の表、ログインの状態、Provider |
| `src/screens/` | 画面。入口ごとのディレクトリに置く |
| `src/components/` | 共通の部品。`ui/`はshadcn/uiの部品を写したもの |
| `src/lib/` | 表示と判定の純関数 |

shadcn/uiの部品は、CLIを使わず、new-yorkのソースを手で`src/components/ui/`に写す。
importは相対パスにし、型アサーションは外す。
`as`を禁じる検査が、`console/src/`にもかかるためである。

## 見た目の体系

色の定義は`src/index.css`の変数だけにする。
値は`light-dark()`で書き、OSの設定と`data-theme`の両方に従う。
文字と背景の組はWCAG AAの4.5:1以上、入力欄の境界と点のような図形は3:1以上を保つ。

| 区分 | 決まり |
| --- | --- |
| 面 | 背景、面(`card`)、浮いた面(`popover`)の3段で重ねる。ダークは明るさの差、ライトは線と影で階層を出す。背景は真っ黒にしない |
| アクセント | 藍(`primary`)の1色。選択中の帯、主要な操作、フォーカスの輪に使う |
| 意味の色 | 承認は青(`approval`)、失敗は赤(`destructive`)、通知は琥珀(`warning`)、成功は緑(`success`)。点、バッジ、ラベルに使う |
| 文字の濃さ | 主(`foreground`)、副(`muted-foreground`)、補足(`subtle-foreground`)の3段 |
| 文字の大きさ | 12、13、14、16、20、24pxの6段(`text-caption`、`text-small`、`text-body`、`text-lead`、`text-title`、`text-display`)。本文の行間は1.7 |
| 書体 | Hiragino Sans、Noto Sans JP、system-uiの順。Webフォントを読み込まない。CSPが外部のファイルを拒むためである |
| 数字 | 件数や時刻は`tabular-nums`で桁をそろえる |
| 動き | 選択とhoverの遷移は150ms。動きを減らす設定の利用者には、アニメーションと遷移をほぼ止める |

通知の点は、図形用の`notice-mark`で描く。
図形の基準(3:1)で足りるため、文字の`warning`と色を分ける。

文字と背景の組が基準を満たすことは、`src/theme-tokens.test.ts`が`index.css`を読んで確かめる。
対象は、面の上の文字、意味の色の文字、薄く重ねた面(バッジと帯)の上の文字、入力欄の境界・フォーカスの輪・通知の点などの図形である。
承認、失敗、通知の違いは、色だけに頼らず、隣の文字でも伝える。

表示する日本語は`src/lib/labels.ts`に集める。
画面は、状態や種類の生のコードを出さない。
表に無い値は、元の文字列ではなく決まった文言で出す。
backendの値が表から漏れていないことは、`tests/scripts/console_summary_contract.test.ts`が確かめる。

## 経路

経路は`src/app/screens.ts`の1つの表から作る。
サイドバーの入口、件数のバッジ、React Routerの経路は、すべてこの表を読む。
routerの基準は`/console`で、Caddyが`/console/`の下のパスに`index.html`を返す。

| パス | 画面 | 状態 |
| --- | --- | --- |
| `/console/` | 要対応 | 承認の一覧 |
| `/console/items` | 作業項目 | 準備中の枠 |
| `/console/items/:id/requirements` | 要件定義書 | 準備中の枠。`?attempt=<k>`で試行を指す |
| `/console/reports` | レポート | 準備中の枠 |
| `/console/reports/audit/:id` | 監査レポート | 準備中の枠 |
| `/console/system` | システム | 準備中の枠 |

どの経路にも当たらないパスは、「ページが見つかりません」の画面で受ける。
経路の番号は、正の整数の文字列だけを受け付ける。
経路やURLの引数は選択を表すだけで、承認や再実行などの操作は起こさない。

表の1行は、入口の画面と、その下で受ける経路(`children`)を持つ。
`children`は入れ子にでき、親の画面は`Outlet`を描く。
どの経路にも`ErrorBoundary`が付き、省くと既定の`RouteError`になる。
画面の読み込みや描画が失敗すると、その画面の位置にだけ再読み込みの案内を出し、サイドバーと帯は残す。
表から作る経路の一覧は、`src/app/routeTable.test.ts`が固定する。

### 旧Consoleのリンク

URLのフラグメントが旧Consoleの形なら、新しい経路に置き換える。
`main.tsx`が、routerを作る前に`history.replaceState`で置き換える。
routerが先に`/console/`の画面を描くと、その画面が一瞬動いてしまうためである。
置き換えは履歴を増やさない。
`<id>`と`<k>`は、先頭が0でない正の整数に限る。

| 旧Consoleのフラグメント | 置き換え先 |
| --- | --- |
| `#requirements/<id>` | `/console/items/<id>/requirements` |
| `#requirements/<id>/attempt-<k>` | `/console/items/<id>/requirements?attempt=<k>` |
| `#audit/<id>` | `/console/reports/audit/<id>` |

サイドバーの「旧Consoleを開く」は、Windmillのraw appの旧Consoleへのリンクである。
旧Consoleは新しいタブで開く。件数のカードのリンクも同じである。
行き先のパスは、承認フローが投稿するConsoleのリンクと同じでなければならない。契約テストで固定している。

## API層

Consoleは、`src/api/windmill.ts`の`runScript`だけを通してWindmillのscriptを呼ぶ。
`POST /api/w/factory/jobs/run_wait_result/p/<path>`を、`credentials: "same-origin"`と`cache: "no-store"`で呼ぶ。
ログインのCookieだけで動くので、トークンは持たない。

`runScript`は`src/api/`の中にとどめる。
画面は、取得の`queries.ts`と書き込みの`writes.ts`にある型付きの関数だけを使う。
`src/api/`の外が`windmill.ts`をimportしないことは、契約テストが確かめる。

呼べるscriptは、`SCRIPT_PATHS`の許可リストにある次の5つだけである。
どれもtag`console`を持ち、Console用のworkerで動く。

| 名前 | 用途 | 型付きの関数 |
| --- | --- | --- |
| `console_query` | 読み取り | `fetchSummary`など(`queries.ts`) |
| `approval_decide` | 承認依頼への承認か却下の記録 | `decideApproval` |
| `retry_work_item` | 止まった作業項目の再開 | `retryWorkItem` |
| `audit_kickoff` | 監査の手動起動 | `kickoffAudit` |
| `notice_resolve` | 通知1件の解決 | `resolveNotice` |

パスは呼び出し側の名前から引き、外から受け取った文字列では呼ばない。
Consoleは管理者のCookieで動くので、呼べる範囲を固定する。
許可リストに足すscriptは、tag`console`を付け、秘密値を読む範囲を[Console用workerの境界](../security.md#console用workerの境界)に合わせる。

`runScript`は例外を投げず、応答を`classifyRunResponse`で分類して返す。
中断(`AbortSignal`)だけは、取り消しとして扱えるよう例外を再び投げる。

| 応答 | 分類 |
| --- | --- |
| 2xxで本文がJSON | 成功 |
| 2xxで本文がJSONでない | `invalid_response` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 408、504 | `timeout_or_unknown` |
| 500 | `job_failed`。本文から取り出した文(`message`)を500字まで持つ。スタックは持たない |
| 500で、本文の文が待ちの上限の定型文(文頭の`timeout after <数>`)に合う | `timeout_or_unknown` |
| その他の状態 | `http`。状態の番号と、4xxなら本文から取り出した文を200字まで持つ |
| 通信の失敗 | `network` |

本文はContent-Typeを見ずに読む。
失敗の本文は、JSONの`error.message`、`message`、文字列の`error`の順に探し、JSONでなければ本文のテキストを使う。
`timeout_or_unknown`は、ジョブが終わったか分からない状態を表す。
書き込みでは、401、403、4xxを除くすべての失敗で、処理が途中まで進んでいる可能性がある。
ジョブの失敗、待ちの上限、形が違う応答、通信の失敗、5xxがそれにあたる。
そのため`describeApiError`は、書き込みのこれらの失敗を「結果が分かりません。一覧を読み直して確かめてください」と案内する。
読み取りの失敗は、そのまま伝える。
500を除く5xxの本文はHTMLなどになりうるので、画面に出さない。
ジョブの失敗の結果は`{"error":{"name","message","stack"}}`の形で、`stack`には内部のパスが入る。
画面には`message`だけを出す。

### 実測した応答

| 状況 | 応答 | 確認 |
| --- | --- | --- |
| Cookieなしで`run_wait_result`を呼ぶ | 401、`text/plain; charset=utf-8`、本文`Unauthorized` | 実測 |
| `Sec-Fetch-Site: cross-site`で`/api/*`を呼ぶ | Caddyが403を返す | 実測 |
| superadminでない主体が、tag`console`のscriptを呼ぶ | 400、JSON文字列`"Bad request: Tag console is not included in the allowed CUSTOM_TAGS, ..."` | 実測 |
| ジョブの失敗の結果(CLIで確認) | `{"error":{"name","message","stack"}}`。HTTPの状態は未実測 | 結果の形だけ実測 |
| ジョブが失敗する | 500を想定する。本文はJSONでもテキストでも読める | 状態は未実測 |
| 待ちの上限を超える | 408か504を想定する。500でも、本文の文が定型文に合えば同じ扱いにする | 状態は未実測 |
| ログイン画面 | `/user/login`(200)。戻り先の引数は`rd` | 実測 |

運用者のアカウントはsuperadminなので、tag付きのscriptも呼べる。
ジョブのトークンなど、superadminでない主体から呼ぶと、400の本文が画面の`http`の文言に添えて出る。

### 応答の型ガード

応答は、`src/api/guards/`の型ガードを通してから使う。
形が崩れた応答(必須の項目の欠落、型の違い、idの不正)は、一部だけを使わず、全体を`invalid_response`にする。
表示にしか使わない列挙(承認の種類と状態、Issue提案の発生元、通知の重要度と種類、失敗の種類と状態)は、文字列として受ける。
知らない値は`labels.ts`の決まった文言に落とす。
承認・却下などの操作の分岐は、種類や状態を見て決める。その操作の側で、受け付ける値を列挙して絞る。
backendが先に新しい値を反映した間や、配信を前の版に固定している間に、要対応の一覧が丸ごと消えないためである。
時刻の文字列は、`Z`か`+09:00`のオフセットが付いた形だけを通す。
オフセットが無いと、ブラウザがローカル時刻として読み、閲覧する場所で絶対時刻がずれるためである。
`summary`の型は、`f/factory/steps/console_query.ts`の`ConsoleSummary`に合わせてある。
`tests/scripts/console_summary_contract.test.ts`が、次の4点を確かめる。

- backendの変換結果が型ガードを通ること
- backendの列挙の値が`labels.ts`の表に漏れていないこと
- backendの時刻にオフセットが付くこと
- 旧Consoleのパスが、承認フローの投稿するConsoleのリンクと一致すること

新しい値に気づくのは、この契約テストの役目である。
`deployments`viewの型は`DeploymentHistoryRow`に合わせてある。
`tests/scripts/console_deployments_contract.test.ts`が、次の3点を確かめる。

- 変換結果が型ガードを通ること
- 作り手と結果の値が`labels.ts`の表に漏れていないこと
- PRのリンクを画面が受け取れること

### 取得の方針

自動で取り直すのは`summary`だけで、120秒ごとに、タブが見えている間だけ取る。
更新履歴は自動で取り直さない。
サイドバーの件数と、要対応の一覧は、この1つの取得を共有する。
再試行するのは、通信の失敗、待ちの上限(`timeout_or_unknown`)、500を除く5xxだけで、2回までにする。
500はジョブの失敗として分類される。
401、403、4xx、形が違う応答、ジョブの失敗は再試行しない。再び取っても同じ結果になり、120秒ごとの取得に失敗が積み増されるためである。
書き込みは再試行しない。結果が分からないまま2回実行しないためである。

1つのタブが`summary`を取り直すと、1日に720件のジョブができる(120秒ごと)。
ジョブの保持期間は、#138で扱う。

### 書き込み

書き込みのscriptは、`src/api/writes.ts`の型付きの関数だけから呼ぶ。
関数は失敗を`ApiFailure`で投げ、戻りを`src/api/guards/writeResults.ts`の型ガードに通してから返す。
形が違う戻りは`invalid_response`にする。

| 決まり | 理由 |
| --- | --- |
| 認可はWindmillのログインに任せる | Consoleは独自の認可を持たない。ログインしていない呼び出しは、Windmillが401にする |
| 承認者と解決者は引数に取らない | 画面から渡した名前は信用できない。scriptがジョブの実行文脈(`WM_USERNAME`、無ければ`WM_EMAIL`)から導き、導けなければ拒否する |
| 同一オリジンの`fetch`でPOSTし、本文はJSONにする | 他のサイトから運用者のCookieで操作させないため。Caddyの`Sec-Fetch-Site`の検査とあわせて守る。POSTに限ることは、Caddyではまだ強制していない([セキュリティ](../security.md)の「Consoleの配信」) |
| 操作の値をConsole側で固定する | 監査は`force: false`、`source: "manual"`、`days: 7`で起動する。承認の補足(`note`)は固定の文にする。画面から変えさせない |
| 再試行しない | 結果が分からないまま2回実行しないため |

承認は、同じ決定が記録済みの行にもう一度呼ぶと、ハンドラの起動をやり直す。
二重の送信は、画面側で止める。

#### 共通のフック

`useWriteMutation`(`src/api/mutations.ts`)が、ロック、実行、読み直しをつなぐ。
実行の流れは`executeWrite`、ロックは`runLocked`と`writeLocks`、読み直せなかったときの待ちは`holdUntilFresh`に切り出してあり、`bun test`で確かめる。

- 対象のキー単位でボタンをロックする。キーは`writeTargetKey`が作り、承認の承認と却下のように、同じ対象への操作は同じキーで止める。一覧と詳細のボタンは、同じロックを共有する
- ロックはmutationの実行の中で取る。同じ瞬間に2回押されても、実行は1回になる
- 成功と、結果が分からない失敗の後に、関連する取得(既定はsummary)を読み直す。読み直しが終わるまでロックを残す
- 画面の知らせの関数が例外を投げても、読み直しは行う
- 401は取得と同じ経路でログインの帯に流す
- 成功の知らせの文は、`src/lib/writeNotices.ts`の純関数が作る。解決済みだった通知の解決は成功として扱う

結果が分からない失敗は、401、403、4xx以外のすべての失敗である。
401、403、4xxは、ジョブが動く前に断られたので、読み直さない。
ジョブの失敗(`job_failed`)は、結果が分からないものとして扱う。
scriptの断り(理由なしの却下、記録済みの別の決定など)と、副作用の後の失敗が、同じ形で返り、本文から区別できないためである。
区別するには、scriptが断りを固定の接頭辞で投げる必要がある。

読み直しが失敗したか、30秒以内に終わらなかったときは、一覧が古いことを知らせる(`STALE_LIST_NOTICE`)。
その対象は、一覧の取得が次に成功するまで、押せないままにする。
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
- `src/api/`の外が、`windmill.ts`をimportせず、`run_wait_result`の経路を直に書かず、`fetch`も呼ばないこと。例外は、版の確認の`useReleaseWatch.ts`だけである
- `runScript`と`SCRIPT_PATHS`が、`windmill.ts`の外へ再エクスポートされないこと

## ログイン切れの扱い

取得か書き込みが401を返すと、画面の上部にバナーを出す。
一覧の側は、同じ内容の警告を重ねない。
すぐにはログインの画面へ移さない。入力の途中の内容を失わないためである。
操作者が「ログイン」を押すと、Windmillのログイン画面`/user/login`へ移る。

戻り先は、引数`rd`に`pathname + search + hash`を入れて渡す。
`rd`は`URLSearchParams`で組み立てる。
現在のパスが`/console/`で始まらないとき、または`//`、`..`、`\`を含むときは、`/console/`に戻す。
別のオリジンや別のパスへ飛ばされないようにするためである。

その後の取得が成功すると、バナーは消える。書き込みの成功では消えない。
401以外の失敗では消えない。通信が戻ったとは限らないためである。

## 画面の外枠

左のサイドバーに、印と名前、4つの入口、下部の情報を置く。件数のバッジは要対応の入口だけに付く。
選んだ入口は、左端の藍の帯と面の色で示す。
入口の件数のバッジは、その入口の一覧に出る項目の件数にする。
要対応のバッジは承認の件数で、失敗と通知の一覧ができるまで足さない。
一覧の件数と食い違う数字を、最初に見る場所へ出さないためである。

下部には、配信している版と取り込みの最後の確認、テーマの切り替え、旧Consoleへのリンク、たたむ操作を置く。
版の情報は`/console/status.json`から読む。取れなければ出さない。
状態が固定中か失敗のときは、その旨の注意を添える。
テーマはライト、ダーク、OSに合わせるの3つをアイコンで切り替える。
たたんだサイドバーでは、入口のアイコンに件数の数字を重ねて出す。

各画面の見出しは、題と短い副題を左に、最終更新の時刻と再読み込みのアイコンのボタンを右に置く。

## 要対応の画面

一覧に出すのは承認だけである。
承認は、時刻が新しい順に並べる。
同時刻なら種類の順(承認、失敗、通知)、次にidが大きい順にする。
種類の切り替え(すべて、承認、失敗、通知)は、一覧に2種類以上の項目があるときだけ出す。
`buildInboxItems`が承認だけを返すため、今は一覧に種類の切り替えは出ない。
失敗と通知を一覧に載せるときのために、切り替えの描画はコードに残している。
切り替えには、項目が1件以上ある種類だけを並べる。
選んだ種類の項目がなくなったら、切り替えの状態も「すべて」に戻す。
承認の下位の種類(要件定義、Issue化提案、改善提案)は、行のラベルで示す。
改善提案は、監査から出たIssue提案である。

`summary`の承認には、承認待ちのほかに、承認済みでIssueをまだ作っていないIssue提案も入る。
承認を記録した後にIssueの作成が失敗した提案を、見えなくしないためである。
その行には「承認済み(Issue作成待ち)」のラベルを付ける。

選んだ項目は、URLの`?approval=<id>`、`?failure=<id>`、`?notice=<id>`のどれか1つに持つ。
2つ以上あるときは、どれも選んでいないものとして扱う。
値が正の整数でなければ、選んでいないものとして扱う。
選択の変更は履歴を積まない。
種類の切り替えが選んだ項目の種類を隠すときは、選択を外す。
一覧と詳細は別々にスクロールする。

一覧は`InboxList`、詳細は`InboxDetail`の別の部品が描く。
再実行、解決、承認などの行の操作は、一覧の行ではなく詳細のペインに置く。
一覧の行は1つのbuttonなので、操作のbuttonを入れ子にしないためである。
詳細は、種類ごとの描き分けを`InboxDetail`の1か所に集める。
詳細のペインは左寄せで、本文の幅は760pxまでにする。サイドバーを畳んでも位置が動かない。
一覧の行は、1行目に題名と相対時刻、2行目に種類、作業項目、期限、状態のバッジを並べる。
状態のバッジは2行目の末尾で、狭いときは省略記号で縮める。
2行目の高さは24pxに固定し、バッジの有無によらず、どの行も同じ高さにする。
行の頭に種類の点は付けない。
期限が24時間を切った行(期限を過ぎた行を含む)だけ、期限に警告色の印を付ける。
期限を過ぎた行は、失敗の色にする。
選んだ行は、藍を帯びた面(ライトでは淡く、ダークでは暗い)と左の帯で示す。
承認の概要と行には、期限があれば残り時間を出し、過ぎていれば「期限切れ」と出す。
承認の概要には、題名、種類、作業項目(要件定義なら試行)、Issueへのリンク、期限、依頼した時刻を出す。
期限と依頼した時刻は、日本時間の絶対時刻と相対時刻を並べる(例: 10/15 18:48まで(残り6日)、10/09 18:48(1時間前))。
IssueのリンクはGitHubのIssueのURLの形のときだけ張る。

### 取り込み時点のIssue

要件定義の承認の概要には、取り込み時点のIssueの題名と本文を出す。
実装のClaudeが受け取るのはこの内容で、GitHub上の現在のIssueではない。
承認者が現在のIssueだけを読んで承認すると、取り込み後に書き換えられた内容を見落とすためである。

内容は選んだ承認の作業項目ごとに、`console_query`の`intake_snapshot`で取る。
`summary`には載せない。本文が長く、120秒ごとの取得に含めると応答が膨らむためである。
却下や再実行による作り直しは、同じ作業項目の取り込み内容を書き換える。
そのため、承認依頼ごとに別のキャッシュにし、画面を開くたびに取り直す。更新前の内容を新しい承認の画面に出さないためである。

題名と本文は起票者が書いた信頼できない入力である。次のように扱う。

- MarkdownやHTMLとして解釈せず、文字列としてReactが描く。タグやリンクは文字のまま見える。
- 本文は20,000文字、題名は300文字で`console_query`が切る。切ったときは、先頭だけを表示している旨を出す。
- 切った後ろの部分は、承認者がConsoleでも、HTMLのコメントや不可視の文字を描かないGitHubの画面でも確かめられない。後ろの部分にあるHTMLのコメントの開始(`<!--`)と不可視の文字の数を`console_query`が数え、あれば警告する。
- 取り込み内容を更新したことがあれば(`refreshed`。更新の履歴から導く)、目立つ警告を出す。
- 見えない文字と、並びの見た目を入れ替える文字は、代替文字(U+FFFD)に置き換え、置き換えたことを警告で示す(`src/lib/intakeText.ts`)。対象は、Unicodeの分類がCf(双方向の制御文字、ゼロ幅の文字、tag文字を含む)、Cc(改行とタブを除く)、Zl、Zpの文字と、異体字セレクタである。
- 題名と本文の要素は、`dir="ltr"`と`unicode-bidi: isolate`で、周りの文字の並びに影響しないようにする。

要件定義の本文の描画は、この画面にはまだ無い。
旧Consoleの承認タブは取り込み時点のIssueを出さない。承認の操作は旧Consoleにあるので、承認者はこの画面で確かめてから、旧Consoleで承認する。
旧Consoleから承認しても、承認の前の確認は働く([要件定義](requirements.md)の「承認の前のIssueの確認」)。

この画面は読み取り専用で、承認や却下の操作は起こさない。
失敗と通知は、詳細を描く部品ができるまで一覧に出さない。
`?failure=`か`?notice=`で選ぶと、詳細のペインに、この種類の一覧が準備中であることを出す。
一覧に出ていない件数は、種類ごとのカード(色の点、件数)で知らせる。
対象は、失敗、通知、取得の上限を超えた承認である。
カードは、旧Consoleへのリンク(「旧Consoleで見る」)にする。サイドバーの「旧Consoleを開く」と同じ行き先にする。
旧Consoleにはタブを指す方法が無いので、リンクは既定のタブを開く。
同じ数をサイドバーには出さない。画面の中で1か所だけに示すためである。

一覧が空のときは、画面を2つに割らず、中央に1枚の面を出す。
面には、承認が無いこと、最後に確かめた時刻、次の自動更新までの時間、ほかの種類に残る件数のカードを載せる。
何も残っていないときだけ緑のチェックを出す。ほかの種類が残っているときは、中立のアイコンにして、片付いた印象を与えない。
カードは面の幅を等分して並べる。
401で取得できないときは、バナーと並べて、ログインが必要である旨を中央に出す。

並び、絞り込み、行の表示内容、副題、件数のカードは`src/lib/inboxView.ts`の純関数が決める。
次の自動更新までの時間と時刻の表示は`src/lib/refreshTiming.ts`が決める。
相対時刻の表示は、`src/app/clock.ts`の共有の時計が30秒ごとに進める。

## システムの画面

この画面が出すのは更新履歴だけである。反映の状態と通知の履歴は、画面の下に「表示する予定」と書いてある。
更新履歴は、Software Factoryが自分を更新した反映の一覧である。
`console_query`の`deployments`viewから、直近90日のものを新しい順に100件まで取る。
自動では取り直さず、見出しの再読み込みで取り直す。

反映1回を1枚のカードにする。カードには、次を出す。

- 日時。相対時刻で、日本時間の絶対時刻をツールチップに添える
- 版。前の版と今の版を、7桁の短い形で「前 → 今」と書く。前の版が無い初回は「初回 → 今」にする
- 結果。「反映済み」か「失敗」で、知らない値は「不明な状態」にする
- ホストの作業の要否。要るときは警告の色にする
- 含まれるPR。作り手のバッジ、題名、番号を1行にする

作り手のバッジは、「Software Factory」、「人」、「不明」のどれかである。
backendが確かな情報(マージしたブランチの名前)を読めたときだけ、前の2つにする。読めなければ「不明」にする。
含まれるPRが無い反映には、「含まれるPRの記録はありません」と出す。
PRを記録する前の反映と、PRを取り出せなかった反映も、同じ表示になる。区別できないのは、取り出せなかったときも空で記録するためである。
失敗した反映は、PRを取り出す前に止まるので、PRを持たない。空の配列で記録する。
記録するPRは1回の反映につき100件までなので、100件に達した反映には、これより古いPRは表示していない場合があると添える。件数がちょうど100のときも同じ注記になる。
題名は、GitHubのUIでマージしたコミットの本文の1行目である。別の形でマージしたコミットは、題名が空になるか、PRとして記録されない。

題名はコミットメッセージ由来の信頼できない文字列なので、Reactが文字として描く。マークアップとしては解釈しない。
番号は、GitHubのPRのURLの形で、末尾の番号がPRの番号と一致するときだけリンクにする。それ以外は文字で出す。
リンクは`rel="noopener noreferrer"`を付けて新しいタブで開く。
backendは、URLを`https://github.com/<owner>/<repo>/pull/<N>`の形に限り、題名の制御文字と書字方向の制御文字を空白にし、200字に切って返す。
画面は、同じ検査を`src/lib/updateHistory.ts`の純関数でやり直す。
表示する語は`src/lib/labels.ts`にある。

## ジョブの画面へのリンク

作業項目の遷移と失敗は、動いたジョブのIDを持つ([作業項目の状態とリース](work-items.md)の「ジョブの記録」)。
`src/lib/jobLink.ts`の`jobRunUrl`が、IDからWindmillのジョブの画面のURLを作る。
`src/components/JobLink.tsx`の`JobLink`が、そのURLへのリンクを描く。リンクは別のタブで開く。
`work_item_detail`の遷移と失敗の行の型ガードは、`src/api/guards/workItemTransitions.ts`と`workItemFailures.ts`にある。
`tests/scripts/console_work_item_jobs_contract.test.ts`が、backendの変換結果がこれらの型ガードを通ることを確かめる。

IDはDBに記録された値で、信頼できない入力として扱う。
UUIDの形のものだけを、固定の形のパス`/run/<job_id>`に入れる。形が違えばリンクを出さない。
URLの組み立てに、IDから先の文字列を使わない。

リンクは、同じオリジンの相対パスにする。
ConsoleはWindmillと同じオリジンで配信するためである。

URLにワークスペースの指定(`?workspace=`)を付けない。
指定の無いURLをWindmillがどのワークスペースで開くかは、確かめていない。
別のワークスペースを選択中だと、ジョブを開けないことがある。
単一のワークスペース(`factory`)の運用を前提にする。

作業項目の詳細の画面は、まだ無い。
`JobLink`はどの画面にも組み込んでいない。

## 画面を足す手順

1. 画面を`src/screens/<入口>/`に置く。
2. `src/app/screens.ts`の表に、入口か詳細の経路を1行足す。入れ子の経路は`children`に書く。
3. 表示する語を`src/lib/labels.ts`に足す。
4. 判定は純関数にして、`src/lib/`に置き、テストを書く。
5. 見出し(`PageHeader`)に、画面が自分のクエリから作った`refreshStatusOf`の結果を渡す。取得するデータを持たない画面は渡さない。

## 配信の構成

| 要素 | 役割 |
| --- | --- |
| `console/` | Consoleのソースコード(Vite + React) |
| `ci.yml`の`console`ジョブ | `console/`を組み立て、`main`へのpushで成果物`console-dist`として上げる。型検査、lint、テストは`check`ジョブが担う |
| `infra/console_fetcher/` | 成果物を検証して、名前付きボリューム`factory_console`に書く |
| Caddy | `factory_console`を読み取り専用でマウントし、`/console/`で配信する |

`factory_console`は、どのworkerにも書き込みでマウントしない。
読む必要があるConsole用のworker(`windmill_worker_console`)にだけ、読み取り専用で渡す。
配信中のファイルを書き換えられると、運用者のブラウザに改ざんが居座るので、書けるのは取り込み専用の`console_fetcher`だけにする。

## console_fetcherのコンテナ

- uid 1000(rootでない)、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`で動く。
- 専用のnetwork`console_egress`につなぐ。このnetworkからは、DBとWindmillに届かない。
- 第三者のパッケージを入れない。
- dockerには外への行き先をドメインで絞る仕組みが無い。そのため、コードが接続する先を`api.github.com`と、そこからリダイレクトされたAzureのblob storage(`*.blob.core.windows.net`、`https:`のみ)に限る。
- 成果物の取得先へはトークンを送らない。

## 取り込みの検証

`console_fetcher`は、`main`へのpushで動き、全体が成功した`ci.yml`の実行の成果物`console-dist`だけを取り込む。
書く前に、次をすべて確かめる。

1. zip全体のsha256が、GitHubの`digest`と一致する。
2. 展開した全ファイルのsha256が、`manifest.json`と一致する。
3. マニフェストが、その実行のcommitのものである。

zipは自前のreaderでメモリ上に展開する。
`..`、絶対パス、symlink、通常のファイル以外、暗号化、zip64は拒む。

## CIの組み立て

`ci.yml`の`console`ジョブが組み立てる。
型検査、lint、テストは`check`ジョブの`mise run check`(`console:check`)が担い、`console`ジョブは重ねて実行しない。
PRでは、`scope`ジョブの`console`のフラグが偽のとき、このジョブを飛ばす。
`main`へのpushでは、変更に関わらず毎回動かす。
`console_fetcher`が、その実行の成果物を取り込むためである。
判定の詳細は[セットアップ](../setup.md)の「CIの実行の範囲」にある。

- miseで入れるツールは、bunと、viteとtscを動かすnodeだけにする。ほかの`[tools]`とそのinstall scriptを動かさない。
- miseのキャッシュを読み書きしない。
- ルートと`console/`の依存は`bun install --frozen-lockfile --ignore-scripts`で入れ、依存のinstall scriptを実行しない。
- `console/bun.lock`は`scripts/check-console-lockfile.ts`で検査する。registry由来でsha512のintegrityが付いた依存だけを許す。git、GitHub、tarballのURL、`console/`の外を指す`file:`と`link:`、`trustedDependencies`は拒む。
- 組み立ての後、マニフェストを書く前に、draw.ioのビューアを取得して`dist/drawio/`に置く。詳細は「draw.ioの図」にある。

## 配信の経路

Caddyは、`/console/`の下を次の経路で返す。
`factory_console`の他のファイル(`pin`、`revoked.json`、`history.json`など)は配信しない。

| パス | 返すもの | キャッシュ |
| --- | --- | --- |
| `/console` | `/console/`への308のリダイレクト。クエリ(`?approval=<id>`など)は保つ | - |
| `/console/status.json` | ボリューム直下の`status.json`。無ければ404 | `no-store` |
| `/console/assets/*` | 共有の`assets/`。無ければ404 | 長期(immutable) |
| `/console/drawio/*` | `current/`の`drawio/`。ビューアと受け口。無ければ404 | 長期(immutable) |
| `/console/drawio.html` | `current/`の`drawio.html`。無ければ404 | `no-cache` |
| `/console/*` | `current/`のファイル。無いパスは`index.html` | `no-cache` |

`/console/manifest.json`は、`current/`の`manifest.json`である。
`status.json`は`state`、`sha`、`checked_at`、`error`の4項目だけを持つ。

## 開いたままのタブの版の確認

開いたままのタブは、`manifest.json`と`status.json`を読んで、自分の版が配信中かを確かめる。
実装は`console/src/lib/`と`console/src/`にある。

- `lib/referencedUrls.ts`: 画面が参照するscriptとstylesheetのURLの収集
- `lib/release.ts`: 判定
- `lib/releaseCheck.ts`: 取得と判定の1回分
- `lib/releaseSchedule.ts`: 確認の間隔、タブの可視状態、動的importの失敗での即時の確認、打ち切り、失敗時の間隔の延長
- `useReleaseWatch.ts`: 上の部品をDOMにつなぐ

### 確認の時機

確かめるのは、表示した直後と、その後60秒ごと、タブが見える状態に戻ったとき、動的importが失敗したときである。
動的importが失敗すると、Viteが`window`に`vite:preloadError`を出す。
版の入れ替わりで古いchunkが消えると、このimportは失敗する。
そのイベントを受けると、次の周期を待たずに確かめる。
タブが見えているかは見ない。
失敗は版が外れたことの手掛かりで、見えないタブでも確かめる意味があるためである。
前の確認の開始から2秒は空ける。空いていなければ、空くまで待ってから確かめる。
失敗が続けざまに起きても、確認が続けて走らないためである。
待っている間に何度来ても、確認は1回にまとめる。
確認の実行中に来た要求は、何度来ても、実行が終わった後に1回だけやり直す。
実行中の確認が、失敗より前に始まっていて、版の入れ替わりを見落とす場合があるためである。
やり直しも、前の確認の開始から2秒を空ける。
イベントの既定の動作は変えない。失敗したimportは、そのまま例外になる。
unmount後は確かめず、やり直さない。
Consoleの画面は、経路ごとに動的importで読み込む。
版が入れ替わった後に、古いchunkを読み込む画面へ移ると、このimportが失敗して`vite:preloadError`が出る。
すると確認が走り、版が外れていれば帯が出る。
失敗した画面の位置には、`RouteError`が再読み込みを案内する。
フックがマウントされる前に起きた失敗は拾わない。

### 自分の版の見分け方

自分の版は、画面が参照するscriptとstylesheetのうち、`/console/assets/`の下にあるファイル名の集合で見分ける。
確かめるたびに、DOMから集合を取り直す。
後から読み込んだchunkの参照も拾うためである。
基準のオリジンと違うURLと、`%`を含む名前は集合に入れない。
集合が空の回は、何も取りに行かず、前回の判定を保つ。
開発サーバーは`index.html`の`/console/assets/`の参照にbaseを前置するので、集合が空になる。

`index.html`に直書きした`/console/assets/`の参照は、すべて`console/public/assets/`に置く。
Viteが`dist/assets/`に写し、`manifest.json`に載せるためである。
載らない参照があると、再読み込みしても消えない帯が出る。

ビルドに版のshaは埋め込まない。
版ごとに中身が変わると、`console_fetcher`の中身による同一判定と`revoked.json`の照合が働かなくなるためである。

### 判定

| 状況 | 表示 |
| --- | --- |
| 集合のファイルがすべて`manifest.json`にある | 出さない |
| 1つでも無く、`state`が`pinned`でなく、無かったファイルのどれも404でない | 再読み込みを促す控えめな帯 |
| 1つでも無く、`state`が`pinned`か、無かったファイルのどれかを取ると404 | 再読み込みを求める目立つ色の帯 |

`manifest.json`を取れないときは、前回の判定を保つ。
`status.json`を取れなくても、帯は出す。
一度目立つ色の帯を出したタブは、帯を下げない。

## ブラウザ側のヘッダー

`/console/*`の応答(404とfallbackを含む)だけに、次のヘッダーを付ける。
Windmill(`/`と`/api/*`)には付けない。

- `script-src`を`/console/assets/`に絞ったCSP。`'unsafe-inline'`と`'unsafe-eval'`は許さない。
- `frame-ancestors 'none'`と`X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `Cross-Origin-Opener-Policy: same-origin`

Trusted Typesは`Content-Security-Policy-Report-Only`で様子を見る。

`/console/drawio.html`と`/console/drawio/`の下だけは、別のヘッダーを付ける。
内容は「draw.ioの図」にある。

## CSPとCaddyのパスの解釈の違い

ブラウザは、パスの`%2f`を区切りとみなさない。
そのため、`/console/assets/..%2f..%2fapi/...`は`script-src`の`/console/assets/`に合う。
一方Caddyは、区切りに戻して正規化する。
そのままでは`/api/...`や`/ws/...`としてWindmillや`windmill_extra`へ転送され、その応答をscriptとして読ませる経路になる。
CSPはパーセント符号を戻してから比べるので、`/%63onsole/assets/...`のように文字を符号化したURLも`/console/assets/`に合う。

そこでCaddyは次のように扱う。

- パーセント符号を戻しただけで正規化していない元のパスが`/console/`で始まる要求は、どの転送先(`windmill_server`、`windmill_extra`)にも渡さない。Consoleの経路で返すか、404にする。`/console`そのものを含み、大文字小文字と先頭の`/`の重複は区別しない。
- Caddyは`handle`をmatcherの種類で並べ替える。そのためCaddyfileでは`route`で順序を固定し、Consoleの経路とこの404を、どの`reverse_proxy`よりも先に評価させる。
- Consoleの経路では、生のパスに`%2f`か`%5c`(大文字小文字を問わない)があれば400にする。

Consoleの画面のURLに、符号化した区切りを使ってはいけない。

### 開くときのホスト名

`script-src`は、ブラウザが使ったスキーム、ホスト、ポートを含む`/console/assets/`のURLで絞る。
CSPのパスには、オリジンが要るためである。
IPv6のリテラル(`http://[::1]:8080/console/`など)で開くと、このURLの形が崩れてscriptが拒否される。
IPv4のアドレス(`127.0.0.1`など)かホスト名で開く。

## draw.ioの図

要件定義書の図は、最上位のページではなく、隔離したiframeの中で描く。
何を守るかは、[セキュリティ](../security.md)の「draw.ioの図の描画」にある。
`DrawioFrame`はどの画面にも組み込まれていない。部品と`drawio.html`が配信物に入っているだけである。
旧Consoleのraw appは、同じ`/console/drawio.html`をiframeで読み込んで図を描く。
そのため、旧Consoleで図を見るには、このConsoleの配信が動いている必要がある。

| ファイル | 役割 |
| --- | --- |
| `console/drawio-viewer.json` | ビューアの版、commit、取得元のURL、sha256の固定。保護パス |
| `console/scripts/drawio-viewer.ts` | 固定の値の検査と、取得したビューアの照合(`verifyViewer`)。純粋関数 |
| `console/scripts/fetch-drawio-viewer.ts` | CIが呼ぶ。取得して照合し、`dist/drawio/`に書く |
| `console/public/drawio.html` | 図を描くページ。scriptはすべて外部のファイルで、通常のscriptとして読む |
| `console/public/drawio/drawio-frame-*.js` | ページの中の受け口。素のJavaScriptで、ビルドを通らない |
| `console/src/lib/drawioMessages.ts` | 親が送るメッセージの組み立てと、iframeから届いたメッセージ(高さ、失敗の種類)の検査。純粋関数。raw appの`lib/drawioMessages.ts`が、同じ`DRAWIO_FRAME_SRC`と`MAX_XML_BYTES`を持つ |
| `console/src/lib/drawioFrameState.ts` | iframeの状態の遷移(load、メッセージ、応答なし、XMLの差し替え)を`(state, event) => state`で表す。純粋関数 |
| `console/src/components/drawio/DrawioFrame.tsx` | 親の部品。どの画面からも使える |

### ビューアの取得

ビューアはリポジトリに入れない。
CIの`console`ジョブが、組み立ての後に`fetch-drawio-viewer.ts`を動かし、`dist/drawio/drawio-viewer-<sha256の先頭8桁>.js`に書く。
取得したバイト列のsha256が固定の値と違えば、何も書かずに失敗する。
URLはリダイレクトを許さず、パスはcommit配下のビューア1ファイルに限る。
応答は10MBまでで、一時的な失敗(ネットワーク、429、5xx)は、待ちを倍にしながら3回まで再試行する。
取得物は、固定のsha256をキーにして`actions/cache`に保持する。
キーとして使う前に、sha256が64桁の小文字の16進数かを検査し、形が違えば失敗させる。
保存先は`console/.cache/drawio-viewer`で、Gitには入れない。
キャッシュに一致するファイルがあれば取得しない。
キャッシュの中身は信用せず、使う前に固定のsha256と照合する。照合に通らなければ、取得し直す。
キャッシュは`dist/`の外に置く。`dist/drawio/`には受け口のscriptもあり、キャッシュから戻すと、組み立てた受け口を上書きしてしまうためである。
raw.githubusercontent.comの障害で取得に失敗したら、CIのジョブを再実行する。キャッシュに当たれば取得せず、外れれば取得し直す。
ビューアはApache-2.0のライセンスである。
`console_fetcher`は、他の配信物と同じように、マニフェストの照合を経て`releases/<sha>/drawio/`に置く。
共有の`assets/`には入れない。`current`から`/console/drawio/`として配信する。
そのため、版を入れ替えたとき、古い版の`drawio/`は`releases/`の掃除に従って消える。
`console_fetcher`のコードは、このディレクトリのために変える必要が無い。マニフェストの検査は、`assets/`の入れ子だけを拒む。

ローカルの`mise run console:check`は、ビューアを取得しない。
ネットワークが無くても通る。

固定を更新するときは、次の順に行う。

1. jgraph/drawioのリポジトリを、blobを取らない部分cloneで取る。
2. 新しいcommitがリリースのタグ(`v<版>`)にあることを、`git tag --contains <commit>`で確かめる。
3. `git show <commit>:src/main/webapp/js/viewer-static.min.js | shasum -a 256`で、sha256を計算する。配信用のURL(raw.githubusercontent.com)から取ったバイト列を使わず、gitのオブジェクトから取る。
4. `console/drawio-viewer.json`の4項目を書き換える。URLはそのcommitを指し、sha256は3.の値である。
5. `console/public/drawio.html`が読むビューアの名前を、新しいsha256の先頭8桁に合わせる。

固定している版(32.4.1)は、この手順で確かめている。
commit `9034053fba80a435e27d68d374bc564b83917ae9`は、`v32.4.1`のタグが指す`32.4.1 release`のcommitである。
そのcommitのファイルのsha256は、固定の値と一致した。

`console/scripts/public-assets.test.ts`が、`drawio.html`の参照と固定の値の一致を確かめる。
受け口のscriptを直したときは、ファイル名のハッシュを中身に合わせて付け直す。
同じテストが、合っていないファイル名を検出する。

### iframeとメッセージ

親の部品は、`sandbox="allow-scripts"`と`referrerPolicy="no-referrer"`を付けたiframeで`/console/drawio.html`を読み込む。
XMLが変わるたびに、iframeを作り直す(keyを変える)。
1つのiframeの一生で送るのは、最初の`load`の後の1回だけである。
受け口は、`load`の前にscriptの実行を終えているためである。
状態の遷移は`console/src/lib/drawioFrameState.ts`の`reduceFrame`にある。`shouldSendXml`が、このloadでXMLを送ってよいかを返す。

2回目の`load`は、iframeが別の文書へ遷移したことを表す。
親は、iframeを`about:blank`にして表示を止め、固定の文を出す。
以後、そのiframeのメッセージは受けない。
この停止は最善の努力である。loadが起きない遷移は検知できず、止まらない。
そのときも、親が受ける値は、数値(高さ)と固定の失敗の種類だけである。

最初の`load`の後、10秒たっても、高さと`drawio:error`のどちらも届かなければ、親は、図のページが応答しないとみなして固定の文を出す。
`drawio.html`が404になったときや、ヘッダーに遮られて、scriptが動かないときである。

| 向き | メッセージ | 検査 |
| --- | --- | --- |
| 親からiframe | 種別`drawio:render`と`xml`(文字列) | 親は、空のXMLと、UTF-8で256KBを超えるXMLを送らない |
| iframeから親 | 種別`drawio:height`と`height`(数値) | 親は、送り元がiframeのwindowでないものと、`height`が有限の数値でないものを捨て、80〜1600pxに収める |
| iframeから親 | 種別`drawio:error`と`reason` | 親は、送り元がiframeのwindowでないものと、`reason`が固定の3つ(`viewer_missing`、`render_failed`、`too_large`)でないものを捨てる。画面に出す文は、親が`reason`から決める |

iframe側の受け口(`console/public/drawio/drawio-frame-*.js`)は、次のものを捨てる。

- 送り元が親のwindowでないメッセージ
- 種別が`drawio:render`でないメッセージ
- `xml`が文字列でないメッセージ
- 2回目以降の`drawio:render`

256KBの上限は、親と受け口の両方に置く。
親は送る前にバイト数で、受け口は受けた後に文字数で確かめる。
片方を変えるときは、もう片方も同じ値に変える。
上限を超えたXMLを受けた受け口は、`too_large`を返す。

受け口は、失敗を黙らせない。
ビューアが読み込まれていない場合、ビューアが例外を投げた場合、描いても図が入らなかった場合は、固定の文をiframeの中に出し、`drawio:error`を親へ返す。
例外の文面は、ページに出さず、親にも渡さない。

iframeは、図の領域の大きさが変わるたびに高さを送る。
図が上限より高いときは、親のiframeが1600pxで止まり、iframeの中で縦にスクロールする。横には隠す。
縦のスクロールバーが出入りして幅が変わると、ビューアが図を合わせ直して高さが変わり、高さの通知が往復するため、幅は固定する(`scrollbar-gutter: stable`)。
枠線は、iframeの外側の要素に付ける。iframeに付けると、枠線の分だけ高さが足りなくなる。

### CSPとヘッダー

`/console/drawio.html`と`/console/drawio/`の下は、Consoleの他のページと別のヘッダーで返す。
Caddyfileでは、次の2つを、Consoleの本体の`handle_path /console/*`より前に置く。

- `handle /console/drawio.html`
- `handle_path /console/drawio/*`

どちらも後ろに置くと、Consoleのヘッダー(`frame-ancestors 'none'`)が付いて、iframeに読み込めなくなるためである。

Consoleの本体のfallback(`handle_path /console/*`)は、`drawio.html`と`drawio/`の下を404にする。
区切りを重ねた要求などでfallbackに落ちても、sandboxの無いConsoleのヘッダーで返さないためである。
ビューアと受け口は、`/console/assets/`ではなく`/console/drawio/`に置く。
Consoleの本体のCSPは`/console/assets/`だけを許すので、本体のページは、`/console/drawio/`のscriptを読めない。
本体にHTMLが注入されても、信頼されたオリジンでビューアを動かす足場にならない。
`tests/infra/caddyfile.test.ts`が、この許可の違いを固定している。

| ヘッダー | 値 | 理由 |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'none'`、`script-src`は`/console/drawio/`、`style-src 'unsafe-inline'`、`img-src data:`、`font-src data:`、`connect-src 'none'`、`base-uri 'none'`、`form-action 'none'`、`frame-ancestors`はブラウザが使ったオリジン、`sandbox allow-scripts` | 外への取得をすべて止める。不透明なオリジンでは`'self'`が使えないので、`script-src`と`frame-ancestors`にはブラウザが使ったオリジンを入れる。`style-src`は、ビューアが付けるインラインのstyleのために許す。`sandbox`は、ページを直接開いても不透明なオリジンで動かす |
| `X-Frame-Options` | `SAMEORIGIN` | `frame-ancestors`を解釈するブラウザでは、そちらが優先される。これは、解釈しない古いブラウザ向けの備えで、Console自身のページだけに埋め込ませる |
| `Referrer-Policy` | `no-referrer` | 参照元を送らない |
| `X-Content-Type-Options` | `nosniff` | scriptの種別を推測させない |

`'unsafe-eval'`は付けない。

## 他のサイトからのAPIの呼び出し

`/api/*`への要求で`Sec-Fetch-Site`が`cross-site`か`same-site`のものは、Caddyが403にする。
ほかのポートのlocalhostや外部のリンクから、運用者のCookieでAPIを実行させないためである。

- Windmillのフロントエンドからの要求には、ブラウザが`Sec-Fetch-Site: same-origin`を付ける。
- CLI(`wmill`)は、このヘッダーを送らない。
- Windmill 1.817.0のraw app(旧Console)には、既定でsandboxが無い。`backend.*`の呼び出しは、`parent.postMessage`を通して同じオリジンの親(WindmillのSPA)が行うので、これも`same-origin`になる。
- raw appのsandboxを有効にすると、バンドルの取得(`GET /api/w/*/apps_u/get_data/v/*`)がcross-siteになって403になる。そのときは、この経路を例外にする必要がある。

## 古い版の掃除

共有の`assets/`のファイルは、置いてから14日を超え、残している版のどれからも参照されていなければ消す。
