# Consoleの配信の仕様

Consoleの成果物を組み立てて配信する仕組みと、ブラウザ側の制限と、draw.ioの図の取り込みを書く。
`console_fetcher`、Caddy、配信のワークフローを変更する人が読む。
Consoleのアプリの構成と画面の仕様は、[Consoleの仕様](../console.md)にある。

## 配信の構成

| 要素 | 役割 |
| --- | --- |
| `console/` | Consoleのソースコード(Vite + React) |
| `.github/workflows/console-dist.yml` | `main`へのpushで、`console/`を組み立てて成果物`console-dist`として上げる。成果物を上げるのはこのワークフローだけである |
| `ci.yml`の`console`ジョブ | PRで、`console-dist.yml`と同じ手順で組み立てられることを確かめる。成果物は上げない。型検査、lint、テストは`check`ジョブが担う |
| `infra/console_fetcher/` | 成果物を検証して、名前付きボリューム`factory_console`に書く |
| Caddy | `factory_console`を読み取り専用でマウントし、`/console/`で配信する |

`factory_console`は、どのworkerにも書き込みでマウントしない。
読む必要があるConsole用のworker(`windmill_worker_console`)にだけ、読み取り専用で渡す。
配信中のファイルを書き換えられると、運用者のブラウザに改ざんが居座るので、書けるのは取り込み専用の`console_fetcher`だけにする。

## console_fetcherのコンテナ

- uid 1000(rootでない)、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`で動く。
- 専用のnetwork`console_egress`につなぐ。
  このnetworkからは、DBとWindmillに届かない。
- 第三者のパッケージを入れない。
- dockerには外への行き先をドメインで絞る仕組みが無い。
  そのため、コードが接続する先を`api.github.com`と、そこからリダイレクトされたAzureのblob storage(`*.blob.core.windows.net`、`https:`のみ)に限る。
- 成果物の取得先へはトークンを送らない。

## 取り込みの検証

`console_fetcher`は、`console-dist.yml`の実行の成果物`console-dist`だけを取り込む。
`ci.yml`のジョブは、同名の成果物を上げても取り込まれない。
権限の違うジョブが成果物を上げ直して、配信物をすり替えるのを防ぐためである。

実行の一覧は、ワークフローのファイル`console-dist.yml`で絞って取得する。
取得した実行は、次をすべて満たすものだけを候補にする。
APIの絞り込みに頼らず、取り込み側でも確かめる。

1. ワークフローのパスが`.github/workflows/console-dist.yml`で、名前が`Console dist`である。
2. ブランチが`main`で、イベントが`push`である。
3. 状態が完了で、結論が成功である。
4. commitが40桁の16進数である。

候補を新しく作られた順に見て、同じcommitの`ci.yml`も成功している最初の実行を選ぶ。
`ci.yml`の確認は、`ci.yml`の実行の一覧にcommitを指定して取得し、次をすべて満たす実行があるかで決める。
こちらも、APIの絞り込みに頼らず取り込み側で確かめる。

1. ワークフローのパスが`.github/workflows/ci.yml`で、名前が`CI`である。
2. ブランチが`main`で、イベントが`push`である。
3. 状態が完了で、結論が成功である。
4. commitが、候補のcommitと一致する。

`console-dist.yml`は組み立てしか確かめないので、型検査、lint、テスト、秘密情報の走査を担う`ci.yml`の成功も条件にする。
`ci.yml`が実行中か失敗しているcommitは飛ばして、その前の候補を選ぶ。
確かめる候補は、新しい順に5つを上限にする。
候補を見ている途中で配信中の版に当たったら、その版を選んで探索を止める。
配信中の版より古いcommitに、版が戻らないためである。
戻して取り消した版(`revoked.json`のsha)は、候補から外す。
どの候補も満たさなければ、取り込まず今の版を配信し続ける。

`main`という名前のタグの実行は、`main`のブランチの実行と見分けがつかない。
そのため、両方のワークフローが同じcommitで成功していることを求める。
ただしこの照合だけでは、タグを作れる人は防げない。
残るリスクは[R-DLV-13](../../security-risks.md#r-dlv-13)である。

選んだ実行の成果物を、書く前に次をすべて確かめる。

1. 成果物の元のcommitが、その実行のcommitと一致する。
2. zip全体のsha256が、GitHubの`digest`と一致する。
3. 展開した全ファイルのsha256が、`manifest.json`と一致する。
4. マニフェストが、その実行のcommitのものである。

zipは自前のreaderでメモリ上に展開する。
`..`、絶対パス、symlink、通常のファイル以外、暗号化、zip64は拒む。

## CIの組み立て

`console-dist.yml`が、`main`へのpushのたびに組み立てて、成果物を上げる。
変更したパスによらず毎回動かす。
`console_fetcher`が、そのcommitの成果物を取り込むためである。
PRとタグのpushでは動かさず、`ci.yml`のジョブを足さない。
組み立ての手順は、このファイルに直接書き、別のファイルに分けない。
Factoryのトークンは`.github/workflows/`を書けない。
composite action(`.github/actions/`)は書けるので、分けると配布物がその変更に左右されるためである。

- ワークフローの権限は、リポジトリの読み取り(`contents: read`)だけにする。
  成果物の書き込みには、`GITHUB_TOKEN`の書き込み権限を使わない。
- ジョブは1つで、`console-dist.yml`にほかのジョブやトリガーを足さない。
- 実行を取り消さない。
  取り消した実行は成功しないので、そのcommitの成果物が欠けるためである。
- 同じ実行を「Re-run all jobs」で上げ直しても失敗しないように、成果物は上書きで上げる。

`ci.yml`の`console`ジョブは、PRで同じ手順を書き写して動かし、組み立てとビューアの取得を確かめる。
2つの手順が食い違わないことは、テストが確かめる。
成果物は上げない。
`scope`ジョブの`console`のフラグが偽のとき、このジョブを飛ばす。
型検査、lint、テストは`check`ジョブの`Check console`ステップ(`console:check`)が担い、どちらのワークフローも重ねて実行しない。
判定の詳細は[セットアップ](../../setup.md)の「CIの実行の範囲」にある。

- miseで入れるツールは、bunと、viteとtscを動かすnodeだけにする。
  ほかの`[tools]`とそのinstall scriptを動かさない。
- miseのキャッシュを読み書きしない。
- ルートと`console/`の依存は`bun install --frozen-lockfile --ignore-scripts`で入れ、依存のinstall scriptを実行しない。
- `console/bun.lock`は`scripts/check-console-lockfile.ts`で検査する。
  registry由来でsha512のintegrityが付いた依存だけを許す。
  git、GitHub、tarballのURL、`console/`の外を指す`file:`と`link:`、`trustedDependencies`は拒む。
- 組み立ての後、マニフェストを書く前に、draw.ioのビューアを取得して`dist/drawio/`に置く。
  詳細は「draw.ioの図」にある。

`ci.yml`の`console-a11y`ジョブは、組み立てたConsoleを[ブラウザでのa11y検査](../console.md#ブラウザでのa11y検査)にかける。
CheckoutからBuildまでの手順は`console`ジョブと同じで、テストが一致を確かめる。
ビューアの取得とマニフェストの書き出しは、このジョブに無い。
`scope`ジョブの`console`のフラグが偽のとき、このジョブも飛ばす。
PRの実行だけで動かし、`main`のpushでは飛ばす。
キャッシュのトークンは`permissions`と関係なく全ジョブに渡るので、照合しないブラウザを`main`の実行で動かさないためである。
`console`ジョブへは足さない。
`console-dist.yml`と手順を一致させる契約があるためである。

- 実行の上限は10分にする。
  ブラウザが固まっても、実行を長く占めないためである。
- ブラウザは、Playwrightの取得元(`cdn.playwright.dev`)から、headless shellだけを入れる。
- ブラウザはキャッシュせず、毎回取得する。
  取得物をハッシュで照合しないので、`main`の実行が書いたキャッシュをPRが読む経路を作らないためである。
  取得物を照合しない残るリスクは[R-DLV-07](../../security-risks.md#r-dlv-07)である。
- システムのパッケージ(`--with-deps`)も、毎回入れる。
- 失敗したときだけ、レポート(`playwright-report`)を3日間だけ上げる。
  成功では上げない。
- ci.ymlが上げてよいartifactは、名前の完全一致で許す。
  `metadata-patch`と`playwright-report`の2つだけで、`tests/scripts/ci_metadata_workflow.test.ts`が固定する。

## 配信の経路

Caddyは、`/console/`の下を次の経路で返す。
`factory_console`の他のファイル(`pin`、`revoked.json`、`history.json`など)は配信しない。

| パス | 返すもの | キャッシュ |
| --- | --- | --- |
| `/apps/get/f/factory/factory_console`と`/apps_raw/get/f/factory/factory_console`(配下を含む) | 固定の`/console/`への302のリダイレクト。パスとクエリは行き先に写さない | `no-store` |
| `/console` | `/console/`への308のリダイレクト。クエリ(`?approval=<id>`など)は保つ | - |
| `/console/status.json` | ボリューム直下の`status.json`。無ければ404 | `no-store` |
| `/console/assets/*` | 共有の`assets/`。無ければ404 | 長期(immutable) |
| `/console/drawio/*` | `current/`の`drawio/`。ビューアと受け口。無ければ404 | 長期(immutable) |
| `/console/drawio.html` | `current/`の`drawio.html`。無ければ404 | `no-cache` |
| `/console/*` | `current/`のファイル。無いパスは`index.html` | `no-cache` |

旧Consoleへの規則は、`/console/`の経路より先に評価する。
旧Consoleの編集画面(`/apps/edit/...`)とAPIは飛ばさない。
この規則は、過去のリンクが残り続けるため、旧Consoleのappを消した後も残す。
302にするのは、ブラウザに転送を覚えさせないためである。
転送を覚えると、規則を変えたときに古い行き先へ飛び続ける。

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
前の確認の開始から2秒は空ける。
空いていなければ、空くまで待ってから確かめる。
失敗が続けざまに起きても、確認が続けて走らないためである。
待っている間に何度来ても、確認は1回にまとめる。
確認の実行中に来た要求は、何度来ても、実行が終わった後に1回だけやり直す。
実行中の確認が、失敗より前に始まっていて、版の入れ替わりを見落とす場合があるためである。
やり直しも、前の確認の開始から2秒を空ける。
イベントの既定の動作は変えない。
失敗したimportは、そのまま例外になる。
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

- `script-src`を`/console/assets/`に絞ったCSP。
  `'unsafe-inline'`と`'unsafe-eval'`は許さない。
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

- パーセント符号を戻しただけで正規化していない元のパスが`/console/`で始まる要求は、どの転送先(`windmill_server`、`windmill_extra`)にも渡さない。
  Consoleの経路で返すか、404にする。
  `/console`そのものを含み、大文字小文字と先頭の`/`の重複は区別しない。
- Caddyは`handle`をmatcherの種類で並べ替える。
  そのためCaddyfileでは`route`で順序を固定し、Consoleの経路とこの404を、どの`reverse_proxy`よりも先に評価させる。
- Consoleの経路では、生のパスに`%2f`か`%5c`(大文字小文字を問わない)があれば400にする。

Consoleの画面のURLに、符号化した区切りを使ってはいけない。

### 開くときのホスト名

`script-src`は、ブラウザが使ったスキーム、ホスト、ポートを含む`/console/assets/`のURLで絞る。
CSPのパスには、オリジンが要るためである。
IPv6のリテラル(`http://[::1]:8080/console/`など)で開くと、このURLの形が崩れてscriptが拒否される。
IPv4のアドレス(`127.0.0.1`など)かホスト名で開く。

## draw.ioの図

要件定義書の図は、最上位のページではなく、隔離したiframeの中で描く。
何を守るかは、[Consoleの安全策の内部仕様の「draw.ioの図の描画」](security.md#drawioの図の描画)にある。
要件定義書の画面が、本文の図ごとに`DrawioFrame`で描く。
flowの図は、このiframeを使わず、自前のSVGで描く([flowの図の画面](graphs.md#flowの図の画面))。

| ファイル | 役割 |
| --- | --- |
| `console/drawio-viewer.json` | ビューアの版、commit、取得元のURL、sha256の固定。保護パス |
| `console/scripts/drawio-viewer.ts` | 固定の値の検査と、取得したビューアの照合(`verifyViewer`)。純粋関数 |
| `console/scripts/fetch-drawio-viewer.ts` | CIが呼ぶ。取得して照合し、`dist/drawio/`に書く |
| `console/public/drawio.html` | 図を描くページ。scriptはすべて外部のファイルで、通常のscriptとして読む |
| `console/public/drawio/drawio-frame-*.js` | ページの中の受け口。素のJavaScriptで、ビルドを通らない |
| `console/src/lib/drawioMessages.ts` | 親が送るメッセージの組み立てと、iframeから届いたメッセージ(高さ、失敗の種類)の検査。純粋関数 |
| `console/src/lib/drawioFrameState.ts` | iframeの状態の遷移(load、メッセージ、応答なし、XMLの差し替え)を`(state, event) => state`で表す。純粋関数 |
| `console/src/components/drawio/DrawioFrame.tsx` | 親の部品。どの画面からも使える |

### ビューアの取得

ビューアはリポジトリに入れない。
`console-dist.yml`の手順は、組み立ての後に`fetch-drawio-viewer.ts`を動かす。
ビューアは`dist/drawio/drawio-viewer-<sha256の先頭8桁>.js`に書く。
取得したバイト列のsha256が固定の値と違えば、何も書かずに失敗する。
URLはリダイレクトを許さず、パスはcommit配下のビューア1ファイルに限る。
応答は10MBまでで、一時的な失敗(ネットワーク、429、5xx)は、待ちを倍にしながら3回まで再試行する。
取得物は、固定のsha256をキーにして`actions/cache`に保持する。
キーとして使う前に、sha256が64桁の小文字の16進数かを検査し、形が違えば失敗させる。
保存先は`console/.cache/drawio-viewer`で、Gitには入れない。
キャッシュに一致するファイルがあれば取得しない。
キャッシュの中身は信用せず、使う前に固定のsha256と照合する。
照合に通らなければ、取得し直す。
キャッシュは`dist/`の外に置く。
`dist/drawio/`には受け口のscriptもあり、キャッシュから戻すと、組み立てた受け口を上書きしてしまうためである。
raw.githubusercontent.comの障害で取得に失敗したら、失敗したワークフローの実行を再実行する。
キャッシュに当たれば取得せず、外れれば取得し直す。
ビューアはApache-2.0のライセンスである。
`console_fetcher`は、他の配信物と同じように、マニフェストの照合を経て`releases/<sha>/drawio/`に置く。
共有の`assets/`には入れない。
`current`から`/console/drawio/`として配信する。
そのため、版を入れ替えたとき、古い版の`drawio/`は`releases/`の掃除に従って消える。
`console_fetcher`のコードは、このディレクトリのために変える必要が無い。
マニフェストの検査は、`assets/`の入れ子だけを拒む。

ローカルの`mise run console:check`は、ビューアを取得しない。
ネットワークが無くても通る。

`console/scripts/public-assets.test.ts`が、`drawio.html`の参照と固定の値の一致を確かめる。
受け口のscriptを直したときは、ファイル名のハッシュを中身に合わせて付け直す。
同じテストが、合っていないファイル名を検出する。

### ビューアの更新

固定の更新は、Windmillの`f/factory/drawio_viewer_bump`が毎週月曜の10:00(Asia/Tokyo)に行う。
新しい版があれば、固定を書き換えるPRを作る。
人が固定のファイルを手で直す必要はない。
どこで動かすかと、何を守るかは、[Consoleの安全策の内部仕様の「ビューアの更新」](security.md#ビューアの更新)にある。

| ファイル | 役割 |
| --- | --- |
| `f/factory/drawio_viewer_bump.ts` | スケジュールが呼ぶ。取得、観測の記録、重複の確認、PRの作成。判断は純粋関数に任せる |
| `f/factory/lib/drawio_viewer_bump.ts` | 版の比較、14日の待ち、大きさの確認、既存のブランチの確認、sha256の計算、固定のファイルとページの書き換え。純粋関数 |
| `f/factory/lib/drawio_viewer_bump_github.ts` | 更新だけが使うGitHubの操作。リリースの一覧、タグの解決、ファイルの読み取り、PRの一覧、差分の比較、1つのcommitでのブランチの作成 |
| `f/factory/lib/drawio_viewer_observations.ts` | タグごとに、最初に見たcommitと時刻を記録する |
| `migrations/datatable/main/20261011153000_drawio_viewer_observations.up.sql` | 記録の表`factory.drawio_viewer_observations` |

保護パスの一覧は、[PRワークフローの仕様の「保護パスの変更を止める」](../pr-workflow.md#保護パスの変更を止める)にある。

処理は次の順に進む。

1. `main`の`console/drawio-viewer.json`を読み、今の版を知る。
2. jgraph/drawioのリリースの一覧から、今の版より新しい版を、新しい順に最大20件選ぶ。
3. 選んだタグごとに、指すcommitをGitHubのAPIでたどり、タグとcommitの組を記録する。
   同じcommitなら記録済みの時刻を保つ。
   タグが別のcommitに付け替えられていたら、時刻を今に取り直す。
   解決できないタグは、警告を出して飛ばす。
4. 公開から14日以上たち、かつ、同じcommitを14日以上前から見ている最新の版を選ぶ。
   メジャー版は問わない。
   無ければ、何もせず終わる。
5. 未完了の更新のPR(ブランチ名が`factory/drawio-viewer-`で始まり、headがこのリポジトリのもの)があれば、何もせず終わる。
   選んだ版のブランチをheadにしたPRが、閉じたものを含めて1件でもあれば、作らない。
6. 選んだ版のcommitのビューアを、固定と同じ形のURLから取得する。
   取得物の大きさとgit blobのIDを、GitHubのAPIの値と照合する。
7. 大きさが今から2割を超えて増減していないかを確かめる。
8. 取得物のsha256を計算し、`console/drawio-viewer.json`と、`console/public/drawio.html`が読むビューアの名前の新しい内容を作る。
9. 選んだ版のブランチが、PRは無いのに既にあれば、先頭のcommitを1回だけ取る。
   そのcommitで、各ファイルのgit blobのIDが手順8の内容と一致し、`main`との差分がその2ファイルだけで名前の変更を含まないことを確かめる。
   合わなければPRを作らない。
10. `factory_repo_id`があれば、書き込みの前に、`factory_repo`の現在のリポジトリIDと照合する。
    食い違うときと見つからないときは、ブランチとPRを作らずに終わり、`factory_repo_id_mismatch`のnoticeが残る。
11. ブランチが無ければ1つのcommitで作る。
    PRを開き、PRのheadのcommitが、作った(または確かめた)commitと同じかを確かめる。
    違えばラベルを付けずに止める。
    同じなら自動レビューのラベルを付ける。

最初に動かした週は、すべての版の観測が始まったばかりなので、14日間は何も上げない。
観測の記録が消えたときも、同じように待ちを数え直す。

PRの本文は、PRテンプレートの章立てで、版、commit、sha256、大きさを書く。
メジャー版が変わる更新は、題名を`[major]`で始める。
本文の先頭には、メジャー版の更新であることと、旧と新の版を書く。
続けて、破壊的変更の可能性があるため、リリースノートとCSP、sandbox、`drawio_frame_isolation`の確認を人が行うと書く。
人は、マージの前にリリースノートを読み、CSPと図の隔離のテストが通っていることを確かめる。
PRは通常のCIを通る。
`console`ジョブが、書き換えた固定のURLからビューアを取得し、sha256を照合する。
`public-assets.test.ts`が、ページの参照と固定の一致を確かめる。
自動レビューが指摘を付けても、このPRにはPR修正を始めない(ブランチ名で判定する)。
`factory:fix`ラベルを付けても動かず、ラベルは消費されずに残る。
修正は人が行う。
ブランチ名だけで判定するので、担当するすべてのリポジトリに効く。
マージの後は、他のConsoleの変更と同じく、CIが通れば数分で`console_fetcher`が反映する。
図が描かれることは自動では確かめないので、マージの後にConsoleの要件定義書の図を開いて確かめる。

自動では上げない版は、noticeの`drawio_viewer_bump_held`に残る。

| 原因 | 本文に載ること |
| --- | --- |
| 大きさが今から2割を超えて増減した | 版と、今と新しい大きさ |
| 大きさとgit blobのIDが、GitHubのAPIの値と違う | 版 |
| PRの無い既存のブランチの中身が、作るはずの内容と違う | 版とブランチ名。次の操作は、ブランチを確かめ、不要なら削除する |
| PRを作る間にブランチの先頭が変わった | 版、PRの番号、ブランチ名。次の操作は、PRとブランチを確かめ、不要ならPRを閉じてブランチを削除する |

上げる版に選んだ最新の版を保留している間は、それより古い版も上げない。
保留の理由が、noticeに出続ける。

メジャー版の更新は、この通知には残らない。
PRの題名と本文で知らせる。
大きさの変化が正当なら、Windmillで`f/factory/drawio_viewer_bump`を、`approved_version`にその版(例: `v33.0.0`)を指定して実行する。
指名した版は、2割の制限を免れる。
公開から14日の待ちと、GitHubのAPIの値との照合は、指名しても免れない。
空のファイルと10MBを超えるファイルは、指名しても上げない。
上げないと決めたときは、noticeを解決する。
原因が続くと、次の週に出直す。

失敗(GitHubのAPIの障害、ネットワーク、トークンの失効)はジョブの失敗になり、スケジュールの失敗の通知に流れる。
次の週に再び試すので、人が再実行する必要はない。

更新のPRが閉じられたときは、その版を再び提案しない。
次の版が出れば、また提案する。
更新のPRが開いたまま残ると、次の更新は止まる。
マージするか閉じる。

自動の更新が使えないときだけ、固定を手で上げる。
手順は次のとおりである。

1. jgraph/drawioのリポジトリを、blobを取らない部分cloneで取る。
2. 新しいcommitがリリースのタグ(`v<版>`)にあることを、`git tag --contains <commit>`で確かめる。
3. `git show <commit>:src/main/webapp/js/viewer-static.min.js | shasum -a 256`で、sha256を計算する。
   配信用のURL(raw.githubusercontent.com)から取ったバイト列を使わず、gitのオブジェクトから取る。
4. `console/drawio-viewer.json`の4項目を書き換える。
   URLはそのcommitを指し、sha256は3.の値である。
5. `console/public/drawio.html`が読むビューアの名前を、新しいsha256の先頭8桁に合わせる。

### iframeとメッセージ

親の部品は、`sandbox="allow-scripts"`と`referrerPolicy="no-referrer"`を付けたiframeで`/console/drawio.html`を読み込む。
XMLが変わるたびに、iframeを作り直す(keyを変える)。
1つのiframeの一生で送るのは、最初の`load`の後の1回だけである。
受け口は、`load`の前にscriptの実行を終えているためである。
状態の遷移は`console/src/lib/drawioFrameState.ts`の`reduceFrame`にある。
`shouldSendXml`が、このloadでXMLを送ってよいかを返す。

2回目の`load`は、iframeが別の文書へ遷移したことを表す。
親は、iframeを`about:blank`にして表示を止め、固定の文を出す。
以後、そのiframeのメッセージは受けない。
この停止は最善の努力である。
loadが起きない遷移は検知できず、止まらない。
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
図が上限より高いときは、親のiframeが1600pxで止まり、iframeの中で縦にスクロールする。
横には隠す。
縦のスクロールバーが出入りして幅が変わると、ビューアが図を合わせ直して高さが変わり、高さの通知が往復するため、幅は固定する(`scrollbar-gutter: stable`)。
枠線は、iframeの外側の要素に付ける。
iframeに付けると、枠線の分だけ高さが足りなくなる。

### 図の色

要件定義書の図は、ダークのとき、図を包む要素の明暗を反転する。
包む要素には、`filter: invert(1) hue-rotate(180deg)`と同じ働きのクラスを付ける。
クラスは`in-data-[theme=dark]:invert`と`in-data-[theme=dark]:hue-rotate-180`である。
`html`の`data-theme`が`dark`のときだけ効き、ライトでは何も掛けない。
白い地は暗くなり、黒い文字は明るくなる。
色相を半周戻すので、青、緑、橙、赤の色の意味は保たれる。

図は、iframeの文書(`console/public/drawio.html`)が描く。
iframeの文書と受け口は保護パスで、テーマを伝える経路を足せない。
フィルターは親の画面の要素に掛けるので、保護パスに触れない。

固定したビューア(32.4.1)の`dark-mode`の既定は、設定なしである。
`auto`を渡したときだけ、ビューアが`prefers-color-scheme`を見て自らダークにする。
iframeの文書は`dark-mode`を渡さないので、ビューアは自らダークにならない。
OSがダークでConsoleが「OSに合わせる」のときも、反転は包む要素の1回だけである。
実機では、この組み合わせと「ダーク」を選んだ場合で、図が画素まで同じになることを確かめた。

枠線は、反転させる要素の外側に置く。
同じ要素に掛けると、枠線の色まで反転するためである。

ダークの図の見え方は、次のとおりである。
薄い塗りの箱は、ダークでは同じ色相の暗い塗りになり、白い文字との比は14:1以上である。
濃い塗りの箱は、ダークでは同じ色相の明るい塗りになり、黒い文字との比は5.8:1である。
図の地は黒になり、周りの画面(面の色)より暗い。
図の作者が指定した色は反転するので、作者の意図と明暗が逆になる。

残る制限は、OSの設定に従う経路である。
`theme-init`が動かない環境では、`data-theme`が付かないので、OSの設定がダークでも図は反転しない。
その環境でも、図は白い紙として読める。

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

`/api/*`への要求は、次のどれかに当てはまるとCaddyが403にする。
ほかのポートのlocalhostや外部のリンクから、運用者のCookieでAPIを実行させないためである。

- `Sec-Fetch-Site`が`cross-site`か`same-site`である。
- `Origin`ヘッダーがあり、ブラウザが開いたホスト名とポートのオリジンと一致しない。
- 副作用のあるGETのAPIを、fetchとXHR以外の読み込み(`<img>`、リンク、iframeなど)から呼んでいる。
- GETとHEAD以外の要求が、ページの移動(`Sec-Fetch-Mode: navigate`)で送られている。

### Sec-Fetch-Siteの規則

- Windmillのフロントエンドからの要求には、ブラウザが`Sec-Fetch-Site: same-origin`を付ける。
- CLI(`wmill`)は、`Sec-Fetch-*`、`Origin`、`Cookie`のどれも送らない。

### Originの検査

`Sec-Fetch-Site`を送らない古いブラウザは、1つ目の規則を素通りする。
ブラウザは、GETとHEAD以外の要求には`Origin`を付けるので、2つ目の規則がそれを止める。
ナビゲーションや`<img>`のGETには`Origin`が付かない。
Firefox 70未満は、フォームのPOSTにも付けない。
そのため、この検査が補えるのは、GETとHEAD以外のブラウザの要求だけである。

ブラウザが開いたオリジンは、`Host`ヘッダーのホスト名とポートに、`http://`か`https://`を付けたものである。
許すのはこの2つだけで、`WM_HTTP_PORT`やホスト名を変えても規則はそのまま合う。
前段でTLSを終端するときは、プロキシがブラウザの使った`Host`を、ポートを含めて保つ必要がある(nginxなら`proxy_set_header Host $http_host`)。
nginxの既定は`Host`を転送先の名前に書き換え、`$host`はポートを落とす。
どちらも`Origin`と合わなくなり、ログインを含む書き込みがすべて403になる。
`Host`が内部の名前に変わると、ブラウザの`Origin`と合わず、書き込みがすべて403になる。
`http://localhost:8080`で開いたなら、`http://localhost:8080`と`https://localhost:8080`が通る。
同じポートでも、`http://127.0.0.1:8080`は通らない。
ポートが違うもの、末尾に`/`が付いたもの、`Origin: null`も止める。

### 副作用のあるGET

Windmillには、GETでジョブを起動するAPIがある。
例は`GET /api/w/<workspace>/jobs/run_wait_result/p/<path>?payload=<base64>`である。
同じオリジンの`<img>`やリンクから呼ぶと、`Sec-Fetch-Site: same-origin`で`Origin`も付かず、上の2つの規則を通る。
Cookieの持ち主の権限でジョブが動き、承認のscriptなら、Cookieの持ち主が承認者として記録される。
そのため、次のGETとHEADは、`Sec-Fetch-Dest`が`empty`(fetchとXHR)で、かつ`Sec-Fetch-Mode`が`navigate`でないときだけ通し、それ以外は403にする。
`<a download>`は`Sec-Fetch-Dest`が`empty`でも`navigate`になるので、`Sec-Fetch-Mode`でも止める。
この規則の対象は、下の表のGETだけである。
読み取りのナビゲーションには影響しない。
Consoleの呼び出しはPOSTの`fetch`なので、影響しない。

| 経路(`/api/w/<workspace>/`の下) | 理由 |
| --- | --- |
| `jobs/run_wait_result/p/<path>`と`jobs/run_wait_result/fv/<version>` | scriptとflowを起動し、結果を待つ |
| `jobs/run_and_stream/f/<path>`、`fv/<version>`、`p/<path>`、`h/<hash>` | scriptとflowを起動し、結果を流す |
| `jobs/slack_approval/<id>`と`jobs/teams_approval/<id>` | SlackとTeamsへ承認のメッセージを送る |
| `job_helpers/move_s3_file` | オブジェクトストレージのファイルを動かす |

`Sec-Fetch-Dest`を送らないブラウザは、`Cookie`を持つときだけ止める。
対象は、古いブラウザと、HTTPで公開したブラウザである。
`Sec-Fetch-*`は、信頼できるオリジン(localhostかHTTPS)でだけ付く。
そのため、WindmillのフロントエンドがこれらのGETを使うと、その環境では403になる。
CLIとscriptは、`Sec-Fetch-*`と`Cookie`を送らず、`Authorization`で認証するので、そのまま通る。

パスの照合は、大文字小文字を区別せず、`//`の重なりも許す。
作業スペースの部分は`/`をまたいで一致させるので、`%2f`で`/`を隠しても逃げられない。
`%72un_wait_result`のようにパーセント符号で綴りを変えても、Caddyが戻してから照合するので止まる。

洗い出しは、`windmill-client`の`services.gen.d.ts`にある453個のGETのAPIを、名前と説明で分類して行った。
サーバーの全経路を網羅した確認ではなく、`/api/r/*`のカスタムHTTPルート(HTTPトリガー)は含まない。
このリポジトリはHTTPトリガーを持たない。
足すときは、GETでjobを起動する経路にならないか、認証の方式とあわせて確かめる。

次のGETは、副作用があるか、起動する可能性があっても、対象にしない。

| 経路 | 対象にしない理由 |
| --- | --- |
| `jobs_u/resume/<id>/<resume_id>/<signature>`と`jobs_u/cancel/...` | 署名が資格情報で、Cookieに頼らない。メールの承認リンクとして、ナビゲーションで開くため |
| `auth/login_link/<token>`、`mcp/oauth/start`、`mcp/oauth/callback` | ログインとOAuthの導線で、ナビゲーションで開くため |
| `users/refresh_token` | 新しいトークンを返すだけで、攻撃者に得がない |
| `jobs/resume_urls/...`と`jobs/job_signature/...` | 署名付きURLを返すだけで、応答は別のオリジンから読めない |
| `job_helpers/test_connection`と`workspaces/test_datatable_connection/...` | 設定済みの接続を試すだけで、状態を変えない |
| 上以外の`list`、`get`、`count`、`exists`、`history`、`download`など | 読み取りだけである |

Windmillのフロントエンドの実装は読んでいない。
対象のGETを`fetch`以外で開く導線があれば、そのリンクは403になる。
ジョブ結果の表示は`jobs_u/get`などの読み取り系のGETを使い、対象に入れていない。

### ページの移動で送られる書き込み

同じオリジンに注入された`<form method="post" action="/api/w/<workspace>/jobs/run/p/...">`は、クリック1回で送られる。
このPOSTは、`Sec-Fetch-Site: same-origin`で、`Origin`も一致し、`Sec-Fetch-Dest`は`document`になる。
上の3つの規則は、どれも止められない。
そのため、GETとHEAD以外の要求で`Sec-Fetch-Mode`が`navigate`か`nested-navigate`のものは、メソッドを問わず403にする。
ConsoleとWindmillのフロントエンドのAPI呼び出しは`fetch`なので、`Sec-Fetch-Mode`は`cors`か`same-origin`になり、影響しない。

GETとHEADは、この規則では止めない。
APIをナビゲーションで開く正当な導線があるためである。
副作用のあるGETは、前の節の規則が止める。
ナビゲーションで開く導線は、次のとおりである。

| 経路(`/api/`の下) | 導線 |
| --- | --- |
| `w/<workspace>/jobs_u/resume/...`と`jobs_u/cancel/...` | メールとSlackの署名付きの承認リンク |
| `auth/login_link/<token>` | ログインのリンク |
| `oauth/login_callback/...`、`oauth/connect_callback/...`、`mcp/oauth/start`、`mcp/oauth/callback` | OAuthの認可とコールバック(IdPからのリダイレクト) |
| `w/<workspace>/job_helpers/download_s3_file`、`jobs_u/get_log_file/...`、`jobs/completed/export`、`users/export`、`groups/export`など | ファイルのダウンロードとエクスポート |
| `openapi.yaml`、`version` | 利用者が直接開くページ |

この一覧は、型定義の名前と説明から選んだもので、UIの実装を読んで確かめたものではない。
GETとHEAD以外をナビゲーションで送る導線は、型定義から見つけていない。
`Sec-Fetch-Mode`が無い古いブラウザと、HTTPで公開したブラウザは、止めない。
`Cookie`だけで止めると、`fetch`の書き込みまで巻き込み、UIが動かなくなるためである。

### 実機での確認

規則は、Caddyを起動して`bash scripts/check-caddy-origin.sh`で確かめる。
composeと同じイメージで`infra/Caddyfile`を動かし、止めるべき要求が403に、通すべき要求が(転送先のWindmillを起動しないので)502になることを、`curl`で比べる。
旧ConsoleのURLの転送も、同じスクリプトで確かめる。
旧Consoleのパスと配下、重なった`/`、クエリ付きの要求が、どれも`Location`が`/console/`だけの302になること、名前の続く別のアプリと編集画面は飛ばさないことを比べる。
Caddyが起動しないときは、コンテナのログを出して失敗する。
CIの`caddyfile`ジョブも、同じスクリプトを動かす。
Dockerが要る。
`CHECK_PORT`で、待ち受けるポートを変えられる(既定は18080)。

## 古い版の掃除

共有の`assets/`のファイルは、置いてから14日を超え、残している版のどれからも参照されていなければ消す。
