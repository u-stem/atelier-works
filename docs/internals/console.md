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
| 意味の色 | 承認は青(`approval`)、失敗は赤(`destructive`)、通知は琥珀(`warning`)、成功は緑(`success`)。点、バッジ、ラベルに使う。通知の点だけは、文字より明るい`notice-mark`を使う |
| 文字の濃さ | 主(`foreground`)、副(`muted-foreground`)、補足(`subtle-foreground`)の3段 |
| 文字の大きさ | 12、13、14、16、20、24pxの6段(`text-caption`、`text-small`、`text-body`、`text-lead`、`text-title`、`text-display`)。本文の行間は1.7 |
| 書体 | Hiragino Sans、Noto Sans JP、system-uiの順。Webフォントを読み込まない。CSPが外部のファイルを拒むためである |
| 数字 | 件数や時刻は`tabular-nums`で桁をそろえる |
| 動き | 選択とhoverの遷移は150ms。動きを減らす設定の利用者には、遷移と回転を止める |

文字と背景の組が基準を満たすことは、`src/theme-tokens.test.ts`が`index.css`を読んで確かめる。
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
| `/console/` | 要対応 | 承認待ちの一覧 |
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

## API層

Consoleは、`src/api/windmill.ts`の`runScript`だけを通してWindmillのscriptを呼ぶ。
`POST /api/w/factory/jobs/run_wait_result/p/<path>`を、`credentials: "same-origin"`と`cache: "no-store"`で呼ぶ。
ログインのCookieだけで動くので、トークンは持たない。

呼べるscriptは、`SCRIPT_PATHS`の許可リストにある`console_query`と`approval_decide`だけである。
パスは呼び出し側の名前から引き、外から受け取った文字列では呼ばない。
Consoleは管理者のCookieで動くので、呼べる範囲を固定する。

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
書き込みでは、`job_failed`と`timeout_or_unknown`のどちらも、処理が途中まで進んでいる可能性がある。
そのため`describeApiError`は、書き込みの失敗を「結果が分かりません。一覧を読み直して確かめてください」と案内する。
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
`summary`の型は、`f/factory/steps/console_query.ts`の`ConsoleSummary`に合わせてある。
`tests/scripts/console_summary_contract.test.ts`が、次の2点を確かめる。

- backendの変換結果が型ガードを通ること
- backendの列挙の値が`labels.ts`の表に漏れていないこと

新しい値に気づくのは、この契約テストの役目である。

### 取得の方針

自動で取り直すのは`summary`だけで、120秒ごとに、タブが見えている間だけ取る。
サイドバーの件数と、要対応の一覧は、この1つの取得を共有する。
再試行するのは、通信の失敗、待ちの上限(`timeout_or_unknown`)、500を除く5xxだけで、2回までにする。
500はジョブの失敗として分類される。
401、403、4xx、形が違う応答、ジョブの失敗は再試行しない。再び取っても同じ結果になり、120秒ごとの取得に失敗が積み増されるためである。
書き込みは再試行しない。結果が分からないまま2回実行しないためである。

1つのタブが`summary`を取り直すと、1日に720件のジョブができる(120秒ごと)。
ジョブの保持期間は、#138で扱う。

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

要対応の項目を、承認、失敗、通知の3種類の和で持ち、時刻が新しい順に並べて一覧にする。
同時刻なら承認、失敗、通知の順にする。
2種類以上の項目があるときだけ、種類の切り替え(すべて、承認、失敗、通知)を出す。
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
チップが選んだ項目の種類を隠すときは、選択を外す。
一覧と詳細は別々にスクロールする。

一覧は`InboxList`、詳細は`InboxDetail`の別の部品が描く。
再実行、解決、承認などの行の操作は、一覧の行ではなく詳細のペインに置く。
一覧の行は1つのbuttonなので、操作のbuttonを入れ子にしないためである。
詳細は、種類ごとの描き分けを`InboxDetail`の1か所に集める。
詳細のペインは左寄せで、本文の幅は760pxまでにする。サイドバーを畳んでも位置が動かない。
一覧の行は、1行目に題名と相対時刻、2行目に種類、作業項目、期限、状態のバッジを並べる。
状態のバッジは2行目の末尾で、狭いときは省略記号で縮める。どの行も高さが同じになる。
行の頭に種類の点は付けない。期限が24時間を切った行だけ、期限に警告色の印を付ける。
選んだ行は、前景の藍を薄く混ぜた面と左の帯で示す。
承認の概要と行には、期限があれば残り時間を出し、過ぎていれば「期限切れ」と出す。
承認の概要には、題名、種類、作業項目(要件定義なら試行)、Issueへのリンク、期限、依頼した時刻を出す。
期限と依頼した時刻は、日本時間の絶対時刻と相対時刻を並べる(例: 10/15 18:48まで(残り6日)、10/09 18:48(1時間前))。
選んだ種類の項目がなくなったときは、チップを「すべて」に戻して描く。
IssueのリンクはGitHubのIssueのURLの形のときだけ張る。

この画面は読み取り専用で、承認や却下の操作は起こさない。
失敗と通知は一覧に出さない。`?failure=`か`?notice=`で選ぶと、「この種類の一覧は準備中です」と案内する。
一覧に出ていない件数は、種類ごとのカード(色の点、件数)で知らせる。
対象は、失敗、通知、取得の上限を超えた承認である。
カードは、旧Consoleの一覧へのリンク(「旧Consoleで見る」)にする。サイドバーの「旧Consoleを開く」と同じ行き先を使う。
同じ数をサイドバーには出さない。画面の中で1か所だけに示すためである。

一覧が空のときは、画面を2つに割らず、中央に1枚の面を出す。
面には、片付いたこと、最後に確かめた時刻、次の自動更新までの時間、ほかの種類に残る件数のカードを載せる。
401で取得できないときは、バナーと並べて、ログインが必要である旨を中央に出す。

並び、絞り込み、行の表示内容、副題、件数のカードは`src/lib/inboxView.ts`の純関数が決める。
次の自動更新までの時間と時刻の表示は`src/lib/refreshTiming.ts`が決める。
相対時刻の表示は、`src/app/clock.ts`の共有の時計が30秒ごとに進める。

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
| `ci.yml`の`console`ジョブ | `console/`を組み立て、成果物`console-dist`として上げる |
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

- miseで入れるツールは、bunと、viteとtscを動かすnodeだけにする。ほかの`[tools]`とそのinstall scriptを動かさない。
- miseのキャッシュを読み書きしない。
- ルートと`console/`の依存は`bun install --frozen-lockfile --ignore-scripts`で入れ、依存のinstall scriptを実行しない。
- `console/bun.lock`は`scripts/check-console-lockfile.ts`で検査する。registry由来でsha512のintegrityが付いた依存だけを許す。git、GitHub、tarballのURL、`console/`の外を指す`file:`と`link:`、`trustedDependencies`は拒む。

## 配信の経路

Caddyは、`/console/`の下を次の経路で返す。
`factory_console`の他のファイル(`pin`、`revoked.json`、`history.json`など)は配信しない。

| パス | 返すもの | キャッシュ |
| --- | --- | --- |
| `/console/status.json` | ボリューム直下の`status.json`。無ければ404 | `no-store` |
| `/console/assets/*` | 共有の`assets/`。無ければ404 | 長期(immutable) |
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

## 他のサイトからのAPIの呼び出し

`/api/*`への要求で`Sec-Fetch-Site`が`cross-site`か`same-site`のものは、Caddyが403にする。
ほかのポートのlocalhostや外部のリンクから、運用者のCookieでAPIを実行させないためである。

- Windmillのフロントエンドからの要求には、ブラウザが`Sec-Fetch-Site: same-origin`を付ける。
- CLI(`wmill`)は、このヘッダーを送らない。
- Windmill 1.817.0のraw app(旧Console)には、既定でsandboxが無い。`backend.*`の呼び出しは、`parent.postMessage`を通して同じオリジンの親(WindmillのSPA)が行うので、これも`same-origin`になる。
- raw appのsandboxを有効にすると、バンドルの取得(`GET /api/w/*/apps_u/get_data/v/*`)がcross-siteになって403になる。そのときは、この経路を例外にする必要がある。

## 古い版の掃除

共有の`assets/`のファイルは、置いてから14日を超え、残している版のどれからも参照されていなければ消す。
