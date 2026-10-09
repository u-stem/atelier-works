# Consoleの配信の仕様

Consoleの成果物を取り込む`console_fetcher`と、配信するCaddyの仕組みを書く。
Consoleの配信を変更する人が読む。
何を守るかと残るリスクは、[セキュリティ](../security.md)の「Consoleの配信」にある。

## 構成

| 要素 | 役割 |
| --- | --- |
| `console/` | Consoleのソースコード(Vite + React) |
| `ci.yml`の`console`ジョブ | `console/`を組み立て、成果物`console-dist`として上げる |
| `infra/console_fetcher/` | 成果物を検証して、名前付きボリューム`factory_console`に書く |
| Caddy | `factory_console`を読み取り専用でマウントし、`/console/`で配信する |

workerはすべてのジョブをrootで動かすので、`factory_console`をマウントしない。

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

開いたままのタブは、`manifest.json`と`status.json`を読んで、自分の版が配信中かを確かめる。
実装は`console/src/lib/`と`console/src/`にある。

- `lib/release.ts`: 判定
- `lib/releaseCheck.ts`: 取得と判定の1回分
- `useReleaseWatch.ts`: 周期の管理

自分の版は、画面が参照するscriptとstylesheetのうち、`/console/assets/`の下にあるファイル名の集合で見分ける。
集合が空のとき(開発サーバーなど)は確かめない。
ビルドに版のshaは埋め込まない。版ごとに中身が変わると、`console_fetcher`の中身による同一判定と`revoked.json`の照合が働かなくなるためである。

判定は次のとおり。

| 状況 | 表示 |
| --- | --- |
| 集合のファイルがすべて`manifest.json`にある | 出さない |
| 1つでも無い | 再読み込みを促す控えめな帯 |
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

## 他のサイトからのAPIの呼び出し

`/api/*`への要求で`Sec-Fetch-Site`が`cross-site`か`same-site`のものは、Caddyが403にする。
ほかのポートのlocalhostや外部のリンクから、運用者のCookieでAPIを実行させないためである。

- Windmillのフロントエンドからの要求には、ブラウザが`Sec-Fetch-Site: same-origin`を付ける。
- CLI(`wmill`)は、このヘッダーを送らない。
- Windmill 1.817.0のraw app(旧Console)には、既定でsandboxが無い。`backend.*`の呼び出しは、`parent.postMessage`を通して同じオリジンの親(WindmillのSPA)が行うので、これも`same-origin`になる。
- raw appのsandboxを有効にすると、バンドルの取得(`GET /api/w/*/apps_u/get_data/v/*`)がcross-siteになって403になる。そのときは、この経路を例外にする必要がある。

## 古い版の掃除

共有の`assets/`のファイルは、置いてから14日を超え、残している版のどれからも参照されていなければ消す。
