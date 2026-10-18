# セキュリティ

Software Factoryの信頼境界、秘密値の扱い、資格情報の取得手順、各フローの安全策を説明する。Factoryを運用する人と、フローを変更する人が読む。安全策の仕組みの詳細は[実装フローの仕様](internals/implement.md)と[PRワークフローの仕様](internals/pr-workflow.md)にある。

## 信頼境界

Issue本文と対象リポジトリの内容は、信頼できない入力として扱う。headless Claudeはこれらをデータとして読むだけで、内容に書かれた指示には従わない。要件定義の生成での扱いは`factory-requirements`スキルに定める。

### 書き込める範囲

どのフローのClaudeにも、コマンドを実行するツール(`Bash`)は渡さない。
書き込みのツールを渡すフローでも、書いてよい場所をフローごとに絞る。
`--restricted`は、ファイルのツールを作業ディレクトリと`--add-dir`のディレクトリの下に閉じる。

| フロー | 書き込みのツール | 書いてよい場所 |
| --- | --- | --- |
| 要件定義の生成 | `Write`、`Edit` | 試行ごとの作業ディレクトリ(要件定義書と図)だけ。対象リポジトリのworktreeは`--add-dir`で読ませるだけにする |
| 監査 | `Edit`だけ | 作業ディレクトリの`report.md`だけ。self cloneのスナップショットは`--add-dir`で読ませるだけにする |
| PRのレビュー | なし | なし |
| dependabotの更新の影響調査 | なし | なし |
| PRの修正 | `Edit`、`Write` | PRのブランチのworktree |
| 実装 | `Edit`、`Write` | 実装ブランチのworktree。要件定義は複製を渡す |

要件定義と監査では、書いてよい場所をスキルとプロンプトで指示する。
`--restricted`が`--add-dir`のディレクトリへの書き込みを拒むかは、確かめていない。
書き込まれても外へ出ないよう、どちらのディレクトリもpushしない。
要件定義の生成のworktreeは、承認と掃除で消す。
監査のスナップショットは、実行のたびに作り直して消す。

残るリスクとして、要件定義の生成のworktreeは、既定ブランチの先頭が同じ間は次の試行でも使い回す。
そのため、Claudeが書き込んだ内容を、同じIssueの次の試行のClaudeが読みうる。

headless Claudeの起動には、次のフラグと環境変数で防御を足す。

| 設定 | 効果 |
| --- | --- |
| `--setting-sources user` | 対象リポジトリの`.claude/`などのプロジェクト設定を読み込ませない |
| `--strict-mcp-config` | 対象リポジトリのMCP設定を無視し、明示的に渡した設定だけを使う |
| `--max-budget-usd`、`--max-turns`、サブプロセスのタイムアウト | 暴走とコストの超過を打ち切る |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` | システムプロンプトにgit statusの写しとcommit・PRの手順を載せない |

最後の環境変数は、すべてのフローで設定する。写しを作るとき、Claudeは起動時に作業ディレクトリでgitを実行する。そのため、書き換えられた`.git`の参照先にあるconfig(`core.fsmonitor`など)を読みうる。どのフローのClaudeにも`Bash`を渡さないので、gitの文脈を使う処理は無い。

PRの修正(`pr_fix`)と実装(`implement`)のフローは、Claudeが対象リポジトリのworktreeに書き込み、その変更をpushする。
そのための追加の安全策は[PR修正の安全策](#pr修正の安全策)と[実装の安全策](#実装の安全策)に書く。

### mainの保護とリポジトリの公開

このリポジトリは公開している。
`main`はrulesetの`protect-main`で保護し、次の制限をかける。

- `main`の削除とforce pushを禁止する。
- `main`への変更はPRを必須にする。承認は0件でよく、人のレビューをGitHubが強制するわけではない。
- 必須チェックは`scope`、`check`、`test-db`、`metadata`、`console`、`caddyfile`、`console-fetcher-image`である。条件付きのジョブは、スキップされると通過として扱われる。
- 設定を迂回できるのは、管理者のロールだけである。迂回のモードは`pull_request`なので、直接pushはできず、PRを経由する迂回に限られる。

迂回すると、`check`などの必須チェックが失敗していてもPRをマージできる。
運用者は、迂回を使わず、必須チェックが成功してからマージする。

タグはrulesetの`protect-tags`で保護する。
対象はすべてのタグで、作成、更新、削除を禁止する。
迂回できるのは、リポジトリの管理者のロールだけで、常に迂回できる。
`main`という名前のタグの実行は、`main`のブランチの実行と見分けがつかない。
`protect-tags`は、このタグを経由してConsoleの配布物(`console-dist`)をすり替える経路を塞ぐ。
このリポジトリはタグを使わないので、運用には影響しない。
タグを使うようにするときは、rulesetを見直す。
設定の確認は[運用](operations.md)の「タグのrulesetを確かめる」にある。

公開に伴い、外部からの操作は次のように絞る。

- GitHubのinteraction-limitsを`collaborators_only`にしている。期限付きの設定で、切れると外部の利用者もIssueやPRを作れるようになる。期限はGitHubの設定画面で確かめる。
- forkのPRのワークフローは、すべての外部の投稿者について、承認があるまで動かさない。
- secret scanningとpush protection、Dependabot security updatesを有効にしている。
- 脆弱性は、非公開の報告で受ける。窓口は[SECURITY.md](../SECURITY.md)にある。

FactoryはPAT(`f/factory/github_token`)で、人と同じアカウントとしてGitHubを操作する。
PRをマージするAPIを呼ぶのは、dependabotの更新のフローだけで、既定では無効である([dependabotの更新の自動マージ](#dependabotの更新の自動マージ))。
PATが`main`へのマージの権限を持つかは確かめていない。
承認が0件なので、PATで開いたPRを人の確認なしにマージできるかも確かめていない。
どちらも確かめるまでは、残るリスクとして扱う。

### CIで走査されないコミット

atelier-worksのCIは、gitleaksでPRのコミットを走査する。
走査されないコミットが、次の2つの場合に残る。

残るリスクとして、PRのCIの実行は、同じPRの新しい実行が始まると`cancel-in-progress`で止まる。
秘密値を含むコミットを、実行の途中でforce pushにより置き換えると、置き換えられたコミットはCIのgitleaksで走査されない。
置き換えられるのは、PRの履歴から外れたコミットなので、受け入れる。
手前の防御として、lefthookのpre-commitのgitleaksと、Factoryのpush前の走査がある。

残るリスクとして、`push`は`main`だけで動くので、PRを作るまで、人がpushしたブランチのコミットはCIで走査されない。
実行されるのはlefthookのpre-commitのgitleaksだけで、ローカルで飛ばせる。
PRを作ればCIが走査し、Factoryは実装ブランチのpushの前に走査するので、受け入れる。

### CIのトークンの権限

`ci.yml`の既定の権限は、リポジトリの読み取り(`contents: read`)だけである。
`scope`ジョブだけが、実行の一覧を読む権限(`actions: read`)を足す。
`main`へのpushで、直近で成功した実行のcommitを調べ、差分の基点にするためである。
どちらも読み取りだけで、書き込みの権限は付けない。
トークンを`gh`に渡すのは`main`へのpushの実行だけで、PRの実行には渡さない。
`metadata`ジョブも権限を足さない。
失敗したときに限り、PRの実行でartifactを上げる([CIのメタデータの再生成](#ciのメタデータの再生成))。

`console-dist.yml`の既定の権限も、`contents: read`だけである。
ジョブは権限を足さない。
成果物の書き込みは、`GITHUB_TOKEN`の書き込み権限を使わず、ランナーの実行用の資格情報で行う。
`main`へのpushでだけ動かし、PRの実行では成果物を上げない。

### CIの実行の範囲の判定

残るリスクとして、PRの実行の判定は、PRの版の`scripts/ci-scope.ts`で行う。
判定を書き換える変更は、保護パスとして`pr_fix`が止める。`implement`は止めず、記録して検査を省き、PRの「確認して欲しい点」に載せる。
人が書いたPRは`ci.yml`も書き換えられるので、レビューで確かめる。

### CIのメタデータの再生成

`metadata`ジョブは、検査が失敗したときに、使い捨てのWindmillでメタデータを作り直し、結果をartifact(`metadata-patch`)に出す。
動かす条件、手順、artifactの形は[セットアップ](setup.md#ciのメタデータの検査)にある。
ここでは、権限と前提を書く。

#### 権限と条件

ジョブの権限は`contents: read`のままで、書き込みの権限を足さない。
artifactの書き込みは、ランナーの実行用の資格情報で行うため、`GITHUB_TOKEN`の権限は要らない。
ジョブにsecretsを渡さず、作り直しの結果をPRやブランチに書き込まない。

作り直しは、同じリポジトリのPRで、ブランチ名が`factory/`で始まるときだけ動かす。
PRのコードが動く作り直しを、forkと人のブランチに広げないためである。
条件の式は、ジョブの環境変数で1度だけ評価する。
各ステップの`if`はその環境変数を読み、`run`のシェルには式を展開しない。
ブランチ名がシェルに渡らないので、ブランチ名による注入は起こらない。

`startsWith`は大文字小文字を区別しないので、`Factory/`で始まるブランチも対象になる。
受け取る側は、PRの番号と`head_repository`で判定するので、この条件は境界ではない。

#### 使い捨ての環境

Windmillのサーバーとworkerは、ジョブの中のコンテナだけで動く。
サーバーは`127.0.0.1`にだけ公開し、workerはポートを公開しない。
資格情報は、公開されている既定の管理者とダミーのデータベースのパスワードだけで、本番の秘密は届かない。
そのため、PRの依存の解決が悪用されても、被害は使い捨ての環境と、読み取りだけのトークンに限られる。

ネットワークは分離しない。
作り直しで増えるのは、次の2点である。

- レジストリからの依存の取得。取得する依存は、PRのブランチのscriptが決める。
- PRで書き換えた`mise.toml`の`metadata`タスクの実行。

#### install script

bunは、依存のinstall scriptを、既定で信頼する一覧(trustedDependencies)にあるパッケージについて実行する。
bunは`NPM_CONFIG_IGNORE_SCRIPTS`を読まない。
そのため、`windmill_worker_ci`は次の2つで止める。

- bunfigの`ignoreScripts = true`を、workerの`/root/.bunfig.toml`に読み取り専用でマウントする(`infra/ci-worker-bunfig.toml`)。
- `NPM_CONFIG_IGNORE_SCRIPTS=true`を渡す。npmを使う経路があっても、install scriptを動かさないための備えである。

workerは、依存の解決のプロセスの環境を絞る。
`NPM_CONFIG_IGNORE_SCRIPTS`を`WHITELIST_ENVS`にも挙げて、`bun install`まで届かせる。

確かめた版はWindmill 1.817.0(`mise.toml`の`WM_VERSION`)で、ローカルのdocker composeで次を確かめた。

| 確かめたこと | 結果 |
| --- | --- |
| `WHITELIST_ENVS`に挙げたとき、`bun install`の環境に変数があるか | ある |
| `WHITELIST_ENVS`に挙げないとき | ない |
| 環境変数だけで、ルートと信頼した依存のinstall scriptが止まるか(workerのbunとホストのbun) | 止まらない |
| bunfigを置くと、同じ試験のscriptが止まるか(workerのコンテナ) | 止まる |
| bunfigを置いたworkerで、`wmill generate-metadata --yes`が依存を解決できるか | できる |
| 上流のworkerのイメージ(1.817.0)にHEALTHCHECKがあるか | ない(`docker image inspect`で空、コンテナの`State.Health`も無い) |
| `docker compose up --wait`は、HEALTHCHECKの無いworkerを何で待つか | コンテナが動き始めるまで(登録は待たない) |
| 認証したAPIの`/api/workers/list`に、workerが現れるか | 現れ、`custom_tags`に`dependency`を含む |

bunfigの`ignoreScripts`が止めるのは、依存のinstall scriptである。
Bunのmacroと、Pythonのsdistのビルドは、bunfigでは止まらない。
再生成の中でこれらが動くかは、確かめていない。

残るリスクとして、Bunのmacroとsdistのビルドが動いても、被害は次の理由で限られるので受け入れる。
ランナーに本番の秘密は無く、ジョブの権限は`contents: read`だけである。
さらに、受け取る側の内容の制限が、パッチの影響を絞る。

次は確かめていない。

- GitHub Actionsのランナーでの動作。
- レジストリのパッケージでのinstall scriptの停止。試験に使ったのは、ローカルの`file:`の依存である。
- Windmillがnpmを呼ぶ経路が実在するか。
- Windmillの版を上げたときの、環境の絞り方とbunfigの読み方の変化。`mise.toml`の`WM_VERSION`を上げたときは、上の表を確かめ直す。

#### artifactの扱い

artifactの内容は、PRのブランチにある`scripts/metadata-patch.ts`が書く。
PRの作者が書き換えられるので、受け取る側は内容を信用しない。
artifactに秘密は入らない。入るのは、リポジトリにあるファイルの再生成結果だけである。
保持は7日に絞り、古いパッチが長く残らないようにする。

manifestは、PRのheadのsha(`headSha`)、baseのsha(`baseSha`)、作り直したmerge木のcommit(`mergeSha`)を持つ。
再生成はmerge木で行うので、パッチを適用してよいのは、`headSha`と`baseSha`が今も変わっていないときだけである。

#### 受け取る側が必ず確かめること

artifactの中身は、攻撃者が完全に決められるものとして扱う。安全は、内容の制限だけで成り立たせる。
出どころの確認は、無関係な第三者のartifactを避けるための補助にとどまる。
同じ実行の別のジョブ(`check`など)で動くPRのコードは、ランナーのトークンを使って、同名のartifactを上げ直せる。
ブランチやworkflowのパスの照合では、これを防げない。
publicなリポジトリでは、forkのPRが`ci.yml`を書き換えて、同名のartifactを上げることもできる。
そのため、受け取る側はartifactを信用しない前提で扱い、次のすべてを守る。
確かめるコードは`f/factory/lib/`の`metadata_patch_*.ts`にまとめ、判定を1か所に置く。
各部品の責務は[メタデータのパッチの受け取り](internals/ci-fix.md#メタデータのパッチの受け取り)にある。

| 取り決め | 実装 |
| --- | --- |
| artifactの一覧 | `github.ts`の`listWorkflowRunArtifacts` |
| artifactの取得 | `metadata_patch_download.ts`の`downloadArtifactZip` |
| zipの内容の制限 | `metadata_patch_zip.ts`の`readMetadataPatchZip` |
| 出どころ、再検証、適用先、新規script | `metadata_patch_verify.ts`の`verifyMetadataPatch` |
| パスの許可リスト、manifest | `metadata_patch_manifest.ts`の`isAllowedMetadataPath`、`parseManifest` |
| 依存の変化の検出 | `metadata_patch_imports.ts`の`traceBareImports` |
| `.script.yaml`と`wmill-lock.yaml`の制限 | `metadata_patch_yaml.ts`の`checkScriptYaml`、`parseWmillLock` |

##### 出どころ

artifactを取る実行は、次をすべて満たすものに限る。

- workflowのパスが`.github/workflows/ci.yml`である。
- イベントが`pull_request`である。
- `head_repository.full_name`が、このリポジトリである。
- 実行の`pull_requests`に、対象のPRの番号がある。
- 実行の`head_sha`が、PRの今のheadと一致する。
- 実行の結論が`failure`で、原因が`metadata`ジョブの失敗である。
- PRの差分(`base...head`)が、`f/**`、`migrations/**`、`docs/**`、`tests/**`のパスと、ルートの`wmill-lock.yaml`だけである。
- PRの差分を、全件読めている。APIの件数の上限で切れた差分は、許可リストの外を隠しうるので断る。

差分の条件は、これら以外に触れていれば、パッチを適用しない。
該当するのは、次のようなパスである。

- 設定: `bunfig.toml`、`mise*.toml`、`.mise*`、`.config/mise*`、`.tool-versions`、`wmill.yaml`、`package.json`、`tsconfig.json`
- CIと実行の定義: `.github/`、`infra/`、`scripts/`

収集のステップが読む設定は多く、拒否リストでは漏れるため、許可リストにする。
プロンプトを注入されたimplementフローは、これらを書き換えうる。
書き換えられると、artifactの中身も実行の条件も、PRが決められる。

`metadata`ジョブは、パッチを出した後も失敗で終わる。
そのため、成功した実行だけを探すと、パッチが見つからない。
同じPRに複数の実行があるときは、`metadata`ジョブが`failure`の実行のうち、最新のものを選ぶ。

artifactは、その実行のIDに紐づくものだけを取る。
ブランチ名やartifact名だけで実行を探さない。

適用する側は、取ったartifactのIDとdigestを、`metadata`ジョブが出した値と照合する。
照合できないときは、パッチを適用しない。
別のジョブが上げ直したartifactは、IDとdigestが違うため、見分けられる。
`ci.yml`がIDとdigestを出す処理は、まだ無い。
追加は保護パスの変更として、別に行う。それまでは、パッチを適用しない。

出どころの検査(`checkProvenance`)は、実行の事実とPRの差分だけを見る。
適用する側は、artifactの一覧の取得とダウンロードの前に呼び、出どころで断れるものは、ダウンロードと展開をしない。

##### 適用先と方式

パッチは、merge木に対する再生成の結果である。
適用してよいのは、PRのheadが、baseブランチの今の先端を祖先に含むとき(`git merge-base --is-ancestor`)だけである。
含まないときは、パッチを捨てる。
Factoryが`main`を取り込み、CIが再実行されるのを待つ。
依存の比較の相手が先に進んでいるのに、人の手に回さないためである。

含むときは、merge木とheadの`f/`と`wmill-lock.yaml`が一致する。
そのため、パッチはファイル単位で置き換えてよい。

`baseSha`は、merge commitの第1親、つまりbaseの先端である。
イベントのペイロードの`pull_request.base.sha`ではなく、merge木を作った時点の値を、CIがmerge commitから読んで書く。
`baseSha`は、merge-baseではない。

##### 再検証

PRの版の`scripts/metadata-patch.ts`が出した結果は、信用しない。

- `main`の版の`isAllowedMetadataPath`と`parseManifest`で、manifestの全項目を再検査する。
- `headSha`と`sha256`を照合する。
- `baseSha`が、PRのbaseの今のshaの祖先であること(`--is-ancestor`)を確かめる。
- PRのheadが、baseの今の先端を祖先に含むことを確かめる。`baseSha`がheadの祖先であることは、この2つから従う。
- `mergeSha`のcommitをAPIで取得し、第1親が`baseSha`、第2親が`headSha`に一致することを確かめる。取得できないときは拒否する。

`baseSha`の照合を、一致ではなく祖先にする。
一致を求めると、`main`が進むたびに適用が先送りされるためである。
headがbaseの今の先端を含めば、merge木とheadの木は同じで、パッチはheadに対して正しいままである。

##### zipの内容の制限

zipは、展開の前に宣言された大きさとパスを検査し、展開の間は宣言された大きさで打ち切る。
次を拒否する。

- 展開後の合計、1ファイル、エントリ数が上限を超えるもの(zip bomb)
- 宣言された大きさと、展開した実際の長さが違うもの
- symlinkと特殊ファイル
- `..`、絶対パス、バックスラッシュ、制御文字を含むパス(zip slip)
- 同じ名前と、大文字小文字だけが違う名前(区間は小文字にそろえて照合する)
- stored、deflate以外の圧縮方式、暗号化、zip64
- manifestの`size`と実際の長さが違うもの、`files/`にあってmanifestに無いファイル、削除の項目に対応する`files/`のファイル

取得の制限(トークンの渡し先、取得先、受け取るバイト数の上限)は、[パッチの取得](internals/ci-fix.md#パッチの取得)にある。

##### パスと削除の制限

- 保護パス(`f/factory/lib/protected_paths.ts`の`matchesForbiddenPath`)に当たるパスを拒否する。
- 削除を拒否する。
- `*.script.yaml`は、`schema`以外のキー(`tag`、`timeout`、`lock`の参照先など)が、headの今の版と違えば拒否する。summaryなどを正当に変えたPRを、拒否しないためである。
- `schema`は、許可リストの範囲に収める。
  `\`、`!`、`&`、`*`、`%`、タブ、`$`を含むものと、`x-windmill`を含むキーを拒否する。
  `$`で始まる値(`$var:`、`$res:`)は実行者の権限で解決され、`x-windmill`のキーはフォームの挙動を変えるためである。
  エスケープやタグで綴りを変えられると、復号しない検査では見分けられないので、それらの文字ごと拒む。
  例外は、wmillが先頭に書く`$schema: https://json-schema.org/draft/2020-12/schema`の1行だけである。
- `schema`のスキーマの語彙のキーは、許可リスト(`ALLOWED_SCHEMA_KEYWORDS`)に限る。
  リストは、リポジトリのすべての`.script.yaml`の`schema`で使われているキーの和集合である。
  `showExpr`や`customErrorMessage`のように、式の評価やUIの挙動に関わるキーは、使われていないので拒否する。
  `properties`の直下のキー(引数の名前)と、`default`や`enum`などの中身は、語彙として読まない。
  `properties`と`items`の中身が、同じ行の`{...}`で書かれているものは、キーを隠せるので拒否する。

##### lockの制限

自動で適用するのは、依存が変わらない再生成だけである。
lockの意味(版の範囲、パッケージの入れ子、取得元、integrity、公開からの日数)を、受け取る側で解釈しない。
解釈を再実装すると、見落としが残りやすいためである。
依存が変わるPRは、受け取る側が断り、人が手元で`mise run metadata`を実行して直す。
依存が変わる再生成は、自動化の対象外で、別の仕組みで扱う。

- `*.script.lock`を変えてよいのは、PRの差分で`f/**/*.ts`が変わったscriptと、それをimportするscriptに限る。
  importするscriptの範囲は、PRのheadの木のコードで、局所importの推移閉包を計算して決める。
- 対応する`.ts`が保護パスに当たるscriptのlockは、lock自身が保護パスでなくても拒否する(例: `steps/dependabot_*.ts`)。
- 閉包に入るすべてのscriptについて、局所importをたどって集めた裸のimport指定子(版つき)の集合を、baseの先端の木とheadの木で比べる。
  1つでも違えば、manifestの内容と無関係に、パッチ全体を拒否する。
  依存の変更は、パッチの`.script.lock`を見なくても、コードのimportに現れるためである。
- 局所importは、Windmillの解決に合わせて読む。
  追えないimportは拒否する。import属性は、キーワードとの間にコメントを挟んだ形も含む。
  一覧は[importの読み取り](internals/ci-fix.md#importの読み取り)にある。
  閉包を求める解決と、依存の集合をたどる解決は、同じ関数を使う。食い違うと、閉包の外のscriptに、依存を隠せるためである。
- 既存のscript(headの木にlockがある)のlockは、headの木のlockとバイト列まで同一であること。適用しても変わらない。
  加えて、閉包の既存のscriptのlockは、baseの先端の木のlockとも同一であること。
  PRの作者がlockを手で変えた形と、古いlockに新しいhashが残る形を、断るためである。
  比べる相手はheadの木とbaseの先端の木で、manifestの`baseSha`は出どころの照合にだけ使い、内容の比較には使わない。過去のcommitを選ばれて、比較の相手を変えられないためである。
- 新しいscriptは、同じPRで`.ts`を追加したものに限る。
  裸のimportの集合が空であること。baseの先端が同じ内容を持つときも、空であることを求める。
  lockは、baseの先端の木にある依存の無いlib(`f/factory/lib/metadata_patch_manifest.script.lock`)のlockと同一であること。
  参照のlockは、前半の`dependencies`が空で、後半が`<empty>`であることを、検査の中で確かめる。
  lockと`.script.yaml`の両方が、パッチが運ぶか、headの木にすでにあること。lockの無い新しいscriptは拒否する。
- `*.script.yaml`を変えてよいのは、`.ts`自身が変わったscriptに限る。入力のスキーマは、そのscript自身の`main`の引数からしか決まらないためである。
- 空のlockを固定の値として埋め込まない。lockの書式がwmillの版で変わっても、リポジトリの実物と比べるためである。
- headの木かbaseの木のファイルを読めないときは拒否する。
- headの木の`f/`の下の`.ts`が5000件を超えるときは拒否する。閉包の計算を有界にするためである。

##### ロックのハッシュの制限

`wmill-lock.yaml`は、完全なYAMLとして解析しない。wmillが書く決まった形に1行ずつ合わせて読み、外れるものは断る。

- 変わったキーが、許可したscriptのものに限られることを確かめる。
  許可するのは、閉包に入るscriptである。hashはimportする先のコードにも依存するためである。
  この範囲では、hashを任意の値にできる。ただし、lockの内容は変えられないので、依存の解決には影響しない。
- 値が64桁の小文字の16進数であることを確かめる。
- キーの削除と、未知の`version`を拒否する。

##### 新規scriptの制限

- `.script.yaml`の追加を許すのは、同じPRで`.ts`を追加したscriptだけである。
- キーは、許可リスト(`summary`、`description`、`lock`、`kind`、`schema`)に限る。
- `lock`は、フルパスの`'!inline f/<dir>/<name>.script.lock'`に固定する。
- `tag`、`timeout`、`concurrency`などのキーは拒否する。
- 対応する`.ts`が無い`.script.lock`と`.script.yaml`の追加を拒否する。
- lockの条件は、[lockの制限](#lockの制限)にある。

##### 層の関係

内容の制限と再検証は、攻撃者が決めたartifactでも被害を限るための層で、安全はこの層だけで成り立たせる。
出どころの確認は、無関係な第三者のartifactを避けるための補助である。
出どころが破られうる前提なので、出どころの確認を理由に、内容の制限を緩めない。

##### 受け入れる残りのリスク

`windmill_worker_ci`の上流イメージは、タグ(`WM_VERSION`)で固定していて、digestでは固定していない。
既存のserverと同じ固定の仕方である。
ランナーに秘密が無く、受け取る側が依存の変わるlockを断るため、このリスクは受け入れる。

##### 受け取る側の実装で決めること

artifactの適用で残る論点は、[内部仕様](internals/ci-fix.md#artifactの適用で残る論点)にまとめる。
この文書は、それらを前提にせず、内容の制限を定める。

#### hashの再計算

artifactを経由せず、Factory自身が`wmill-lock.yaml`のhashを計算し直す部品がある。
構成は[メタデータのhashの再計算](internals/ci-fix.md#メタデータのhashの再計算)にある。
ここでは、未信頼のPRのheadを扱う前提を書く。

- PRのheadは、読むだけである。
  scriptを実行せず、wmill CLIも動かさない。
  PRの作者が決めるコードを、Factoryのworkerで動かさないためである。
- importを読むときも、コードを実行しない。
  Bunの`transformSync`は、マクロを指定したimport属性のimportを、読む側のプロセスで実行する。
  空白、改行、コメントを挟んだ形でも実行されることを、Bun 1.4.0(worker)と1.4.2で確かめた。
  挟んだ文字の一覧は、`tests/lib/metadata_patch_imports_runtime.test.ts`にある。
  そのため、`transformSync`は使わず、実行しない`scanImports`だけで読む。
  `scanImports`は、同じ入力でマクロを実行しないことを、両方の版で確かめた。
  加えて、import属性の検出は、JavaScriptの空白と行区切りをすべて数える。
- 読み取りのポートは、gitのオブジェクトから実装し、作業ツリーのファイルは開かない。
  作業ツリーには、検査コマンドやClaudeが書いた、gitの管理外の内容が入りうるためである。
  読んだ内容と木の`oid`を照合するので、別のrefや作業ツリーを読んだ実装は断られる。
  ポートの値の検査は、[事前検査](internals/ci-fix.md#事前検査)にある。
- `f/`、`wmill.yaml`、`wmill-lock.yaml`、`dependencies/`にsymlinkとsubmoduleがあれば、人の手に回す。
  読むと、木の外のファイルを指しうるためである。
- 計算するのはhashだけで、`.script.lock`と`schema`は書かない。
  lockを書くには依存の解決が要り、解決はPRのコードが決めたimportに従って、外部のレジストリへ取りに行くためである。
- 自動で直すのは、依存が変わらないPRに限る。
  判定は[事前検査](internals/ci-fix.md#事前検査)にあり、判断できないときは通さずに人の手に回す。
  依存の比較は、実行時に残るimportで行う。Windmillのlockが、型だけのimportと使われないimportの先の依存を含めないためである。
- baseの先端のメタデータが最新でないときは、人の手に回す。
  メタデータの生成を飛ばしたcommitが`main`に入りうるので、PRと関係の無い古い`schema`やlockを、最新のように書き直さないためである。
  また、hashが変わるのは、PRが`.ts`を変えたscriptと、baseの先端の値に戻すキーだけに限る。
- 置き換えるのは、既存のキーのhashだけである。
  キーの追加と削除を許さないので、lockの対象を増やせない。
- 1ファイルの大きさ、`f/`のファイル数、1scriptがたどるファイル数、訪問と解決の合計、読むバイト数の合計、型宣言の字句の数に上限を置く。
  PRの作者が大きな入力を作って、workerの時間とメモリを使わせるのを防ぐためである。
  定数は[事前検査](internals/ci-fix.md#事前検査)にあり、上限が覆わない範囲は[既知の限界](internals/ci-fix.md#既知の限界)にある。
  閉包をたどる間は、読んだ内容を保持せず、必要なら読み直す。
  型宣言の仕事量は、範囲を探すために進めた字句と、宣言のダイジェストのために読んだ字句を、あわせて数える。
  宣言は文字列として持たず、固定の長さのダイジェストだけを持つ。
  範囲が重なる宣言で、同じ大きな本体を何度も保持しないためである。
- Windmillの注釈、`preprocessor`、flowの定義、インラインscriptを持つflowは、人の手に回す。
  これらは、依存の解決、workerの種類、`.script.yaml`の項目を変えうるのに、hashだけを直しても追いつけないためである。
- ポートが返す値と上限の値は、入口で検査し、正しくないときは断る。
  上限の値は正の整数だけを通す。NaNで上限が外れるのを防ぐためである。

`metadata`ジョブだけが落ちたCI回の再計算の経路は、次で守る。
流れは[metadataジョブの失敗を直す経路](internals/ci-fix.md#metadataジョブの失敗を直す経路)にある。

- Claudeを起動しない。失敗のログは読まず、通知にも載せない。
  外部入力で動くのは、事前検査の字句の読み取りだけである。
- 書き込む先は、worktreeの根の`wmill-lock.yaml`だけで、パスはコードが決める。
  `O_NOFOLLOW`と`O_NONBLOCK`で開き、FIFOで止まらない。通常のファイルでないとき、ほかにhard linkがあるときは書かない。無いファイルは作らない。
- 検証と完了のステップは、修正のステップの出力を信用しない。
  worktreeの変更が、根の`wmill-lock.yaml`1件の`modified`(モード`100644`)で、本文がPRのheadの木からの再計算とバイト列まで同じときに限り、許す。
  許可リスト方式の検査(`checkCiFixChanges`)は変えず、例外は呼び出し側の`inspectCiFixChanges`だけに置く。
  次のものは、保護パスの一覧に入れない。日常的に直すファイルで、守るとその正当な変更をすべて止めるためである。
  - 例外を開くコールバックの本体(`pr_fix_verify.ts`、`pr_fix_finish.ts`)。
  - `ci_fix_round.ts`の`isLockOnlyChange`、`isRehashCandidate`、`inspectCiFixChanges`の`rehashCheck`の分岐、`readCiFailure`。
  - `ci_fix_classify.ts`の`classifyCiFailure`。この結果が、`metadata`だけが落ちた回(`metadata_only`)を決め、起動の判断で予算とマーカーの確認を免除する。
  - `workspace.ts`のgitの固定設定(`FIXED_GIT_CONFIG`、`GIT_NO_REPLACE_OBJECTS`、`GIT_ALLOW_PROTOCOL`)。再計算が読むgitの動き方を決める。

  これらを書き換えて条件を緩める変更は、マージ前の人のレビューで止める。CI回のClaudeには、CI回の拒否が別に止める。
  本文が再計算と違うときと、確認できないときは、保護パスの違反として拒否する。
  再試行しても直らない理由で再計算できないときは、再計算の回に限り、固定の理由を返し、保護パスの違反にはしない。
  回の種類は、CIの実行から読み直して決める。Claudeの回では、保護パスの違反として拒否する。
  一時的な失敗は、拒否せず、例外にして再試行する。
- 比べるのは、文字列ではなくバイト列である。
  文字列に復号すると、先頭のBOMが落ち、不正なUTF-8が置き換わって、違う内容が同じに見えるためである。
- baseの先端のcommitは、shaを指定して取り込み、追跡refを動かさない。
  リポジトリのロックの外から追跡refを更新して、`commitAndPush`と衝突することを避けるためである。
- 完了のステップの既存の関門は、すべて通る。
  秘密値の検査、検査したツリーとの照合、保護パスの検査、PRの状態とheadの確認、オーナーの数値IDの照合である。
- commitの親は、`head_sha`に固定する。pushは強制しない。
  ブランチの先端が動いていればpushは拒否され、動いた回は、新しい失敗として判定し直される。
- baseの先端は、PRのAPIの`base.sha`ではなく、baseブランチの今の先端をAPIで読んで使う。
  照合の中と、pushの直前に読み直し、動いていれば新しい先端で確かめ直す。
- 人の手に回す理由は、次の固定の語彙だけである。
  事前検査の種別、`lock_up_to_date`、`lock_not_writable`である。
  pushの直前に、baseの先端が動いて本文が合わなくなった場合(`CI_ROUND_REHASH_STALE_REASON`)も含む。
  一時的な失敗(`port_error`、`ancestry_unknown`)は、人の手に回さず、例外にして再試行する。
  再試行で直らない失敗(想定外の例外の`internal_error`、自己検査の`scan_unavailable`、木の一覧が読めない`tree_unreadable`)は、人の手に回す。
  PRの作者が決めるパスは、通知にも作業項目の理由にも載せない。
  補足は、`scan_unavailable`のworkerのBunの版(`bun <版>`)と、`internal_error`の例外の種類(標準のエラーの名前だけ)に限る。
- 検査コマンドは、この形のとき実行しない。hashだけを書き換えた変更に、対象リポジトリのコードを実行する意味が無いためである。

事前検査は、悪意のあるPRに対する境界ではない。
hashは`.script.lock`の中身を含まない。
`wmill-lock.yaml`は、implementフローの保護パスではない。
そのため、悪意のあるPRは、Factoryを通さなくても、古いメタデータと合うhashを自分で書ける。
事前検査が防ぐのは、悪意のないPRで、古い`schema`やlockが最新のように書き直されることである。
字句の近似の読み違いで、検査を敵対的に避けられる余地は、この前提で受け入れる。
悪意のあるPRは、人のレビューで止める。

算法は、`mise.toml`で固定したwmill CLIの版に合わせてある。
版を上げると、算法を固定するテストが落ちて、確かめ直しを求める。
確かめ直すまでは、版を上げた変更を取り込めない。

### 開発セッションのsubagent

`.claude/agents/`のsubagentは、開発のセッションで使うものである。
headless Claudeのフローは、プロジェクト設定を読み込まないので、これらを使わない。
レビュー役のsubagentは`Bash`を持つので、読み取り専用であることは指示で守らせる。
pushは親のセッションだけが、運用者の確認を経て行う。

worktreeを作るフックと、既存のブランチを使う経路(worktreeの再利用、既存ブランチの取り付け)は、ローカルのブランチを自分のものとして信頼する前提である。
そのブランチの`bunfig.toml`、`mise.toml`、lefthookのフックが動くのは、手でcheckoutしたときと同じ信頼によるためである。

### 状態の理由の区切り

状態の理由(`status_reason`や人の対応待ちの理由)は、`"; "`でつないだ項目の一覧である。
Consoleの表示と次の操作は、この区切りで分けた項目ごとに選ぶ。
Claudeや検査コマンドが書ける詳細と、pr_fixのClaudeが理由として書く`blocked_reason`は、区切りを`", "`に置き換えてから理由に入れる。
区切りを差し込んで、別の理由の訳文を表示させたり、既知の理由を足して次の操作を選ばせたりできないようにするためである。
置き換える詳細の範囲は[通知とrate limit](internals/notifications.md)にある。

残るリスクとして、Claudeは`blocked_reason`の全体を既知の理由と同じ文にできる。
そのときは、その理由の訳文と次の操作が表示される。

### 自己更新の通知の状態

`poll_issues`は、版の食い違いを最初に見た時刻をWindmillのstateに保存し、猶予を超えたときに`deployed_sha_mismatch`を通知する。
通知は、今の`deployed_sha`への反映が成功した記録(`factory.deployments`)のうち最も新しいものより前に作られたものだけが、自動で解決される。
残るリスクは次のとおりである。

- stateを書けるWindmillの利用者は、`deployed_sha_mismatch`の通知を遅らせられる。`deployed_sha`を書ける者と同じ範囲である。
- stateや`deployed_sha`を書き換えても、通知より新しい反映の成功の記録が無い限り、通知は解決されない。
- `deployed_sha`を今のHEADに書き換えると、版が一致するので、自己更新もそれを反映済みとみなす。これは通知の仕組みより前からある性質である。
- `factory.deployments`に書けるDBの利用者は、この判定も動かせる。

### ホストの反映の印

`host_action_required`は、自己更新が印を読んで自動で解決する。
印は、ホストの`mise run up`が共有ボリュームの`/var/lib/factory/host_applied_sha`に書く。
読む側は、印を信用しすぎないよう次のように読む。

- 通常のファイルで、symlinkでなく、128バイト以下のときだけ読む。`O_NOFOLLOW`と`O_NONBLOCK`で開き、先頭の64バイトだけを読む。
- 40桁の版として読めて、self cloneにあるコミットのときだけ使う。
- 条件に合わなければ、通知を解決しない。

残るリスクは次のとおりである。

- defaultのworkerのジョブは、印を偽造できる。偽の印で、`host_action_required`を黙らせられる。影響は、ホストでの反映の遅れに気づけなくなるところまでである。突くには、defaultのworkerでのコード実行が要る。
- 印を`approve`の`--applied`の値に使うと、偽の印が承認の始点になる。実際の適用済みと違う始点で承認すると、人が見ていない変更を、記録が隠しうる。そのため、`--applied`の値は印から取らず、ホストのcheckoutの履歴で確かめる([変更を承認する](operations.md#変更を承認する))。印は照合にだけ使う。
- ホストの書き込み(`docker compose exec`)は、ジョブと同じ権限で動く。
  同じディレクトリに、`mktemp`のランダムな名前の一時ファイルを排他的に作って書き、`mv -fT`で置き換える。
  印のパスがsymlinkでも、その先は上書きされず、置き換わるのはsymlink自体である。
  印のパスがディレクトリのときは、中へ移さず失敗し、一時ファイルを消す。その場合、記録は警告で終わる。
  一時ファイルの名前は予測できないので、ジョブがFIFOなどを先回りして置くことはできない。
  それでも止まらないよう、書き込みは`timeout 10`で包む。
  ホストのスクリプトが得る権限はジョブと同じで、権限は広がらない。

### Factory自身のリポジトリの照合

`factory_repo_id`を設定すると、Factory自身のcloneを用意する処理は、取得の前にGitHubの現在のリポジトリIDと照合する。
オーナーが改名して別の人がその名前を取得しても、その人のリポジトリを反映したり、Claudeに読ませたりしないためである。
設定と処理ごとの振る舞いは[運用](operations.md)の「Factory自身のリポジトリの数値IDを固定する」にある。

残るリスクは次のとおりである。

- 照合の応答を読んでからfetchの接続までの短い間は、リポジトリが入れ替わる余地として残る。
  照合はcloneのロックの中で行うので、この間にロックの待ちは入らない。
- `factory_repo_id`が未設定の間は、名前の再取得から守られない。
  未設定のときは、照合せず、通知も出さない。
- `isRepoAllowed`は`factory_repo`を名前で許すので、自己改善の起票と候補への採用は名前のままである。
- Consoleの配信物を取り込む処理と、ホストの`git pull`は、`factory_repo_id`を照合しない。
- 監査のスナップショットのworktreeが、self cloneに既にあるshaを取るfetchは、照合しない。

### オーナーの数値IDの照合

作業項目は検索の時点の名前を保存する。
承認を待つ間に名前が入れ替わると、保存した名前のURLは別の人のリポジトリを指す。
そのリポジトリをcloneして検査コマンドを実行すると、他人のコードを秘密値を持つworkerで動かすことになる。
そこで、検索の入口に加えて、次の処理が保存済みの名前を照合する。

- 作業項目を進める準備のステップ。リポジトリの取得の前に照合する。
  dependabotの準備(`dependabot_prepare`)は、事実を再収集した後、cloneの前に1回照合する。
  取得の入口の照合から収集を挟むので、その間に名前が入れ替わっても、相手のリポジトリをcloneして依存をインストールしないためである。
- フォームからのIssueの作成。投稿の前に照合する。
- Issue化の提案の処理。承認は判断の記録の前に、却下は返信の前に照合する。
- 長い実行を挟んだ後の書き込みのうち、次の5つの処理。照合は、書き込みの直前に1回行う。
  実装の終了処理(`implement_finish`)は、pushとリモートブランチの削除の前に照合する。
  PR修正の終了処理(`pr_fix_finish`)は、pushの前に照合する。
  PRレビューの投稿(`pr_review_post`)は、レビューの投稿の前に照合する。
  dependabotの終了処理(`dependabot_finish`)は、PRを読み直した後、マージ、所見の投稿、ラベルの付与の前に照合する。
  準備の入口の照合から、Claudeの実行と検査を挟むので、その間に名前が入れ替わると、
  ローカルにしか無いオブジェクトやレビューの文面が相手に渡るためである。
  dependabotでは、マージ、所見の投稿、ラベルの付与が相手のPRに及ぶためである。
  draw.ioのビューアを上げる`drawio_viewer_bump`は、`factory_repo_id`をブランチの作成の前に照合する。

関門は、呼び出しの順に頼らず、それ自身が閉じる。
`owners`に名前が無いオーナーのリポジトリは、`factory_repo`と一致するときだけ通し、それ以外は止める。
リポジトリが`factory_repo`と一致し、`factory_repo_id`があるときは、関門が先にそのIDも照合する。
cloneを開かない処理は、`openFactoryClone`の照合を通らないためである。
`id`を持つ要素は、現在のIDと合うときだけ通す。
`id`を持たない要素は、名前だけで動く。
`id`を持つ要素の照合は、リポジトリのオーナーのIDを1回取得して行う。
リポジトリが`factory_repo`と一致し、`factory_repo_id`があるときは、関門の中でリポジトリのIDも取得する。
cloneを開くステップでは、`openFactoryClone`の照合も重なるので、取得が増える。
設定と処理ごとの振る舞いは[運用](operations.md)の「オーナーの数値IDを固定する」にある。

残るリスクは次のとおりである。

- `id`の無いオーナーは、名前だけで動く。
- dependabotを除く準備のステップ、フォームからのIssueの作成、Issue化の提案の承認は、処理の始めに照合する。
  Issue化の提案の却下だけは、判断を記録した後に照合する。
  照合の後に名前が入れ替わっても、その実行は検知しない。
- `allowed_labeler_ids`にIDを入れないアカウントは、名前だけで判定する。
  `allowed_labeler_logins`に古い名前が残ると、その名前を取得した人が、許可された付与者とPRの作成者になりうる。
  IDを入れたアカウントは、IDも一致するときだけ許可する。
- 保存済みの名前でGitHubを読み書きする処理は、ほかにもある。
  Issueの状態の確認と整理、承認後のIssueへのコメント、PRへの返信は、名前のままである。
  取り消された作業項目を再開する前の状態の確認と、要件定義を作り直す再実行の前の取り込みも、名前のままである。
  これらはcloneも検査コマンドの実行もしない。投稿の内容は、名前を取得した人の目に触れうる。
- 監視が無効の間の`watch_pr_ci`の回復は、オーナーの照合をせずに、名前でPRの状態とheadを読む。
  書き込みは、FactoryのDBと、Discordへの固定文に限る。
  DBへの書き込みは、行を戻すこと、行を`superseded`にすること、noticeを足すこと、noticeを解決することである。
  保留した失敗の通知として、noticeの登録と、通知した理由コードの記録も行う。
  通知の本文は、固定文と語彙のコードだけで作り、GitHubから読んだ文字列を入れない。
  GitHubへの書き込みも、Claudeへの入力も、cloneや検査コマンドの実行もしない。
  監視を有効に戻せば、照合が働く。
- 書き込みの直前の照合と書き込みの間は、入れ替わる余地として残る。
  実装のPR作成とラベル付与、PR修正の返信は、直前の照合の後にpushと続けて行うので、個別には照合しない。
  dependabotの終了処理も、所見の投稿の後のラベルの付与と、baseの読み直しの後のマージを、個別には照合しない。
- dependabotの準備は、照合からcloneまでの短い間が、入れ替わる余地として残る。
- `drawio_viewer_bump`は、`factory_repo_id`があれば、書き込みの直前の照合で止まる。
  残る余地は、照合からブランチの作成までの間だけである。
  `factory_repo_id`が未設定のときは照合せず、名前だけでブランチとPRを作る。
  送る内容は公開物である。

## シークレットの扱い

### Windmillでの保持

Windmillで実行する間、秘密値はWindmillのsecret変数に置く。

- `f/factory/claude_oauth_token`
- `f/factory/github_token`
- `f/factory/wmill_token`
- `f/factory/discord_webhook_url`
- `f/factory/github_read_tokens`

scriptは`wmill.getVariable()`で値を取得し、子プロセスの環境変数(`GH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`など)としてだけ渡す。URLのクエリとパス、ログ、Data Tableの列、Discordの通知本文には出さない。
親プロセスが`fetch`で使う秘密値は、次の4か所である。

- Console用のworkerで動く`retry_work_item`は、`gh`を起動できないので、`github_token`を`fetch`の`Authorization`ヘッダに載せる。使うのは、取り消された作業項目を再開するときの対象の状態の確認と、Issueの要件定義を作り直す再実行のときの取り込み内容の更新(現在のIssueの題名と本文の取得)である。宛先は`https://api.github.com`に固定し、リダイレクトは辿らない。境界は[Console用workerの境界](#console用workerの境界)に書く。
- Console用のworkerで動く`approval_decide`は、要件定義の承認の前に現在のIssueを読むため、同じ形で`github_token`を使う。10秒の締め切りを付け、エラーの文とログにトークンとIssueの内容を含めない。
- Discordへの送信(`lib/discord.ts`の`notify`)は、`discord_webhook_url`を`fetch`の宛先のURLにする。URLそのものが秘密なので、エラーメッセージとログには含めない。
- 収集の`collect_github`(`lib/gh_graphql.ts`)は、`github_read_tokens`の所有者ごとのトークンを`fetch`の`Authorization`ヘッダに載せる。
  宛先は`https://api.github.com/graphql`に固定し、リダイレクトは辿らず、1要求に10秒の締め切りを付ける。
  エラーの文とログに、トークンと応答の本文を含めない。
  GraphQLのエラーの文は、分類にだけ使って残さない。

エラーメッセージと失敗の記録(`job_failures`)には、マスク処理を通してから値を入れる。マスクの関数はテストで検証する。

### ホストでの保持

ホストで使う次の秘密値は、gitignore済みの`mise.local.toml`に置く。テンプレートは`mise.local.toml.example`である。秘密でない設定は`mise.toml`の`[env]`にコミットする。

- `DB_PASSWORD`
- `WM_ADMIN_EMAIL`
- `WM_ADMIN_PASSWORD`
- `GITHUB_TOKEN`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `CONSOLE_GITHUB_TOKEN`
- `GITHUB_READ_TOKEN_<OWNER>`(所有者ごとに1つ。`<OWNER>`は所有者のloginを大文字にして、`-`を`_`にした名前)

値は人が投入する。投入のコマンドは[セットアップ](setup.md)にある。Claudeが更新するのは、値の無いテンプレートである`mise.local.toml.example`までにする。投入が必要になったら、Claudeは実行するコマンドを示し、待たずにほかの作業を続ける。

`infra/.env`は置かない。存在するとDocker Composeが自動で読み込むためである。composeファイルは`mise run`が解決した環境変数を`${VAR:?run via mise}`の形で参照する。`mise run`を通さずに`docker compose`を実行すると、変数が無いので起動前に止まる。

### コマンド引数の例外

`scripts/bootstrap.sh`は、秘密値をコマンドの引数に載せない。例外は`wmill workspace add --token <t>`の1か所で、CLIにほかの受け口が無いためである。共有のマシンで実行すると、`ps`などでこの引数が見える。

### Windmill APIトークンの期限

workerが持つ`f/factory/wmill_token`は、ワークスペース`factory`に限定した有効期限180日のAPIトークンである。`mise run bootstrap`を実行するたびに新しいトークンを発行し、古いトークンを失効させる。これがトークンのローテーションの手段になる。期限が切れると、`self_update`のスケジュールが失敗する。

## 資格情報の取得

`DB_PASSWORD`、`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`は自分で決める。次の5つは外部のサービスから取得する。取得した値の投入は[セットアップ](setup.md)の手順で行う。

### GitHubのPAT

`GITHUB_TOKEN`には、GitHubのfine-grained personal access tokenを使う。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押す。表示された`github_pat_...`は一度しか表示されないので、その場で`GITHUB_TOKEN`として投入する。
5. orgのリポジトリが対象なら、org側でトークンを承認する。orgの設定によっては承認が要る。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-factory`。複数のインスタンスで運用するときは`atelier-works-factory-<instance_name>` |
| Description | `Software Factory worker (Issues/PR automation)` |
| Resource owner | 対象リポジトリの所有者(個人のアカウントかorg) |
| Expiration | Customで1年後(最長) |
| Repository access | Only select repositoriesを選び、拾わせるリポジトリ(sandboxのリポジトリを含む)を選ぶ |
| Repository permissions: Issues | Read and write |
| Repository permissions: Contents | Read and write |
| Repository permissions: Actions | Read-only |
| Repository permissions: Metadata | Read-only(IssuesかContentsを選ぶと自動で付く) |
| Repository permissions: Pull requests | Read and write |
| Repository permissions: Workflows | No access |
| Account permissions | すべてNo access |

ContentsをRead and writeにするのは、PR修正と実装のフローがブランチにpushするためである。WorkflowsはNo accessのままにする。`.github/workflows/`を含むpushをGitHubに拒否させるためである。実装フローは`.github/`の変更を止めずに記録するので、この拒否が実質のガードになる。
ただし、この拒否が及ぶのは`.github/workflows/`の下だけである。`.github/actions/`のcomposite actionには及ばないので、PR修正はパスで止め、実装フローは記録する。組み立てなど配布物に関わる手順は、composite actionに分けない。

ActionsをRead-onlyにするのは、次の3つを読むためである。

- `watch_main_ci`が読む、対象リポジトリの既定のブランチのActionsの実行
- `watch_pr_ci`が読む、FactoryのPRのheadのActionsの実行
- CI回の部品(`getWorkflowJobLog`)が読む、失敗したジョブのログ本文。
  詳細は[CIの失敗を直す部品の仕様](internals/ci-fix.md)にある。

書き込みの権限は付けない。実行の再実行や取り消しをさせないためである。
権限が足りないリポジトリは、`watch_main_ci`が要対応の通知`main_ci_check_denied`で、`watch_pr_ci`が要対応の通知`pr_ci_check_denied`で知らせる。権限が足りない間は、そのリポジトリのCIの失敗に気づけない。
`watch_pr_ci`は、実行の一覧とジョブの一覧とPRの状態に加えて、PRのコミット本文と、Factoryのリポジトリのfactory-fixスキルのファイルを読む。ワークフローのログは取得しない。
コミット本文は、トレーラーの照合だけに使い、ログに出さない。スキルのファイルは、マーカーの有無だけを見る。
ログを読んでClaudeに渡すのは、`watch_pr_ci`が起動した`pr_fix`のCI回だけである。
`watch_pr_ci`が起動するのは、設定`pr_ci_fix_enabled`が`true`のときに限る。起動の判断は、レビューの有無、ジョブの種類などの固定の条件で決め、PRやログの文字列を読んで決めない。
コミット本文は、トレーラーの行との完全一致だけを見て、自由な文字列は解釈しない。
通知とDiscordの文は固定文で、workflowの名前、実行の結論、ログといった外部の文字列を入れない。リポジトリへ書ける人が決める文字列なので、通知を介して人やClaudeへ指示を渡させないためである。
設定`pr_ci_watch_human_prs`が`true`のときは、許可された人が作ったPRのheadの実行も同じ権限で読む。
許可された人は、PATのアカウントと`allowed_labeler_logins`のアカウントである。
検索の結果は候補を絞るだけなので、PRを読み直して、作者の種別が`User`で、許可された名前(IDを設定した名前はIDも)に合うことを確かめる。
種別が`Bot`の作者、forkのPR、Factoryの実装ブランチの形のブランチのPRは、行を作らない。
検索に使う作者名とオーナー名は、検索の修飾子が紛れ込まないよう、名前の形を検査する。
人のPRには、直す作業項目を起動せず、PRとリポジトリへの書き込みもしない。
通知の文は、FactoryのPRと同じ固定文である。
forkのPRの実行と、別のPRの実行は、判定に使わず捨てる。headのリポジトリのIDがベースと違う実行と、結び付いたPRの番号が違う実行を使うと、forkや別のPRの結果を、FactoryのPRの結果として扱ってしまうためである。
Actions: Read-onlyでは、実行の一覧だけでなく、選んだ全リポジトリの実行のログとartifactも読める。
`github_token`は、Console用workerの`approval_decide`と`retry_work_item`も読む。
そのため、漏れたときの影響は、Contentsの読み書きに加えて、ログとartifactを読まれる分だけ広がる。
ログとartifactには秘密値を入れない。漏れたときの影響が広がる分は、残るリスクとして受け入れる。

PRのマージの競合を検知するscript`watch_pr_conflicts`は、Pull requestsの読み取りだけを使い、開いているPRの一覧とPRの状態を読む。
読む範囲は、許可リストに合うリポジトリの開いているPRで、作者を問わない。検索は、照合を通ったオーナー全体を対象にする。
判定するのは、そのうちPATのアカウントが作った、Factoryのブランチの形のPRだけである。見つけ方は[PRのCI監視の内部仕様](internals/pr-ci.md#対象の見つけ方)にある。
設定によっては、リポジトリの発見とPRの列挙を収集の表から読む。
表の値は候補を絞ることにだけ使い、Factoryがpushしてよいブランチかの判断には使わない。
候補は、読み直したPRの応答で確かめ直してから扱う。
確かめるのは、PATのアカウントが作ったか、forkでないか、Factoryのブランチかである。
競合の通知と起動の判断は、RESTで読み直した値に固定する。
そのため、表の値が書き換えられても、候補が増えれば読み直して飛ばす。
候補が減れば、次に収集が書き直すまで列挙されず、処理が遅れるだけである。
`watch_pr_conflicts`自身は、PRとリポジトリへ書き込まない。
設定`pr_conflict_fix_enabled`が`true`のときは、競合を直す作業項目(`pr_fix`の競合回)を起動する。
そのフローが、同じPATでmergeコミットをPRのブランチへpushする。書き込みの安全策は、[マージの競合を解く回](#マージの競合を解く回)に書く。
起動の判断のために、読む資源が増える。

- PRのcommit本文は、トレーラー`Generated-By`の完全一致の判定だけに使う。ログと通知には出さない。
- Factoryのリポジトリのfactory-fixスキルは、マーカーの有無だけを見る。本文は使わない。
- リポジトリの既定のブランチの名前と、その先頭のshaを読み、mainのCIの記録を引く。

起動の入力は、作業項目のIDだけである。競合の行のIDと競合の回は、作業項目の列から読む。
保留の理由を通知とDiscordの文に載せるときは、語彙の固定値に対応する固定の説明だけを使う。外部の文字列は載せない。
通知とDiscordの文には、PRの題名やブランチ名を載せない。リポジトリへ書ける人が決める文字列を、通知を介して人やClaudeへ渡させないためである。
残るリスクとして、トレーラーはcommit本文の照合なので、リポジトリへ書ける人は偽れる。
偽ったcommitだけのPRは、「Factoryが作ったPR」として自動で直す対象になりうる。
対象のPRは、PATのアカウントが作った、Factoryのブランチの形のPRに限る。
書き込める人は、ほかの手段でも同じPRを書き換えられるので、受け入れる。
残るリスクとして、第三者が1000件超のPRで、検索だけが見つけたリポジトリを埋めることがある。
このとき5分ごとに10ページを読み続け、他のフローと共有するPATのrate limitの枠を、1リポジトリにつき1時間で約120リクエスト使う。
1回の実行に、1リポジトリ10ページ、予算120秒、rate limitでの停止という上限がある。条件は、運用者本人のPRがそのorgの公開リポジトリにあることなので、受け入れる。

fine-grained PATは、トークンの値を変えずに権限の設定だけを変えられる。権限を変えるときは既存のトークンを更新すればよく、再発行は要らない。
orgのリポジトリでは、権限を足すと、org側で再び承認を求められることもある。承認するまで、同じ通知は残る。

Issue化の提案を承認してIssueを作るとき(`issue_proposal_apply`)も、同じ`f/factory/github_token`を使う。別の資格情報は用意しない。

有効期限は最長で1年である。`poll_issues`は冒頭で`GET /user`を呼び、トークンが失効していればジョブを失敗させる。
失敗はスケジュールの失敗ハンドラ(`on_error_schedule`)が`job_failures`に記録し、Discordに`job_failed`として通知する。
直近3回の実行が続けて失敗すると、要対応の通知`schedule_failing`も残る。

GitHubの認証は、環境変数`GH_TOKEN`と、gitのcredential helperとしての`gh auth git-credential`だけで行う。`gh auth login`の対話ログインと、トークンを埋め込んだclone URLは使わない。

### Claude CodeのOAuthトークン

`CLAUDE_CODE_OAUTH_TOKEN`は、workerのheadless Claudeが使う、サブスクリプションの長期OAuthトークンである。

1. ホストにインストールしたClaude Code CLIで`claude setup-token`を実行する。
2. ブラウザでログインする。
3. 表示されたトークンを`CLAUDE_CODE_OAUTH_TOKEN`として投入する。

### DiscordのWebhook URL

`DISCORD_WEBHOOK_URL`は、通知の送り先である。

1. 通知先のDiscordチャンネルで、「チャンネル設定」、「連携サービス」、「ウェブフック」の順に開く。
2. 「新しいウェブフック」を押し、名前を`Software Factory`にする。
3. 「ウェブフックURLをコピー」でURLを取得し、`DISCORD_WEBHOOK_URL`として投入する。

### Consoleの取り込み用のPAT

`CONSOLE_GITHUB_TOKEN`は、Consoleの成果物を取り込む`console_fetcher`だけが使うfine-grained PATである。
Factoryの`GITHUB_TOKEN`は流用しない。
Issues、Contents、Pull requestsの書き込み権限が広すぎるためである。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押し、表示された`github_pat_...`を`CONSOLE_GITHUB_TOKEN`として投入する。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-console-fetcher` |
| Description | `Factory Console fetcher (read CI artifacts)` |
| Resource owner | このリポジトリの所有者 |
| Expiration | Customで1年後(最長)。期限切れは`console_fetcher`のログと`status.json`に`auth_failed`として出る |
| Repository access | Only select repositoriesを選び、このリポジトリだけを選ぶ |
| Repository permissions: Actions | Read-only |
| Repository permissions: Metadata | Read-only(自動で付く) |
| それ以外のRepository permissions | No access |
| Account permissions | すべてNo access |

値は`console_fetcher`のコンテナの環境変数にだけ渡る。
worker、Caddy、Windmillの変数には入らない。

### 収集用の読み取りトークン

`GITHUB_READ_TOKEN_<OWNER>`は、収集の`collect_github`が所有者ごとに使う、読み取り専用のfine-grained PATである。
`GITHUB_TOKEN`は流用しない。
書き込みのできるトークンを、定期ジョブ用workerに届かせないためである。
fine-grained PATはResource ownerを1つしか選べないので、所有者(個人と所属する組織)ごとに1つ作る。

1. GitHub右上のアイコンから、**Settings**、**Developer settings**、**Personal access tokens**、**Fine-grained tokens**の順に開く。
2. **Generate new token**を押す。
3. 下の表のとおりに各項目を設定する。
4. **Generate token**を押し、表示された`github_pat_...`を、`GITHUB_READ_TOKEN_<OWNER>`として投入する。
5. 組織の所有者は、組織側でfine-grained PATを許可し、トークンを承認する。
   承認が保留や取り消しになると、非公開リポジトリが一覧から消えて`gone`になる。
   収集は閉じる側に倒れる。

| 項目 | 設定値 |
| --- | --- |
| Token name | `atelier-works-factory-reader-<所有者>` |
| Description | `Software Factory collector (read-only: PR / Issue state)` |
| Resource owner | その所有者(個人のアカウントかorg) |
| Expiration | Customで1年後。組織が最長期限を1年より短くすることがある |
| Repository access | All repositories。集める範囲は、設定の`owners`と`repo_allowlist`で絞る |
| Repository permissions: Metadata | Read-only(自動で付く) |
| Repository permissions: Pull requests | Read-only |
| Repository permissions: Issues | Read-only |
| それ以外のRepository permissions | No access。Contentsは付けない。Actions、Checks、Commit statusesは、CIの状態を集める変更で足す |
| Account permissions | すべてNo access |

できれば、すべての読み取りトークンを`GITHUB_TOKEN`と同じアカウントで作る。
トークンの持ち主が違うと、後の変更でPRの作者や担当を比べるときに、意味がずれるためである。
Contentsを付けないのは、Metadata、Pull requests、IssuesのRead-onlyだけで、収集の問い合わせが読む項目に足りるためである。
権限名とGraphQLの項目の対応は、反映後の実ジョブで確かめる。
段2の詳細の問い合わせも、ブランチの名前とSHAを、参照を辿らずにPRのスカラー項目で読む。
参照を辿ると、Contentsの権限が要りうるためである。
ラベル、担当、レビュー依頼の接続も読むが、どれもContentsの権限は要らない。
チームのレビュー依頼などの任意の項目が拒否されたときは、その項目の列だけが`NULL`になる。

値は`mise run bootstrap`が、環境変数から所有者のlogin(小文字)をキーにしたJSONの対応表に組み、Windmillのsecret変数`github_read_tokens`に入れる。
人がJSONを組むことは無い。
`bootstrap.sh`は、次のものを、環境変数の名前だけを出して警告し、飛ばす。
値は出さない。

- loginの形に合わない名前
- 名前を直した結果が同じloginになる複数の変数(両方を飛ばす)
- `github_pat_`で始まらない値
- `GITHUB_TOKEN`か`CONSOLE_GITHUB_TOKEN`と同じ値

loginに`_`を含む所有者(EMUのアカウント)は、環境変数の名前の`_`が`-`に直るので、対応表のキーに合わない。
収集は扱わない。
`mise run doctor`が、`owners`にある該当の所有者の名前を警告する。

## Windmillの公開範囲と初期パスワード

Caddyは`WM_BIND`のアドレスにだけバインドする。既定値は`mise.toml`の`[env]`にある`127.0.0.1`なので、ホストの外からは到達できない。外部に公開するときは、利用者が`WM_BIND`を明示的に変える。

初期の管理者アカウントのパスワードは、既知の既定値`changeme`である。`scripts/bootstrap.sh`はログインした後、パスワードを必ず`WM_ADMIN_PASSWORD`に変える。`WM_ADMIN_PASSWORD`が`changeme`か12文字未満なら、`bootstrap.sh`は実行を拒む。

`mise run doctor`は、既定のパスワードでログインできる状態をNGとして報告する。

ログインのセッション(`/auth/login`で発行されるもの)の有効期間は30日に設定している。
有効期間が更新される仕組みの有無は、確かめていない。
端末を紛失したときにセッションを失効させる手段も、確かめていない。
`WM_BIND`を外向きにするときは、`WM_SESSION_VALIDITY_SECONDS`を`mise.local.toml`などmiseの設定で上書きして短くする。
手順は[セットアップ](setup.md)にある。

## Consoleの配信

Consoleは、Windmillと同じオリジンの`/console/`で配信する。
ConsoleでXSSが起きると、運用者のCookieでWindmillのAPIを管理者として呼べる。
そのため、配信物の完全性とブラウザ側の制限を次のように守る。
仕組みの詳細は[Consoleの仕様](internals/console.md)にある。

| 守ること | 内容 |
| --- | --- |
| 書ける場所を1つにする | 配信物の置き場所`factory_console`(dockerの名前付きボリューム)に書けるのは`console_fetcher`だけである。CaddyとConsole用のworkerは読み取り専用でマウントし、defaultのworkerはマウントしない |
| 取り込むものを絞る | 専用のワークフロー`console-dist.yml`が`main`へのpushで動き、成功した実行の成果物`console-dist`だけを取り込む。同じcommitの`ci.yml`が`main`へのpushで成功していることも要る。どちらもワークフローのパスと名前、ブランチ、イベント、結論を確かめる。zipと展開した各ファイルのsha256を照合してから書く |
| `console_fetcher`を閉じ込める | rootでないuid、読み取り専用のファイルシステム、ケーパビリティなし、DBにもWindmillにも届かない専用のnetworkで動かす |
| ブラウザ側で制限する | `/console/*`の応答だけに、scriptの読み込み先を`/console/assets/`に絞ったCSPと、埋め込みを禁じるヘッダーを付ける |
| CSPとCaddyのパスの解釈の違いを塞ぐ | パーセント符号を戻した元のパスが`/console/`で始まる要求は、Windmillへ転送しない。Consoleの経路では、生のパスに`%2f`か`%5c`があれば400にする |
| 旧Consoleのリンクを固定の行き先に飛ばす | 廃止した旧ConsoleのURL(`/apps/get/f/factory/factory_console`と`/apps_raw/get/f/factory/factory_console`、配下を含む)は、パスとクエリによらず固定の`/console/`へ302で飛ばす。行き先を要求から作らないので、オープンリダイレクトにならない。`Cache-Control: no-store`を付け、ブラウザに転送を覚えさせない |
| 他のサイトからAPIを呼ばせない | `/api/*`への要求は、次の4つをCaddyが403にする。`Sec-Fetch-Site`が`cross-site`か`same-site`のもの。`Origin`がブラウザの開いたオリジンと一致しないもの。ジョブを起動するGET(`run_wait_result`、`run_and_stream`、`slack_approval`、`teams_approval`、`move_s3_file`)を、fetchとXHR以外(`Sec-Fetch-Dest`が`empty`でないもの)で呼んだもの。GETとHEAD以外の要求を、ページの移動(`Sec-Fetch-Mode`が`navigate`か`nested-navigate`)で送ったもの。副作用のあるGETも、`Sec-Fetch-Mode`が`navigate`のときは止める。`Sec-Fetch-*`、`Origin`、`Cookie`のどれも送らないCLIは通す |
| Console自身の誤りを防ぐ | 呼べるscriptは、許可リストの5つ(読み取りの1つと、承認、再実行、監査の起動、通知の解決)だけである。認可はWindmillのログインに任せる。承認者と解決者は、画面から渡さず、ジョブの実行文脈からscriptが導き、導けなければ拒否する。Consoleの書き込みは、同一オリジンの`fetch`によるPOSTで送る。副作用のあるGETと、ページの移動による書き込みは、上の行のとおりCaddyが止める |
| 配信する状態を絞る | `/console/status.json`で配信するのは、`console_fetcher`の状態の4項目(`state`、`sha`、`checked_at`、`error`)だけである。`checked_at`と`error`から、自動の配信が止まっていることなど運用の状態が外から見える。`error`には分類した失敗の種類だけを書き、トークンや応答の本文などの秘密は含まない。ボリュームの他のファイルは配信しない |
| 秘密を配信物に入れない | Consoleのバンドルは認証なしで配信されるので、`VITE_*`の変数に秘密を入れない |

> [!WARNING]
> `factory_console`を、`console_fetcher`以外のコンテナに書き込みでマウントしない。
> workerのサンドボックスを作るときも同じである。
> 書けるコンテナが増えると、運用者のブラウザに居座る改ざんの経路になる。

残るリスクは次のとおりである。

- 許可リストと型付きの関数が防ぐのは、Console自身の誤りだけである。ConsoleのXSSや、運用者のCookieを持つ攻撃者は防げない。Cookieがあれば、許可リストの外のscriptも、Windmillのapiから直に呼べる。
  ログインのセッションの有効期間は30日で、Windmillの既定の3日より長い。
  運用者のブラウザが管理者のCookieを持つ時間も、そのぶん長い。
- 承認の二重の送信を画面で止められるのは、このタブの中だけである。別のタブや別の端末、リロードの後は止められない。
  Issue提案のIssue作成のやり直しは、画面でもこのタブで15分間止める。
  それでも重なると、GitHubの検索の反映の遅れで、Issueが2件できうる。
  サーバーは、Issueを作る前に承認依頼ごとの印を条件付きのUPDATEで取り、取れなかった呼び出しを何もせずに終えて、この重なりを緩和する。
  Windmillの同時実行の制限(`concurrent_limit`)は設定しない。有償版でしか効かない。設定すると、自動の反映を拒否されるおそれもある。
  印は15分で切れるので、止まった処理のやり直しは塞がれない。
  失敗して提案を保留に戻した後も、印は期限まで残る。
  印に持ち主の識別子は無い。期限を超える処理と取り直した処理は、理論上は重なりうる。
- `main`へのマージは、承認0件のPRで済む。PRの必須チェックは通る必要があるが、人のレビューは強制されない。FactoryのPATが`main`へマージできるか、人の確認なしにマージできるかは確かめていない([mainの保護とリポジトリの公開](#mainの保護とリポジトリの公開))。そのため、マージされたコードは人のレビューを経ずに運用者のブラウザで動きうる。Consoleの変更のレビューは、Windmillの管理者権限を持つコードのレビューとして行う。
- CIの組み立ての途中で動くもの(miseが入れるbunなどのツール、Viteのプラグインなどの依存)が侵害されると、出力が改ざんされうる。`digest`とマニフェストが保証するのは、GitHubのCIが作ったものであることまでである。
- 信頼の境界は`console-dist.yml`の1つのジョブと、そこで動くツールや依存に及ぶ。`ci.yml`のジョブは同名の成果物を上げても、取り込み先の実行(`console-dist.yml`)に入らない。組み立ての手順は`console-dist.yml`に直接書き、composite actionに分けない。`console-dist.yml`を書き換える変更は、`main`へのマージで反映されるので、マージ前のレビューが唯一の防御である。
- 同じ実行の中では、成果物を`overwrite: true`で上げ、`console_fetcher`はその名前の`id`が最大の成果物を取り込む。`console-dist.yml`のジョブは1つなので、同じ実行にほかの上げ手はいない。
- `console-dist.yml`の成功が示すのは、組み立てが通ったことだけである。型検査、lint、テストを担う`ci.yml`の成功も、同じcommitについて取り込みの条件にする。`ci.yml`が実行中のcommitは、成功するまで取り込まない。
- `main`という名前のタグの実行は、ブランチ名が`main`で現れる。`console_fetcher`は同じcommitで、`console-dist.yml`と`ci.yml`のどちらも`main`へのpushとして成功していることを求める。FactoryのPATはWorkflowsの権限が無く、ワークフローのファイルを書き換えたcommitを作れない。現在のワークフローは`main`のブランチのpushでしか動かないので、PATによるタグでは実行が作られない。
- 両方のワークフローを書き換えたcommitに`main`というタグを付けられる人は、この照合を通せる。タグの作成と更新は、rulesetの`protect-tags`で管理者に限っている。管理者は迂回できるので、管理者のアカウントの侵害は防げない。取り込むcommitが`main`の履歴に含まれるかは、確かめていない。
- draw.ioのビューアも、この成果物の差し替えの範囲に入る。ビューアは`console-dist.yml`が取得して、同じ成果物に入れるためである。
- `Sec-Fetch-Site`をブラウザが送るのは、信頼できるオリジン(localhostかHTTPS)のときだけである。`WM_BIND`を外向きにしてHTTPで公開すると、この防御は効かない。外向きにするならHTTPSで公開する。
- `Origin`の検査が比べる相手は、要求の`Host`ヘッダーから作ったオリジンである。DNSリバインディングで`Host`が攻撃者のホスト名になると、`Origin`も一致して通る。ただしCookieはホスト名ごとに付くので、運用者のCookieは付かない。
- `Origin`の検査が補えるのは、GETとHEAD以外のブラウザの要求だけである。ナビゲーションや`<img>`のGETには`Origin`が付かず、Firefox 70未満はフォームのPOSTにも付けない。この検査は、HTTPで公開してもブラウザが送るので、`Sec-Fetch-Site`の弱点を補う。
- 前段でTLSを終端するときは、プロキシが`Host`をポートを含めて保つ(nginxなら`proxy_set_header Host $http_host`)。nginxの既定は`Host`を書き換え、`$host`はポートを落とす。どちらも`Origin`と合わず、ログインを含む書き込みがすべて403になる。
- スキームを問わず許すので、HTTPS公開のときも、同じホスト名とポートの`http://`の`Origin`が通る。`Sec-Fetch-*`を送るブラウザは、`Sec-Fetch-Site`の規則が止める。止められないのは、`Sec-Fetch-*`を送らないブラウザだけである。
- GETでも副作用のあるAPIは、`Sec-Fetch-Site`と`Origin`では止まらない。同じオリジンの`<img>`やリンクから、Cookieの持ち主の権限でジョブを起動できる。そのため、副作用のあるGETの経路を洗い出し、fetchとXHR以外を403にしている。洗い出しの一覧は[Consoleの仕様](internals/console.md)にある。洗い出したのは`windmill-client`の型定義にあるAPIまでで、サーバーの全経路ではない。HTTPトリガー(`/api/r/*`)を足すときは、GETでジョブを起動する経路にならないかを確かめる。
- 古いブラウザと、HTTPで公開したブラウザは、`Sec-Fetch-Dest`を送らない。`Sec-Fetch-*`は、localhostかHTTPSのオリジンにだけ付くためである。この場合、副作用のあるGETは`Cookie`を持つときだけ止める。WindmillのフロントエンドがこれらのGETを使うと、その環境では403になる。
- 注入された`<form method="post">`のクリックは、`Sec-Fetch-Mode: navigate`で止める。`Sec-Fetch-Mode`を送らないブラウザは止めない。止めるとfetchの書き込みまで巻き込むためである。
- `<link rel="prefetch">`、`<link rel="preload">`、`<a ping>`は、`Sec-Fetch-Dest: empty`などで、副作用のあるGETを送りうる。
  どれも生のHTMLの注入が要り、サニタイザが落とすので、止めていない。
- この4つの規則が効くのは`/api/*`だけである。`windmill_extra`の経路(`/ws/*`、`/ws_mp/*`、`/ws_debug/*`)には、`Origin`の検査も含めて効かない。`handle @extra`が先に当たるためである。
- 旧Consoleへの規則は、過去のDiscordの通知、Issueのコメント、PRの本文に残るリンクのために、旧Consoleを削除した後も残す。飛ばすのは閲覧の`/apps/get/`と`/apps_raw/get/`だけで、編集画面やAPIには触れない。フラグメントはブラウザがリダイレクトを越えて保ち、新しいConsoleが読み替える。読み替えるのは、正の整数のidを持つ要件定義書と監査レポートの形だけで、ほかのフラグメントは入口に着く。
- 共有の`assets/`には古い版のファイルも残る。その間は`script-src`で読み込めるので、XSSの足がかり(script gadget)に使われうる。
- Trusted TypesのReport-Onlyの方針には報告先が無い。違反はブラウザの開発者ツールのコンソールにしか出ない。
- `console_fetcher`の外への通信はnetworkでは絞れない。コードが侵害されれば、任意の宛先へ出られる。
- `console_egress`は通常のbridgeで、ホストのloopbackから切り離されない。既定の`WM_BIND=127.0.0.1`のままでも、`host.docker.internal`経由でホストのCaddy、つまりWindmillに届く(OrbStackで確認)。`WM_BIND`を外向きにすると、ホストのゲートウェイのIP経由でも届く。`console_fetcher`はWindmillの資格情報を持たないが、認証の要らない経路には届く。
- `CONSOLE_GITHUB_TOKEN`は、ホストのdockerを使える人には`docker inspect`で見える。
- 成果物を取りに行くリポジトリ`CONSOLE_GITHUB_REPO`は、コミットされた`mise.toml`にある。これを書き換える変更がマージされると、任意のpublicリポジトリの成果物を取り込みうる。`mise.toml`は保護パスで、マージは人が行うことで抑えている。ただしPATのマージ権限は未確認である。
- 成果物の保持は30日である。30日以上`main`へのpushが無いと、新しく立ち上げた環境は取り込めない。そのときは`main`に何かをマージしてCIを動かす。

## workerコンテナの権限

workerは`privileged`にせず、`FAVOR_UNSHARE_PID`も有効にしない。Windmillの公式の構成は、ジョブを隔離するためにこれらを使うことがある。このworkerは信頼できないIssueを読むheadless Claudeを実行するので、侵害されたときにホストへ波及する範囲を小さくすることを優先する。

ジョブ間の隔離は、追加の特権に頼らず、工程ごとのツールの制限と読み取り専用の方針で確保する。

workerには`no-new-privileges:true`と、プロセス数の上限(`deploy.resources.limits.pids`)を設定する。
`cap_drop`は、ジョブが使わない`NET_RAW`、`MKNOD`、`SETFCAP`、`AUDIT_WRITE`に限る。
`NET_RAW`は、同じnetworkの他のコンテナへのなりすましの足場になるため、落とす。
`SYS_CHROOT`、`FSETID`、`NET_BIND_SERVICE`は、Windmill本体が使わないことを確かめていないので残す。
`ALL`を落として必要なものだけを足す構成は、Windmill本体が使うものを確かめていないので採らない。
検査コマンドの実行には`CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`SETUID`、`SETGID`、`SETPCAP`、`KILL`が要るので、これらは落とさない。
workerのプロセスは、ベースのWindmill公式イメージがrootでの実行を前提にしているため、rootで動かす。
信頼できないコードを実行する検査コマンドだけを、非特権のユーザーに落とす([検査コマンドの権限](#検査コマンドの権限))。

workerのPATHには、rootのホームの`/root/.local/bin`と、誰でも書き込める`/tmp`の下の`/tmp/.local/bin`を入れない。
ベースのイメージのPATHは、この2つを含む。
`/tmp/.local/bin`は、Windmillの`windmill`の実行ファイルに参照が無く、稼働中のworkerにも存在しない。
非特権のuidがそこに`git`などを置くと、rootのworkerの名前解決を奪えるため、外している。
`claude`は`/usr/local/bin`のsymlinkから名前で起動する。

イメージには、検査コマンドを動かす非特権のユーザー`factory-check-0`から`factory-check-7`を作ってある。
`useradd -M`でホームのディレクトリは作らず、passwdに記録されるホームのパスも実在しない。
`HOME`は、実行のたびに`/tmp`の下に作る非公開のディレクトリを渡す。
ジョブの`TMPDIR`が指す先には作らない。そこは検査用のユーザーが入れない0700の下なので、`HOME`にたどり着けないためである。
ログインシェルは使えない。
uidの切り替えに使う`setpriv`と、枠のロックに使う`flock`も入っている。
後始末に使う`kill`(procps)と、ACLを確かめて消す`getfacl`と`setfacl`(acl)も入っている。
イメージのビルドは、検査の実行と同じ引数の`setpriv`で、すべてのユーザーについて、uid、ケーパビリティの上限が空であること、`no_new_privs`を確かめる。
`kill`、`getfacl`、`setfacl`があることも確かめる。
使い方は[検査コマンドの権限](#検査コマンドの権限)に書く。

## Console用workerの境界

Console用のworker(`windmill_worker_console`)は、Consoleの問い合わせと操作の受付だけを処理する。
信頼できないIssueを読むClaudeは、このworkerでは動かさない。
このworkerの境界が守るのは、ファイルシステムだけである。
以下で「ボリューム全体」と書くのは、`factory_state`の最上位を指す。`claude`、`gh`、`audits`、`requirements`などが並ぶ層である。
絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_console_dependency_cache`だけである。`worker_logs`は、`windmill_server`とすべてのworkerと共有する書き込みのマウントである |
| `factory_state` | ボリューム全体はマウントしない。サブパス`requirements`だけを、同じパス(`/var/lib/factory/requirements`)に読み取り専用でマウントする。Claude Codeとghの設定は、ボリューム全体の直下にあるので届かない |
| `factory_console` | 読み取り専用でマウントする |
| `factory_workspaces` | マウントしない。対象リポジトリのチェックアウトに届かない |
| `worker_dependency_cache` | 共有しない。Console用のworkerは専用のボリュームを使うので、defaultのworkerと依存のキャッシュを通して影響し合わない |
| `docker.sock` | マウントしない |
| 権限 | `privileged`にしない。`no-new-privileges:true`と`init`を設定し、プロセス数は256、メモリは1024Mに絞る |

`requirements`を読めるのは、要件定義書と図のファイルを返すためである。
監査レポートは本文をDBから読むので、`audits`はマウントしない。
`factory_console`は配信中のJSの置き場所なので、書き込みでマウントしない。
読み取り専用で付けるのは、取り込みの失敗を見張るscriptが`status.json`を読むためである。

tag`console`を使える主体は、インスタンスのカスタムtagで決まる。
superadminは、許可の有無にかかわらず使える。
superadminでない主体は、許可されたtagしか使えない。
Consoleのscriptをsuperadminでない主体から呼べるよう、`mise run bootstrap`と`mise run instance:tags`がカスタムtagに`console`を足す。
定期ジョブ用workerのtag`periodic`も、同じ2つが足す。
許可しても、このworkerのマウントとDBへの到達は変わらない。
変わるのは、このworkerでscriptを動かせる主体である。

管理者の資格情報を送る`doctor`と`bootstrap`は、宛先を`WM_HTTP_PORT`のポートの`127.0.0.1`に限る。
`WM_BASE_URL`は使わない。
`mise.toml`では`WM_BASE_URL`が8080に固定されている。
`WM_HTTP_PORT`だけを変えると、8080を使う別のサービスへパスワードを誤って送りうるためである。
ログインの前に`/api/version`がWindmillの応答かを確かめ、違えば資格情報を送らずに止まる。
この照合は開始時に1回だけ行う。
`bootstrap`の`curl`は、リダイレクトを追わず、環境変数のプロキシも使わない。
追うか通すと、資格情報が確かめていない宛先へ届くためである。

Consoleから押せる書き込みには、読むsecret変数の上限を決める。
`github_token`を読んでよいのは、`approval_decide`と`retry_work_item`だけである。
`audit_kickoff`と`notice_resolve`は、どのsecret変数も読まない。
Consoleの操作で、外向きの資格情報が動く範囲を広げないためである。
tag`console`のscriptがimportでたどれるソースを数える契約テスト(`tests/scripts/console_worker_boundary.test.ts`)が、この上限を確かめる。
許可した2つも、`github_token`以外のsecret変数は読まない。
走査でたどれない形が現れたら、テストは落ちる。
たどれない形は、次のとおりである。

- 絶対パスと、`f/`か`u/`で始まるimport
- `require`
- 引数が単純な文字列リテラルでないimport()
- `.name("literal")`の形の呼び出しで説明できない、`getVariable`と`getResource`の出現。添字アクセス、分割代入、名前付きimport、別名への代入、引数が変数の呼び出し、注入された関数の呼び出しが当たる

script.yamlに`$var:`か`$res:`の参照があるときも、テストは落ちる。
例外は2件で、どちらも読み取りを依存として注入するため、引数が変数になる。`console_query`は`deployed_sha`の読み取りで、`loadConfig`は設定のリソースの読み取りである。呼び出し側が定数だけを渡すことを確かめ、テストの許可リストに理由を書いている。
テストが見ないのは、文字列を組み立てて作ったsecretのパス、環境変数やDBを経由して受け取る名前、`eval`、文字列の中に隠したコードである。これらはコードのレビューで見る。

サブパスのマウントは、ディレクトリが無いとコンテナが起動しない。
1回限りのサービス`factory_state_init`が、起動の前に`requirements`を作る。
このサービスは`factory_state`を書き込みでマウントするが、ネットワークを持たず、権限もすべて落とし、固定の短いシェルのコマンドだけを実行して終わる。
`requirements`がsymlinkならディレクトリを作らずに失敗で終わり、そうでなければ`mkdir -p -m 0755`を実行する。
defaultのworkerで動くものが置いたsymlinkの先を、Console用のworkerにマウントさせないためである。
`requirements`がsymlinkだと`factory_state_init`が失敗し、`mise run deploy`は`wmill sync push`とmigrationの前で止まる。

`volume.subpath`は、古いEngineでは気づかないうちに無視され、`factory_state`のボリューム全体がマウントされうる。
そのため、スタックを起動するmiseのタスク(`up`、`deploy`)は、起動の前にEngineが26.0(API 1.45)以上、Composeが2.26.0以上かを確かめ、満たさなければ止まる。
この強制が止めるのは、`mise run up`と`mise run deploy`を通した起動だけである。
`mise exec -- docker compose ... up`を直接実行した場合や、restart policyによる再起動は止めない。
`doctor`は同じ検査に加えて、起動中のConsole用workerの中から、`factory_state`のボリューム全体がマウントされている証拠が見えないことを確かめる。
証拠は、`/var/lib/factory`の直下の`claude`、`gh`、`audits`と、`requirements/requirements`である。
対象リポジトリのowner名が`requirements`だと、サブパスだけが付いていても`requirements/requirements`が見える。
そのため、この証拠だけではボリューム全体のマウントを見分けられない。
Podmanは対象外である。

次のことは、この境界では守れない。

- DBには届く。`DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- tag`console`のscriptは、管理者の`DATABASE_URL`か`wmill.getVariable()`で、Windmillのsecret変数を読める。
  読める変数には`f/factory/claude_oauth_token`と`f/factory/github_token`がある。
  `retry_work_item`が実際に読むのは、次の2つのときの`github_token`である。
  取り消された作業項目の再開のときの、対象の状態の確認。
  Issueの要件定義を作り直す再実行のときの、取り込み内容の更新。
  `approval_decide`が読むのは、要件定義の承認のときの`github_token`である。
  Console用のworkerで動くscriptから`github_token`を読むのは、この2つのscriptに限る取り決めである。
  この取り決めは、tag`console`のscriptがたどれるソースを数える契約テストで確かめる。強制する仕組みは無い。
  マウントの制限で守るのは、Claude Codeとghの設定と履歴のファイルだけである。
  トークンそのものは守らない。
- scriptを編集できる者は、tagを付けずにdefaultのworkerで動かせば、`factory_state`のボリューム全体を読み書きできる。
- 要件定義書と図は読める。Consoleが表示するのと同じ内容である。
- このworkerで動かすのはリポジトリのscriptの想定だが、これを強制する仕組みは無い。ワークスペースでscriptを編集できる者は、任意のscriptにtag`console`を付けられる。
  `console`をカスタムtagに許可しているので、superadminでない者が付けたscriptも、このworkerで動く。
  tag`console`を付けたscriptは、`requirements`の下を読める。書けるのはdefaultのworkerだけである。
- 許可した主体は、Console用workerの依存キャッシュ(`worker_console_dependency_cache`)に書ける。defaultのworkerでscriptを実行できる者には、元から同等のことができるので、実害は増えない。
- Console用workerの枠は1つである。長く動くjobで枠を埋めると、Consoleの問い合わせと承認が止まる。可用性の問題で、秘密の漏れではない。
- 許可はすべてのワークスペースに及ぶ。ワークスペースに絞る書式(`console(factory)`)は、実機で確かめていないので採用していない。
- `doctor`と`bootstrap`の宛先の照合が防ぐのは、ポートの取り違えだけである。
  Windmillを装うローカルのプロセスには、資格情報が渡る。
  照合とログインは別の接続なので、その間に宛先が入れ替わる隙もある。
  `bootstrap`は、1回の照合の後に長い手順で同じ宛先へトークンを送るので、手順の途中の入れ替わりも防げない。
- composeの環境変数`WORKER_TAGS`は既定値である。DBにワーカーグループの設定があると、そちらが実効になる。変化はWindmillの画面の「Workers」で確かめる。
- `factory_state_init`の確認の後にも隙がある。
  Console用のworkerは、`factory_state_init`を経ない起動のたびに、サブパスを解決し直す。
  契機は、restart policy、Dockerデーモンの再起動、ホストの再起動、手動の`docker compose restart windmill_worker_console`である。
  その前にdefaultのworkerが`requirements`をsymlinkに置き換えると、symlinkの先がマウントされうる。
  隙は、`factory_state_init`を経ずにworkerが起動するたびに開く。
  誤ったマウントは、symlinkを消してworkerを起動し直すまで残る。`mise run up`は、設定の変わらない、動いているworkerを作り直さないためである。
  `mise run up`が`factory_state_init`の失敗で止まったときは、その時点のworkerのマウントを疑う。
  [Console用workerを確かめる](operations.md#console用workerを確かめる)の手順でsymlinkを消し、workerを作り直す。
  突くにはdefaultのworkerでのコード実行が要る。その権限があれば`factory_state`のボリューム全体を直接読めるので、実害は増えない。

## 定期ジョブ用workerの境界

定期ジョブ用のworker(`windmill_worker_periodic`)は、tag`periodic`を付けた定期ジョブを処理する。
信頼できない入力を扱うジョブは、このworkerでは動かさない。
リポジトリのコードや検査コマンドを動かすジョブと、Issueの本文やPRの差分を読むClaudeがそれにあたる。
このworkerの境界が守るのは、ファイルシステムである。
Console用workerと同じ型で、絞り方は次のとおりである。

| 項目 | 設定 |
| --- | --- |
| 書き込めるマウント | `worker_logs`と専用の依存キャッシュ`worker_periodic_dependency_cache`だけである。`worker_logs`は、`windmill_server`とすべてのworkerと共有する書き込みのマウントである |
| `factory_state` | マウントしない。Claude Codeとghの設定、監査レポート、要件定義書に届かない |
| `factory_workspaces` | マウントしない。対象リポジトリのチェックアウトに届かない |
| `factory_console` | マウントしない。配信中のJSに届かない |
| `worker_dependency_cache` | 共有しない。専用のボリュームを使うので、defaultのworkerと依存のキャッシュを通して影響し合わない |
| `docker.sock` | マウントしない |
| 権限 | `privileged`にしない。`no-new-privileges:true`と`init`を設定し、defaultのworkerと同じ`NET_RAW`、`MKNOD`、`SETFCAP`、`AUDIT_WRITE`を落とす。プロセス数は256、メモリは1024Mに絞る。権限はdefaultのworkerの部分集合である |
| 環境変数 | `NUM_WORKERS`と`I_ACK_NUM_WORKERS_IS_UNSAFE`は置かない。nativeでないworkerは1つで動くためである |

信頼できない入力を扱うジョブを動かさない理由は、このworkerが読める秘密にある。
DBには、defaultのworkerと同じ管理者の接続で届く。
Windmillのsecret変数は、管理者の`DATABASE_URL`か`wmill.getVariable()`で読める。
通知に使う`discord_webhook_url`と、収集に使う`github_read_tokens`も読める。
Console用workerと同じ前提で、マウントの制限が守るのはファイルであり、トークンそのものは守らない。
信頼できない入力を扱うジョブが、このworkerで任意のコードを動かせると、これらの秘密に届く。
そのため、tag`periodic`を付けるのは、コードを実行せず、Claudeに文章を渡さない定期ジョブだけである。
このworkerの権限はdefaultのworkerの部分集合なので、誤ってtagを付けても権限は広がらない。
分ける目的は、定期ジョブの枠の確保である。

tag`periodic`を使える主体は、Console用workerのtag`console`と同じく、インスタンスのカスタムtagで決まる。
superadminは、許可の有無にかかわらず使える。
superadminでない主体は、許可されたtagしか使えない。
次のことは、この境界では守れない。

- DBには届く。`DATABASE_URL`はdefaultのworkerと同じ管理者の接続だからである。
- secret変数の`claude_oauth_token`、`github_token`、`discord_webhook_url`、`github_read_tokens`を読める。
  どのscriptが読むかを制限する仕組みは、契約テストの許可だけである。
- このworkerで動かすのは、上の基準で選んだ定期ジョブの想定である。
  リポジトリに入る変更のうち、テストが走査できる形は、契約テスト(`tests/scripts/periodic_script_boundary.test.ts`)が止める。
  走査できない形と、Windmillの画面でtag`periodic`を付ける操作は止められない。
  ワークスペースでscriptを編集できる者は、任意のscriptにtag`periodic`を付けられる。
- 許可はすべてのワークスペースに及ぶ。ワークスペースで絞らない。
- scriptを編集できる者は、tagを付けずにdefaultのworkerで動かせば、`factory_state`のボリューム全体を読み書きできる。
- 許可した主体は、このworkerの依存キャッシュ(`worker_periodic_dependency_cache`)に書ける。
  defaultのworkerでscriptを実行できる者には、元から同等のことができるので、実害は増えない。
- このworkerの枠は1つである。長く動くjobで枠を埋めると、ほかの定期ジョブが待つ。
  可用性の問題で、秘密の漏れではない。
- composeの環境変数`WORKER_TAGS`は既定値である。DBにワーカーグループの設定があると、そちらが実効になる。変化はWindmillの画面の「Workers」で確かめる。

### tagを付けるscriptの選び方

このworkerは上流のWindmillイメージで動く。
独自イメージの道具も、defaultのworkerがマウントするファイルも、cgroupの計測の対象も無い。
そのため、tag`periodic`を付けるのは、次のどれにも依存しない定期ジョブだけである。
依存するジョブは、defaultのworkerに残す。

- ファイル。`factory_state`、`factory_workspaces`、self cloneの下を読み書きするジョブがあたる。
  このworkerには同じパスのボリュームが無い。
  ジョブは失敗するか、コンテナの中の別のディレクトリを触って成功したように見える。
  後者は気づきにくい。
- 独自イメージの道具。`claude`、`gh`、`git`、`gtr`を使うジョブと、道具や検査の枠を確かめるジョブがあたる。
  道具や検査の枠を確かめるジョブは、上流のイメージでは、必ず確認に失敗して保留される。
- cgroup。cgroupのファイルを読んで、負荷や使用量を測るジョブがあたる。
- 子プロセス。`child_process`で外部のコマンドを起動するジョブがあたる。

選ぶときは、scriptと、importでたどれるソースをすべて読み、上の4つに依存しないことを確かめる。
見る箇所は、ファイルのパスと`fs`の使用、`child_process`のimport、道具や検査の枠を確かめる呼び出し、cgroupのパスである。
同じ手順で、コードを実行しないことと、Claudeに文章を渡さないことも確かめる。
1つでも依存するなら、tagを付けない。

読んでよいsecret変数は、scriptごとに決める。
`notify_daily_summary`と`auto_retry_pr_review`が読めるのは、`discord_webhook_url`だけである。
`collect_github`が読めるのは、`github_read_tokens`だけである。
`claude_oauth_token`、`github_token`、`wmill_token`は、このworkerに届かせない。
対象のscriptが読まない許可は、残さない。
別のscriptの許可を借りて読めるようにしないため、許可はscriptごとに分ける。
`discord_webhook_url`を許可するのは、通知を送る定期ジョブを、このworkerで動かすために、通知の送り先が要るためである。
このworkerは、固定のレビュー済みのscriptだけを動かす。
漏れたときの影響は、通知の偽装と、webhookの削除や改名による通知の停止に限られる。
webhookのURLを持つ者は、トークンだけで改名と削除ができる。
補足として、どのworkerのジョブも`getVariable`で読める状態はもとからで、このworkerで読める範囲は広がらない。
別のsecret変数を許すかは、この理由とは別に、読む必要と漏れたときの影響で決める。
これを超えて広げるときは、契約テストの許可と、この節の選定の結果を同じ変更で直す。

`github_read_tokens`を許可するのは、収集を、書き込みのできる`github_token`を使わずに、このworkerで動かすためである。
トークンのRepository accessは「All repositories」なので、読める内容は所有者の全リポジトリに及ぶ。

- Pull requestsの読み取りで、非公開リポジトリのPRの題・本文・コメント・レビューコメント・コミットと本文・変更ファイルとpatch。
- Issuesの読み取りで、Issueの本文とコメント。
- Metadataの読み取りで、collaboratorの一覧。

書き込みはできないので、漏れたときの影響は、これらの読み取りと、レート制限の消費に限られる。
全部の所有者のトークンが、1つの変数に集まる。
変数は所有者ごとに分けない。
分けると、`getVariable`の引数がリテラルでなくなり、契約テストの`filesWithNonLiteralReads`に反する。
所有者ごとにテストの許可も要る。
1つのジョブが乗っ取られれば、分けても全部に届くので、分ける利点が無い。

契約テスト(`tests/scripts/periodic_script_boundary.test.ts`)が、tag`periodic`を持つscriptについて次を固定する。
走査の方法と、たどれない形は、Console用workerの契約テストと同じである。

- `f/`の下のYAMLのうち、tag`periodic`へ振り分けるものが、テストの一覧のscriptの定義と一致する。
  scriptの定義の`tag`だけでなく、スケジュールの`tag`と、フローのモジュールの`tag`と`tag_override`も、入れ子の中まで調べる。
  読めないYAMLがあれば、ファイル名を添えてテストが落ちる。
  足すときは、一覧とこの節の選定の結果を同じ変更で直す。
- どのscriptも、スケジュールが呼ぶscriptで、`timeout`を持つ。
- 各scriptについて、他のscriptの`timeout`の合計に300秒の余裕を足した値が、待ちの検知のしきい値(`PERIODIC_JOB_WAIT_SECONDS`)を超えない。
  このworkerの枠は1つなので、長く動くジョブの後ろで待つジョブを、workerの不在と誤って知らせないためである。
  待たされる最悪は、他のscriptのtimeoutの合計である。
  今の4本では、`collect_github`と`default_worker_watch`が最も待たされる。
  他の3本は、どれも120秒のtimeoutで、その後ろで最大360秒待つ。
  しきい値は、それに余裕を足した660秒である。
- importでたどれるソースが読むsecret変数は、scriptごとの許可に限る。
  許可のキーが、tag`periodic`のscriptの一覧と一致することと、許可したsecretを実際に読むことも固定する。
  ある許可を別のscriptに当てると、違反が返ることも確かめる。
- importでたどれるソースに、ファイル、サブプロセス、`claude.ts`への依存が無い。
  `node:fs`、`node:child_process`、`bun`モジュールのimportと、`Bun`の使い方を調べる。
  `Bun.sleep`のような無害なメンバー以外は、`Bun.spawn`や`Bun.file`に加えて、分割代入、別名への代入、添字アクセスも当たる。
  `globalThis`、`process.getBuiltinModule`、`process.binding`も当たる。

`node:module`、`node:worker_threads`、`node:vm`のimportも、迂回に使えるので数える。
`f/`の下のTypeScriptが、`JobService.run*`でジョブを起動したり、tagの文字列を渡したりしていないことも、テストが確かめる。
現在、該当する呼び出しは0件である。

テストが見ないものは、コードのレビューで見る。

- 式で組み立てたtag、フローの入力で渡すtag。
- Windmillの画面で付けたtag。
- 文字列で組み立てた参照、`eval`と`Function`、注入された関数の中身。
- 第三者パッケージ(`execa`、`fs-extra`、`zx`など)の中身。
- resourceの中身で解決されるsecret。`getResource`が返す値の中の`$var:`は、走査が見ない。

tag`periodic`を新しく付けるPRでは、そのscriptが読むresourceの中身を確かめる。
`getResource`の引数のresourceごとに、値に`$var:`で始まる参照が無いことを、Windmillで確かめる。
参照があれば、参照先のsecret変数が、そのscriptに許したものだけであることまで確かめる。
テストが固定するのはsecret変数の名前の読み取りだけなので、この確認は人かレビューが行う。

### 選定の結果

`f/factory/**`の定期実行のscriptを1つずつ読んだ結果は、次のとおりである。
tag`periodic`を付けたのは、`notify_daily_summary`、`auto_retry_pr_review`、`collect_github`、`default_worker_watch`である。
いずれもresource`f/factory/factory_config`だけを読む。
ローカルのインスタンスでは、その値に`$var:`と`$res:`の参照が無いことを確かめた。
本番相当のインスタンスのresourceは、リポジトリから確かめられない。人がWindmillの画面で見て確かめる。

| script | 依存と読むsecret | 結論 |
| --- | --- | --- |
| `audit_kickoff`、`console_fetch_watch` | tag`console`でConsole用workerが動かす | 対象外 |
| `poll_dependabot`、`drawio_viewer_bump` | 保護パスで、`gh`と`github_token`を使う | 対象外 |
| `poll_issues`、`poll_prs`、`watch_pr_ci`、`watch_pr_conflicts`、`watch_main_ci` | `gh`、`git`、`github_token`を使う。`watch_pr_ci`は検査用イメージの確認も行う | defaultに残す |
| `cleanup_workspaces`、`self_update` | `factory_workspaces`、self clone、`git`、`gh`を使う。`self_update`は`wmill_token`も読む | defaultに残す |
| `cleanup_db` | `factory_state`の`requirements`ディレクトリを消す | defaultに残す |
| `sample_worker_load` | cgroupのファイルを読む | defaultに残す |
| `notify_daily_summary` | DB、Windmillの状態、Discordだけを使う。読むsecretは`discord_webhook_url`だけである | `periodic`を付ける |
| `auto_retry_pr_review` | DB、WindmillのAPI、Discordだけを使う。読むsecretは`discord_webhook_url`だけである | `periodic`を付ける |
| `collect_github` | DB、Windmillのresource、宛先を固定したGitHubのGraphQLだけを使う。読むsecretは`github_read_tokens`だけである | `periodic`を付ける |
| `default_worker_watch` | DB、Windmillのqueue、Discordだけを使う。読むsecretは`discord_webhook_url`だけである。defaultのworkerが止まると動かないので、defaultには置けない | `periodic`を付ける |

`github_token`を読む定期ジョブは、`gh`の道具に依存するため、tag`periodic`を付けられるものが無い。
`notify_daily_summary`と`auto_retry_pr_review`は、ファイル、サブプロセス、`claude`、`gh`のモジュールをimportでたどらない。
そのために、使う定数と型を小さなモジュールに分けている。
`collect_github`は、通信を`lib/gh_graphql.ts`に置き、`github.ts`を使わない。
`default_worker_watch`は、queueの応答を集計する副作用の無いモジュール(`worker_load_support`)を使う。
cgroupの文字列を解析するだけで、ファイルは読まない。
たどるようになれば、契約テストが落ちる。

### 収集のトークンの残るリスク

収集のトークンについて、次を受け入れている。

- 書き込み権限を持つfine-grained PATを、読み取り用として入れても、`bootstrap.sh`は見分けられない。
  見るのは、`github_pat_`の接頭辞と、`GITHUB_TOKEN`と`CONSOLE_GITHUB_TOKEN`との一致だけである。
- 「All repositories」のトークンは、所有者の全リポジトリの内容を読める。
  集める範囲は設定で絞るが、トークンの読める範囲は絞られない。
- 全部の所有者のトークンが、1つの変数に集まる。
- `repo_allowlist`が空のとき、見えないリポジトリを`not_visible`として検出できない。
  反映後に、人が件数を確かめる([収集の運用](operations.md#収集の運用))。
- loginに`_`を含む所有者(EMUのアカウント)は集めない。
- 先頭が`.`のリポジトリ名(`.github`など)は集めない。
  GitHubの名前の述語は、シェルとパスに渡す名前の守りと共通なので、収集のために緩めると、その守りも緩む。
- 締め切りやGitHubの失敗が続くと、リポジトリの状態が前回のまま凍る。
  `gone`の行は消えない。
- 詳細の行のブランチ名と作者は、forkのPRを含めて、外の人が決められる。
  収集は、書くときと読むときに形を検査し、通らない値を`NULL`にする。
  下流は、DBの値だけでGitHubへ作用する操作に進まない([下流が守る不変条件](internals/github-collect.md#下流が守る不変条件))。
- 開いたPRが90件を超えるリポジトリは、詳細が打ち切られ続ける。
  公開リポジトリでは、外の人がPRを開けて、そのリポジトリの詳細を古いままにできる。
  打ち切りや失敗のリポジトリの古い行は、`usable`が真のまま残る。
  最初に詳細の行を読む処理は、閾値で判断を止める判定を備えなければならない([下流が守る不変条件](internals/github-collect.md#下流が守る不変条件))。

## ホストの実行役の境界

ホストの実行役は、`origin/main`の先端を、ホストのユーザーの権限で反映する道具である。
入口は`scripts/host-apply.ts`で、判定の部品は`scripts/host_apply/`に置く。
入口が受け付けるのは、判定だけを出力する`plan`と、人が変更を承認する`approve`である。
`plan`は、適用済みと目標の2つのコミットを受け取る。
出力するのは、反映できるか、拒否するか、承認を待つかの判定である。
`plan`は、gitのオブジェクトを読むだけで、作業ツリー、ネットワーク、dockerには触れない。
`approve`は、gitのオブジェクトと、実行するファイルの内容と、承認の記録を読む。
ネットワークとdockerには触れず、書くのは承認の記録1ファイルだけである。
CIの確認はネットワークを使うので、`plan`は行わない。

実行役は、ホストのdockerと、`mise.local.toml`の秘密値を使える。
mainに入った変更は、その権限で動く道具を書き換えうる。
次の境界で、それを防ぐ。

### 実行役のコード

入口と部品は、`f/**`をimportしない。
importするのは、NodeとBunの組み込みと、`scripts/host_apply/`の中だけである。
リポジトリの外へコピーしても、単独で動くようにするためである。
`tests/scripts/host_apply_imports.test.ts`が、ソースのimportと、コピーしたコードの実行で確かめる。

### treeの検査

実行役は、目標のtreeの全エントリを列挙する。
symlink(mode 120000)かsubmodule(160000)が1つでもあれば、目標を拒否する。
設定ファイルがsymlinkだと、リポジトリの外のファイルを読ませたり書かせたりできる。
たとえば、秘密値のファイルを読ませたり、Caddyfile経由でホストのファイルに書かせたりできるためである。
今のtreeには、どちらも1つも無い。

次のパスも拒否する。1つのパスが2つのファイルを指しうるためである。

- ASCIIの印字できる文字以外を含むパス。
  `ſcripts/doctor.sh`や、ケルビン記号を使った`docKer-compose.yml`は、大文字小文字の畳み込みやUnicode正規化で、ASCIIのファイルと同じ名前になりうる。
- ディレクトリを含めて、ASCIIの小文字にそろえると衝突するパス。大文字小文字を区別しないファイルシステムでは、同じファイルになる。
- composeが自動で読むoverrideファイル(`docker-compose.override.yml`、`compose.override.yaml`など)。定義を後から上書きできる。

前提は、1つのパスが1つのファイルを指すことである。
この検査は、承認の判定と、ファイルの読み取りより前に行う。

静的な検査で読むファイルは、通常のファイルで、256KiB以下のものだけを読む。
無いファイルと、読むのに失敗したファイルは区別する。
無ければ拒否し、gitの失敗は拒否ではなく実行の失敗にする。
失敗を拒否にすると、一時的な失敗が、同じ目標の拒否として控えに残るためである。

### 人の承認が要る変更

実行役は、適用済みのコミットから目標までの差が、次のファイルに触れたら、自動では反映せず承認を待つ。
追加、変更、削除のどれも、触れたとみなす。
これらは、実行役が秘密値を渡して動かす道具と、その判断の前提を決めるファイルである。

| 種類 | ファイル |
| --- | --- |
| 実行役が動かす道具 | `scripts/doctor.sh`、`scripts/bootstrap.sh`、`scripts/check-docker-version.sh`、`scripts/custom-tags.ts`、`scripts/record-host-applied.sh`、`scripts/check-idle.ts` |
| 実行役の実装 | `scripts/host-apply.*`、`scripts/host_apply/`、`scripts/host-install.sh` |
| mise設定 | `mise.toml`、`mise.*.toml`、`.mise.toml`、`mise/`、`.mise/`、`.config/mise/`、`.tool-versions` |
| 実行環境の設定 | `package.json`、`bunfig.toml`、`.npmrc`、`.env`、`.env.*`、`.nvmrc`、`.node-version`などの`.*-version` |
| 必須チェックの定義 | `.github/workflows/`の全体、`scripts/ci-scope.ts` |

`package.json`、`bunfig.toml`、`.npmrc`は、リポジトリのルートのものだけを対象にする。
mise設定の名前、`.env`系、`.nvmrc`、`.*-version`は、ディレクトリを問わず対象にする。
判定は大文字小文字を区別しない。APFSでは`Bunfig.toml`も`bunfig.toml`と同じファイルを指すためである。

`bunfig.toml`は`preload`でコードを実行でき、`.npmrc`はmiseのツールのinstallが読む。
`package.json`は、`scripts`、`bin`、`workspaces`、`trustedDependencies`など、コードを動かす欄を持つ。
`bun run scripts/custom-tags.ts`のように、`./`で始まらないパスを`run`に渡すと、同名の`scripts`の項目がファイルより先に実行される。
そのため、`scripts/doctor.sh`と`scripts/bootstrap.sh`は、`bun ./scripts/custom-tags.ts`で起動する。
`./`で始め、`run`を付けない形は、必ずファイルを実行する。
miseは、`devEngines`、`packageManager`、`.nvmrc`、`.*-version`を、設定で有効にしたツールについてだけ、バージョンの指定として読む。
既定では、どのツールについても読まない。読む設定になっても、これらの変更は承認を通る。
`bun.lock`は対象にしない。
実行役は`bun install`を実行せず、ホストで実行するファイルは依存をimportしないためである。

`.github/workflows/`は、必須チェックを出すworkflowの置き場である。
`ci.yml`を書き換えて、ジョブを`if: false`で`skipped`にすると、必須チェックを通せる。
ほかのworkflowの書き換えや新しいworkflowは、必須チェックと同名のcheck-runを作れる。
`scripts/ci-scope.ts`は、`scope`ジョブの出力で、どのジョブを動かすかを決める。
出力を変えても、同じように必須チェックを`skipped`にできる。
チェックの結果からはその迂回を見分けられないので、これらの変更を人に見せる。

差を取る基準は、適用済みのコミットと承認済みのコミットのうち新しい方である。
承認済みのコミットが、適用済みの子孫で、目標の祖先であるときだけ使う。
承認の後で対象のファイルが変われば、また承認が要る。
基準より後の差だけを評価するので、承認済みの変更に重ねた変更も、素通りしない。

通常のcomposeの変更(サービスの設定、Dockerfile、Caddyfile)は、承認を求めない。
これらは実行役が実行するのではなく、dockerが作るコンテナの中身であり、後述の静的な検査が境界を守るためである。

#### package.jsonの値だけの変更

`package.json`の差が、`dependencies`、`devDependencies`、`overrides`の版の文字列だけなら、承認を求めない。
dependabotの更新のたびに、人の承認を求めないためである。
版の文字列は、`1.2.3`、`^1.2.3`、`~1.2`、`>=1.2.3`、`1.2.3-rc.1`の形に限る。
URL、gitやfileの指定、`npm:`の別名、`latest`、`*`への変更は、取得元や中身を変えうるので、承認が要る。
ほかのキーの変更と、新規作成、読めない内容も、承認が要る。
免除は、`dependencies`、`devDependencies`、`overrides`の既存の名前の、版の文字列だけに効く。
新しい名前を足す変更は、承認が要る。名前を消す変更は、承認を求めない。
`peerDependencies`、`optionalDependencies`、`resolutions`の変更は、承認が要る。
免除は、小文字の`package.json`だけに効く。

#### miseの値だけの変更

`mise.toml`の差が、composeが参照する15個のキーのうち`CONSOLE_GITHUB_REPO`を除く14個について、
`[env]`の値だけなら、承認を求めない。
版の更新のたびに、人の承認を求めないためである。
値が文字列で、`{{`を含まず、次の形式に合うときだけ、この免除を使う。
免除は、小文字の`mise.toml`だけに効く。

| キー | 形式 |
| --- | --- |
| `WM_VERSION`、`CLAUDE_VERSION`、`GH_VERSION`、`GITLEAKS_VERSION`、`WMILL_VERSION` | 版番号(`1.2.3`、`1.2.3-rc.1`) |
| `WM_HTTP_PORT` | 5桁までの数字で、65535以下 |
| `WM_BIND` | `127.0.0.1`だけ |
| `WM_SESSION_VALIDITY_SECONDS`、`FACTORY_CHECK_UID`、`FACTORY_CHECK_POOL_SIZE`、`LOG_MAX_FILE` | 桁数の決まった数字 |
| `CONSOLE_GITHUB_REPO` | GitHubのHTTPSのリポジトリのURL。値の変更は免除しない |
| `GTR_REF` | `v`を付けた版番号 |
| `GTR_COMMIT` | 40桁の16進 |
| `LOG_MAX_SIZE` | 数字に`k`、`m`、`g`のどれかを付けた形 |

次の差は、免除の対象外で、承認が要る。

- `CONSOLE_GITHUB_REPO`の値の変更。Consoleの配信物の取得元を決めるが、形式だけでは正しい取得元か確かめられないため。
- 15個以外のキーの変更。
- `[tools]`、`[tasks]`の変更。`gh`などの版の更新も含む。
- キーの追加と削除、`mise.toml`の新規作成、読めない内容への変更。

実行役は、目標の`mise.toml`を、`mise`コマンドではなくTOMLとして静的に読む。
`mise`を呼ぶと、テンプレートや`_.source`が評価され、目標の内容がコマンドとして実行されるためである。
読み取りは`Bun.TOML.parse`で行い、15個のキーの値だけを取り出す。
キーがそろわない、または形式に合わない目標は、拒否する。

### 承認の門

承認が要る変更は、人が`approve`で承認するまで、反映の対象にならない。
承認の記録を書けるのは、端末で確認の文言を入力した人だけである。
入口は`bun --no-env-file ./scripts/host-apply.ts approve <sha> --applied <適用済みのsha>`である。
`mise run`を経由しない。`mise.local.toml`の秘密値を、承認のプロセスの環境に入れないためである。
`--no-env-file`は、カレントディレクトリの`.env`をBunが読まないようにする。
付け忘れると、書く前に終了コード3で止まる。
手順は[変更を承認する](operations.md#変更を承認する)にある。

#### 承認の記録

承認の記録`approved.json`は、次の項目を持つ。

- 承認したコミット(`sha`)
- 承認のときに人が示した適用済みのコミット(`applied`)
- 承認の時刻
- 承認したファイルの一覧

置き場は、ホストの`~/Library/Application Support/atelier-works-host/`である。`--state-dir`で変えられる。
共有ボリュームとコンテナの中には置かない。workerが書き換えられないようにするためである。
ディレクトリは0700、ファイルは0600で作り、一時ファイルに書いてから`rename`する。
読む側と書く側の両方が、symlink、他者の所有、緩い権限、複数のハードリンク、64KiBを超える本文を拒否する。
読めない記録は承認なしとして扱うので、反映が進まない側に倒れる。

`plan --state-dir`は、記録の`applied`が実際の適用済みと完全に一致するときだけ、記録を使う。
祖先でも子孫でも使わない。
記録は、`applied`から`sha`までの正味の差を、人が見たことを表す。
実際の適用済みが違うと、人が見ていない変更を隠しうる。
たとえば、変更して元に戻した差は、元の適用済みから見た正味の差に現れない。
人が`--applied`に偽の値を渡しても、実際の適用済みと違えば記録は使われず、承認をやり直すことになる。

前の記録の`applied`が`--applied`と一致するときは、次の承認の差の始点が、前の記録の`sha`になる。
中間のコミットを順に承認すれば、適用済みから目標までのすべての変更を、人が見ることになる。
記録は、1回の承認ごとに置き換える。

記録は、承認したときの`HEAD`の規則で決まる。
規則とは、承認の対象のファイルの判定(`isApprovalTarget`など)と、承認の表示を作るコードである。
そのため、規則を変えるコミットを承認するときは、先に`HEAD`をそのコミットまで進める。
記録を使って反映する側は、承認の規則の版(`scripts/host_apply/`の差)が`HEAD`と目標で違う記録を、使ってはならない。
違う規則で承認した記録は、目標の規則で承認が要る変更を、人に見せないまま通しうるためである。

#### 門

`approve`は、次の門をすべて通ったときだけ、確認の文言を求める。

| 門 | 確かめること |
| --- | --- |
| 起動 | `bun --no-env-file`で起動している |
| 主体 | 環境に、空でない`CLAUDECODE`も`CLAUDE_CODE_ENTRYPOINT`も無い |
| 端末 | 標準入力と標準出力のどちらも端末である |
| コードの出どころ | 実行しているコードが、`origin/main`に含まれる版と同じである |
| 判定 | 承認前が承認待ちで、承認後が反映できる |
| 確認の文言 | 表示した文言を、そのまま入力する |

主体の判定を、`CLAUDE_CODE_`で始まる名前では行わない。
`CLAUDE_CODE_OAUTH_TOKEN`は人のシェルの環境にも入りうるので、接頭辞で判定すると人も止まるためである。
環境変数は消せるので、主体の判定は誤操作の防止であり、権限の境界ではない。

終了コードは次のとおりである。

| 終了コード | 意味 |
| --- | --- |
| 0 | 承認を記録した |
| 1 | 実行の失敗(gitの失敗、記録を書けない) |
| 2 | 使い方の誤り |
| 3 | 承認しない(門を通らない、判定が承認に値しない、確認が一致しない) |

門のどれかを満たさなければ、記録は書かれない。
承認前の判定が、承認待ち以外のときも承認しない。
承認しても拒否になる変更(composeとmiseの静的検査の違反)は、承認では通せない。

#### コードの出どころ

承認の表示を作るコードが書き換えられていると、人は偽の表示に確認の文言を答える。
そこで、次の3つを確かめる。

- 実行しているスクリプトが、メインのチェックアウトにある。リンクされたworktreeでは動かさない。カレントディレクトリは、リポジトリのトップでなければならない。
- 実行するファイルの内容が、`HEAD`と同じである。
  対象は、入口、`scripts/host_apply/`の全ファイル、`bunfig.toml`、`package.json`である。
  `tsconfig.json`、`tsconfig.wmill.json`、`scripts/tsconfig.json`も対象にする。
  `bunfig.toml`以降の5つは、作業ツリーと`HEAD`のどちらにも無ければ、照合しない。
- `HEAD`が、`origin/main`の先端の祖先(同じを含む)である。

内容の照合は、作業ツリーのファイルのblobのsha1を、`HEAD`のtreeと比べて行う。
`scripts/host_apply/`にあって`HEAD`に無いファイルは、不一致になる。
`git status`は使わない。`skip-worktree`、`.gitignore`、フィルタで隠せるためである。

検査を動かすのは検査される側のコード自身なので、書き換えた側を止める境界にはならない。

#### 表示と文字

差分は、承認するファイルについて、前後3行の文脈つきで表示する。
色、textconv、外部のdiff、リネームの検出は使わない。
バイナリ指定のファイルも、文字として出す。
modeだけの変更も、ヘッダーの`old mode`と`new mode`の行で見える。
40行ずつ表示し、Enterで次へ進み、`q`で終了コード3になる。
最後のページまで表示した後にだけ、確認の文言を求める。
文言は、`approve`と承認するコミットの先頭12桁である。
内容を見ずに反射で答えるのを止めるためのもので、agentを止める守りではない。

表示は、許可した文字だけをそのまま出す。許可する文字は次のとおりである。

- ASCIIの印字できる文字、タブ、改行
- ひらがな(`U+3041`〜`U+3096`)、`々`、カタカナ(`U+30A1`〜`U+30FA`)、`・`、`ー`、漢字(`U+4E00`〜`U+9FFF`)
- `、`、`。`、かぎ括弧、`【`、`】`、`〜`(`U+301C`)、`…`、`※`、矢印(`U+2190`〜`U+2193`)

一覧の外の文字は、`\x1b`や`\u{2028}`のような見える表記にして表示する。
承認するファイルの追加行に一覧の外の文字が1つでもあれば、承認しない。
端末の制御、見えない文字、行に見える文字、別の文字に見える文字で、表示を偽られないようにするためである。
引用符、`U+2014`、`U+00D7`、全角の英数と記号、結合文字、`U+3000`、`U+303F`は許可しない。
拒否する文字を列挙する形にしないのは、`U+2028`、`U+3164`、タグ文字、異体字セレクタ、soft hyphenなど、漏れが出やすいためである。

承認の対象のファイルが一覧に収まることは、`tests/scripts/host_apply_approve.test.ts`が、追跡しているファイルで確かめる。
違反はCIで止まるので、承認できない文字を含むコミットはmainに入らない。

次の変更は、この道具では承認しない。

- `.env`系のファイルを含む変更。差分の本文に秘密値が出うるため。
- 追加、変更、削除のどれでもない変更(ファイルの種類の変更など)。
- 差分が512KiBを超える変更。
- 承認の記録が64KiBを超える変更。ファイルの数が多い変更は、これに当たる。

#### gitの呼び出し

`approve`のgitは、`/usr/bin/git`を絶対パスで起動し、環境を固定する。
`PATH`を`/usr/bin:/bin`にして、偽の`git`を拾わせない。
ユーザーとシステムの設定、属性、pathspecの展開、replace ref、ロックの取得、対話の入力を無効にする。
属性の取得元は空のtreeにして、作業ツリーの`.gitattributes`を読ませない。
使うサブコマンドは、`plan`が使う読み取りに、`rev-parse`と`show-ref`を足したものに限る。
`fetch`、`push`、`checkout`などは、引数を組み立てる段階で例外にする。
`origin/main`は、短い名前ではなく、`refs/remotes/origin/main`の完全な名前で読む。

#### 承認の門の残るリスク

- 同じホストユーザーのプロセスは、`approved.json`を直接書ける。ファイルの権限では防げない。
- agentが環境変数を消し、疑似端末で文言を入力すれば、`approve`を通せる。起動を拒否ルールで止めるかは、運用者の判断である。
- コードの出どころの検査は、書き換えた側が迂回できる。
  - Bunの読み込み: `~/.bunfig.toml`と`$XDG_CONFIG_HOME/.bunfig.toml`の`preload`、`BUN_OPTIONS`。リポジトリの外にある親ディレクトリの`tsconfig.json`は、照合できない。カレントディレクトリの`bunfig.toml`の`preload`は、`--no-env-file`とカレントディレクトリの検査では防げない。
  - gitの挙動: `.git/info/grafts`と、gitの設定。環境の固定で緩和するだけである。
  - `origin/main`のref: 同じユーザーが書き換えられる。
  - `HEAD`が、承認する版そのものになりうる。`--applied`と`HEAD`を揃える案は、人が先に`git pull`した場合の拒否を招くので採らない。
  - `mise activate`を使うシェルでは、`mise.local.toml`の`[env]`が環境に入りうる。gitの子プロセスの環境は固定するので、実害は小さい。
- 承認の表示を作るコードの変更は、`origin/main`へのマージ時の人のレビューにだけ守られる。mainは承認0件でマージできる。
- 許可した日本語の文字の中にある同形異字は、検出しない。ASCIIの記号に似る`一`、`ー`、`〜`は、許可した文字なので通る。
- `origin/main`のrefは、人が`git fetch`で更新する。古い参照は拒否側に倒れる。偽の参照は、表示した先端のshaをGitHubと照合して見分ける。
- 適用済みのshaは人が入力する。実際の適用済みと一致しない記録は`plan`が使わない。
  ただし、これは「実際の適用済み」を偽造できない出どころから得たときだけ成り立つ。
  共有ボリュームの印はworkerが偽造できるので、`--applied`はホストのcheckoutの履歴で確かめる。
  ホストの状態ディレクトリ(0700)に適用済みのshaを書き、`approve`と`plan`がそれを読む形は、後続の段階である。
- `plan --approved`は、承認の`applied`を照合しない。自動の経路は`plan --state-dir`だけを使う。
- ページ送りは論理行単位である。1行が極端に長い入力は、画面の外へ流れる。
- パスが`-`で始まる承認の対象は、gitの引数に渡せないので、`approve`が終了コード1で止まる。
- 承認は1回に1件で、前の記録を置き換える。

### composeの方針

実行役は、`infra/docker-compose.yml`を`Bun.YAML.parse`で静的に読み、許可する形だけを通す。
未知のキーは拒否する。新しい書き方を足す変更は、許可リストの更新を伴う。

- 許可リストにないサービス名とキー。
- 特権とケーパビリティの拡張: `privileged`、`cap_add`、`devices`、`userns_mode`、`cgroup`、`sysctls`、`volumes_from`、`include`、`extends`。
- ホストやほかのコンテナとの名前空間の共有。`pid`、`ipc`、`uts`、`network_mode`が`host`、`container:`、`service:`で始まる値である。`network_mode: none`は許す。
- `security_opt`の、`no-new-privileges:true`(`=true`でもよい)以外。
  `seccomp=`、`apparmor=`、`label=`、`systempaths=`は、権限を変えうるので、許可リストに無い値はすべて拒否する。
- `127.0.0.1`以外に公開するポート。変数は、取り出した値で展開して評価する。
  展開するのは、検査が知っている名前の参照だけである。知っている名前は、`mise.toml`の15個のキーである。
  本番の子プロセスには`HOME`なども入るので、ほかの名前の参照は、`${HOME-.}`のように既定値があっても拒否する。
- 展開した後の絶対パス。`env_file`、`secrets`と`configs`のファイル、`build.context`、`dockerfile`も、bind mountと同じく拒否する。
- チェックアウトの外を指す`env_file`、`secrets`、`configs`、`build.context`、`build.additional_contexts`、`dockerfile`。リモートのbuild contextも含む。
- チェックアウトの外のbind mount、絶対パスのbind mountの元、書き込める状態のbind mount。
  絶対パスは、チェックアウトの中を指していても拒否する。ステージングのパスは実行のたびに変わるためである。
  書き込めるのは`infra/Caddyfile`だけである。
- `deploy.resources.reservations`の`cpus`と`memory`以外。`devices`はホストのデバイスを割り当てるので拒否する。
- `local`以外のdriverのボリューム、`bridge`以外のdriverのネットワーク、`driver_opts`と`external`を持つもの。
- `pid`、`ipc`、`uts`、`network_mode`、`security_opt`の値に含まれる変数。展開すると拒否リストを回避できるため、展開せずに拒否する。
- 短い形のvolumeの、知らないオプションと4つ以上の項目。
- 短い形のbindのうち、`ro`の無いもの(`infra/Caddyfile`を除く)と、`rw`と一緒に書いたもの。読み取り専用とみなすのは、`ro`があり、`rw`が無いときだけである。
- サービスの`networks`のうち、名前の一覧と、`aliases`と`ipv4_address`だけを持つ対応表以外。`driver_opts`などを経由した設定を防ぐ。
- `docker.sock`の文字列。パースの前に、生のテキストで探す。コメントも対象にする。

テキストは256KiBまでしか読まない。
`Bun.YAML.parse`はaliasの参照を共有するので、パース結果を文字列にすると、小さな入力が数百MBに膨らむ。
そのため、パース結果の全体は文字列にしない。深すぎるaliasは、パーサーが自分で拒否する。

今の`infra/docker-compose.yml`が方針を通ることは、`tests/scripts/host_apply_compose_policy.test.ts`が確かめる。
`docker.sock`をマウントするサービスが無いことは、`tests/infra/docker_compose.test.ts`が確かめる。

### 子プロセスの環境とログ

子プロセスの環境は、許可リストで作る。
親のプロセスの環境は引き継がない。`PATH`と`HOME`のほかは、種類ごとに決めた名前の値だけを渡す。

| 種類 | 渡す値 |
| --- | --- |
| compose | 15個のキーと、`DB_PASSWORD`、`CONSOLE_GITHUB_TOKEN` |
| `doctor.sh`と`bootstrap.sh custom-tags` | composeの値に加えて、管理者の資格(`WM_ADMIN_EMAIL`、`WM_ADMIN_PASSWORD`)、`GITHUB_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`DISCORD_WEBHOOK_URL` |
| git | 秘密値は渡さない。`GIT_NO_REPLACE_OBJECTS`で、replace refによる内容の差し替えを無効にする |

管理者の資格を渡すのは、`doctor.sh`と`bootstrap.sh custom-tags`だけである。
管理者の資格を使う処理を、最小にするためである。

実行役が出す通知の本文は、固定の文と7桁のshaだけで作る。
`doctor.sh`や`bootstrap.sh`の出力、エラーメッセージは載せない。秘密値や任意の文字列が入りうるためである。
Discordのwebhookには`allowed_mentions`を空にして送り、本文からのメンションを無効にする。
ログに書く外部コマンドの出力は、`mise.local.toml`の`[env]`の全キーの値(8文字以上)を伏せてから書く。

外部コマンドには、種類ごとの時間の上限があり、1回の実行全体にも上限がある。
値は`scripts/host_apply/constants.ts`にある。

### CIの確認

目標のコミットは、必須チェックが通っていなければ反映しない。
判定は、GitHubのAPIの応答から行う。
必須チェックは、[mainの保護とリポジトリの公開](#mainの保護とリポジトリの公開)の7つと同じである。
必須チェックの一覧は`scripts/host_apply/constants.ts`にある。
`tests/scripts/host_apply_ci.test.ts`が、一覧とこの記述、`ci.yml`のジョブ名の一致を確かめる。

数えるのは、`ci.yml`のpushの実行と同じcheck suiteにある、`github-actions`のcheck-runだけである。
別のworkflowやappが、同じ名前のcheck-runを作っても数えない。
mainは承認0件でマージでき、管理者は失敗したチェックを無視してマージできる。
実行役が自分で確かめれば、失敗したチェックを無視して入った変更は、ホストへ届く前に止まる。
`.github/workflows/`の全体か`scripts/ci-scope.ts`を書き換えて必須チェックを`skipped`にする変更は、結果からは見分けられない。
これらの変更は、前述のとおり承認の対象にして、人に見せる。

| 結果 | 判定 |
| --- | --- |
| 7つがすべて成功かスキップ | 通過 |
| 1つでも失敗、キャンセル、時間切れ | 拒否。ほかが走行中でも拒否する |
| 実行が未着、走行中、チェックが欠ける、応答が読めない | 保留 |

名前が変わるとチェックが欠けた扱いになり、保留のまま進まない。安全側に倒れる。

### 保護パスとその限界

実行役が実行するファイルは、PR修正と実装の両方の保護パスに入れる。
対象は次のとおりである。

- 承認が要る道具と、実行役の実装。
- `infra/docker-compose.yml`と`tests/infra/docker_compose.test.ts`。
- `infra/worker/`と`mise/`の下のファイル。
- 実行役のテストと、それが使う一時リポジトリの補助(`tests/fixtures/host_apply_repo.ts`)。
- `.tool-versions`、`.env`系、`.node-version`、`.bun-version`。

一覧は`f/factory/lib/protected_paths.ts`にあり、[禁止パスによる停止](internals/pr-workflow.md#禁止パスによる停止)に説明がある。
実行役のテストはファイル名で列挙し、足した実行役のテストを列挙し忘れると、`tests/lib/protected_paths.test.ts`が失敗する。
保護パスの照合は、大文字小文字とUnicodeの別名を区別しない。
パスからゼロ幅文字などの無視される文字を除き、NFKCで正規化し、小文字、大文字、小文字の順に変換して畳み込み、畳み込んだ一覧と比べる。
ホストのファイルシステムで同じファイルに潰れる別名(`Scripts/Doctor.sh`、ラテン文字の異体字を使った`ſcripts/doctor.sh`など)を通さないための処理である。
全角文字や無視される文字を使った別名は、潰れるとは限らないが、紛らわしいので安全側で止める。
ファイル名の正規表現は、大文字小文字を区別せずに当てる。畳み込みで文字数や`/`が変わっても狭くならないよう、畳み込む前のファイル名にも当てる。
実行役は、別名になるパスが目標のtreeに入ることを、tree検査でも拒否する。

保護パスだけでは、実行役の変更を人が確かめる関門にならない。

- mainは承認0件でマージできる。管理者は、失敗したチェックを無視してPR経由でマージできる。人のレビューをGitHubは強制しない。
- PR修正は保護パスの変更で止まるが、実装フローは止めない。保護パスに触れても、記録してPR本文に明記するだけである。

人に通す関門は、保護パスではなく、実行役の承認である。
保護パスの役割は補助である。
PR修正の自動修正がこれらを書き換えるのを止め、実装のPR本文へ明記させる。

副作用として、`infra/docker-compose.yml`、`scripts/doctor.sh`、`scripts/bootstrap.sh`を変えるPR修正は、保護パスで止まって人の対応待ちになる。
実装フローは、保護パスに触れたラウンドで検査コマンドを実行しない([保護パスの記録](internals/implement.md#保護パスの記録))。
そのため、次のファイルを変えるIssueの実装ループは、検査を省いてPRに進む。
対象は、`scripts/doctor.sh`、`scripts/bootstrap.sh`、`scripts/custom-tags.ts`、実行役のテストである。
`scripts/check-idle.ts`と`tests/scripts/check-idle.test.ts`も対象に含む。
その変更は、PR本文の「確認して欲しい点」に載る。

### 残るリスク

- composeの検査は、YAMLを静的に読む。`docker compose config`の解釈とは突き合わせていない。
  解釈が食い違うと、許可した形が別の意味になりうる。
  食い違いうる書き方は、マージキーのリスト(`<<: [*a, *b]`)、`!reset`、`!override`、重複したキーである。
  複数の文書を書いたYAMLは、1つ目だけを検査して2つ目以降を見逃さないよう、拒否する。
- composeの`environment`、`image`、`command`は検査しない。
  そのため、PRの変更で、`DB_PASSWORD`と`CONSOLE_GITHUB_TOKEN`を任意のサービスやイメージへ渡せる。
  防ぎは保護パス(`infra/docker-compose.yml`)と人のマージだけで、mainは承認0件でマージできるため、補助にとどまる。
  受け入れる理由は、段階1が計画だけで、反映しないためである。
  反映する段階の設計で、どのサービスにどの秘密値を渡してよいかの許可表を検討する。
- 反映する側は、`docker compose`を、必ず`-f infra/docker-compose.yml`と`--project-directory`を明示して呼ぶ。
  省くと、overrideファイルを自動で読む場所が変わる。
- 反映に使うチェックアウトのgitには、`GIT_CONFIG_GLOBAL=/dev/null`と`GIT_CONFIG_NOSYSTEM=1`を付ける。
  利用者とシステムのgit設定を読ませないためである。`plan`のgitは`GIT_CONFIG_NOSYSTEM=1`を付けるが、`HOME`を渡すので、利用者の設定を読みうる。
- `bun.lock`は承認の対象ではないので、取得元の欄を承認なしで書き換えられる。
  実行役が`bun install`を呼ぶ段階を足すときは、`bun install --frozen-lockfile`の前に、`bun.lock`の取得元を検査するか、承認の対象にする。
- 設計は`mise`コマンドを使わないと定めるが、`scripts/doctor.sh`は`mise exec`を使う。反映する段階の設計で見直す。
- composeとYAMLの重複キーの解釈の差と、`package.json`の重複キーの解釈の差（compose-goとbun）は、`docker compose config`との突き合わせで確かめる。
- `.github/workflows/`で作られたcheck-runが付くcheck suiteは、使い捨てのリポジトリで確かめる。
- 反映に使うチェックアウトの`git worktree add`と`git checkout`にも、同じ設定を付ける。
  付けるのは、`-c core.hooksPath=/dev/null`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`である。
  lefthookのpost-checkoutが動かないようにするためである。
- `tree_forbidden`の通知は、原因のパスと次の操作を載せる。日本語のファイル名を足すと止まるためである。
- 設定ファイルの読み取りの違い。
  - `Bun.TOML.parse`は、重複したキーとテーブルをエラーにする。`__proto__`は通常のキーとして残り、`Object.prototype`は汚れない。
  - `Bun.YAML.parse`は、重複したキーを最後の値で上書きし、エラーにしない。`__proto__`は通常のキーとして残る。
  - composeの解釈とYAMLの重複キーの扱いが違うかは、`docker compose config`と突き合わせて確かめる。
- パスの検査は、文字列で行い、symlinkを辿らない。目標のtreeにsymlinkがあれば拒否するが、実行役が使うチェックアウトに後から置かれたsymlinkは見ない。
- miseの値の免除は、形式だけを見る。`GTR_COMMIT`の指す内容は確かめない。
- `plan`はCIを確認しない。`would_converge`は、CIの通過を含まない判定である。
- `docker compose up --dry-run`の出力のうち、`Creating`などの行の形は実測した。`Running`と`Recreate`の行の形は、同じ3列と見なした推定で、実機の出力では確かめていない。

## サブプロセスのnpmのinstall script

`self_update`と、ホストで動かすmiseのタスク(`mise run push`、`mise run deploy`など)は、`wmill sync push`のサブプロセスに次の環境変数を渡す。

```text
NPM_CONFIG_IGNORE_SCRIPTS=true
```

`wmill`がnpmを走らせることがあっても、依存のinstall scriptを動かさないためである。
install scriptは、workerの権限のまま、ネットワークにも出られる状態で動く。

Windmillの資産のうちnpmの依存を入れるのは、dependabotの更新のフローだけである。
`--ignore-scripts`を付け、検査コマンドと同じ隔離で動かす([インストールの後の確認](#インストールの後の確認))。
ほかに足すときは、install scriptなしで組み立てが通るかを確かめる。

廃止した旧Consoleのappは、人が`mise run push:prune`を実行するまでWindmillに残る。
残ったappは更新されず、閲覧のURLはCaddyが新しいConsoleへ302で飛ばす。

## 依存の脆弱性

ルートの`bun audit`の指摘のうち、修正版が無いものを受け入れる。
`overrides`で解消できるものは[コーディング規約](coding-guidelines.md#依存の脆弱性)の手順で固定する。

ルートの依存はすべて開発用で、文書の検査(markdownlint-cli2、textlint)、型検査、整形に使う。
本番のコードからは読まれない。
ただし、このリポジトリを対象に`check_commands_by_repo`か`allowed_check_commands`を設定すると、検査がworkerのコンテナの中で走る。
そのとき`bun install`で入る依存は、workerのコンテナの中で動く。
設定の詳細は[実装フローの仕様](internals/implement.md)と[PRワークフローの仕様](internals/pr-workflow.md)にある。

### 受け入れている指摘

| パッケージ | 重大度 | 経路 | 受け入れる理由 |
| --- | --- | --- | --- |
| `braces` | high | markdownlint-cli2 > globby > fast-glob > micromatch | `scripts/lint-docs.ts`はファイル名をglobとしてmarkdownlint-cli2に渡す。`{`を含む名前をコミットできる者は、深くネストしたパターンに到達しうる。影響は文書検査の失敗にとどまり、本番には及ばない。長さの上限の範囲では停止を再現できていない |
| `sprintf-js` | moderate | prh > js-yaml@3.15.2 > argparse@1.0.10 > sprintf-js | js-yaml@3でargparseを読むのはCLIの`bin/js-yaml.js`だけで、`lib/`からは読まれない。prhの実行時にsprintf-jsは読み込まれない |

markdown-itはargparse@3を、rc-config-loaderのjs-yaml@4はargparse@2を使い、どちらもsprintf-jsに依存しない。

### 修正版が出たときの確認

`bun audit`は定期には走らない。
依存を更新するPRの前と、指摘の報告を受けたときに、人かClaudeが次の順で確かめる。

1. ルートで`bun audit`を実行する。
2. 受け入れている指摘に修正版が出ていれば、`bun update`か`overrides`で解消し、上の表から外す。
3. `overrides`で固定しているパッケージの親が修正版を取り込んでいれば、`overrides`を外す。
4. `mise run lint:docs`が通ることを確かめる。

## 依存の変更のレビュー

PRレビュー(`pr_review`)は、依存の宣言か取得を変えるPRに、サプライチェーン攻撃の観点で指摘する。
対象と観点、指摘の目安は、[factory-reviewスキル](../.claude/skills/factory-review/SKILL.md)の「依存関係の判定基準」にある。

指摘は人のレビューを補うもので、マージを決めない。
レビューのClaudeはレジストリを読めず、依存もインストールしない。
そのため、dependabotの自動マージの対象でないPRでは、版の公開日、メンテナの交代、リポジトリの移管、依存の中身のinstall時のスクリプトを人が確かめる。
dependabotの更新を自動でマージする前は、関門と影響調査がこれらを見る([dependabotの更新の自動マージ](#dependabotの更新の自動マージ))。

## 自己更新の打ち切り

`self_update`のジョブには、全体の上限がある。
値と内訳は[アーキテクチャ](architecture.md)の「自己更新」にある。
通常は、各コマンドの上限と、区切ったSDK・DBの呼び出しの上限(30秒)で先に終わる。
全体の上限は、それでも止まったときの最後の砦である。

残るリスクは次のとおりである。

- Windmillが全体の上限でジョブを打ち切るときに、子プロセスが止まるかを確かめていない。
  子(`wmill sync push`、`wmill datatable migrate up`、git)は別のセッションで起動する。
  子の上限はworkerの中のタイマーなので、ジョブごと止まると子は上限なしで残りうる。
- 残った`wmill sync push`が、次の回が更新する作業ツリーを読み続けると、新旧の混ざった内容をpushしうる。
  作業ツリーのロックは、cloneの更新の間しか取らず、pushの間は守らない。
- 残った`wmill datatable migrate up`が、次の回の同じ処理と並行しうる。
- 打ち切りが子の実行中に当たるのは、内側の上限が働く前に全体の上限に達したときだけである。
  区切った呼び出しが30秒で終わるので、通常は当たらない。
- 残ったプロセスの見つけ方と、打ち切りが子を止めるかの確かめ方は[運用](operations.md)の「自己更新の打ち切りを確かめる」にある。

## スケジュールの凍結

凍結は、確認のために止めたスケジュールを、無関係な反映が有効に戻さないようにする仕組みである。
仕様は[スケジュールの凍結の仕様](internals/freezes.md)にある。
状態は秘密でない変数に置き、置く主体は環境変数`CLAUDECODE`と端末(TTY)で分ける。

残るリスクは次のとおりである。いずれも受け入れる。

- 凍結はWindmillの変数なので、`f/factory`に書ける主体は凍結を書き換えられる。
  この権限を持つ主体は、スケジュールそのものも書き換えられるため、凍結が増やす危険は無い。
- `CLAUDECODE`とTTYによる`session`と`human`の区別は、誤操作を防ぐためで、権限の境界ではない。
  `env -u CLAUDECODE`と擬似端末で通れる。
  守る対象が誤操作であり、悪意のある主体は上の項目の権限で直接書き換えられるため、受け入れる。
- 凍結を覆わない操作がある。
  `wmill sync push`の直接実行と、凍結を取り込む前の作業ツリーの`mise run`である。
  特に、取り込む前の作業ツリーで`push:prune`(旧タスクの`wmill sync push --yes`)を走らせると、変数ごと削除される。
  `f/factory/freezes`が、除外にも手元のファイルにも無いためである。
  すべての凍結が、警告なしに消える。
  凍結は確認作業のための期限つきの補助であり、消えた場合の影響は、スケジュールが次の反映で戻るだけに限られるため、受け入れる。
- 凍結の実装は保護パスの外にある。
  `scripts/bootstrap.sh`の全手順のモードと`mise run push`、`deploy`は、保護パスに入れていない`scripts/freeze.ts`と`f/factory/lib/freeze*.ts`を、ホストのユーザーの権限で動かす。
  これらのファイルを書き換えるPRがマージされると、次の実行でその内容が動く。
  `self_update`も同じファイルを使い、正当な変更を止めたくないため、保護パスには入れず受け入れる。
- 同時書き込みで、行が失われうる。
  `self_update`の行の削除と人の`place`が重なる窓はミリ秒から秒、CLI同士が重なる窓は秒単位である。
  `place`は書いた後に読み直し、自分の行が残っているかを確かめる。
  窓が短く、運用手順に止める直前の`freeze:list`による確認を置いているため、受け入れる。
- 同じ`target`の凍結を、期限ごとに置き直し続けられる。
  1回の上限が24時間で、置けるのは書き込み権限を持つ主体だけだから、受け入れる。
- 凍結の変数を壊すと、反映が要る回は`freeze:reset`まで止まる。
  壊れた状態のまま反映すると、凍結を無視して上書きするおそれがあり、止めるほうが安全なため、受け入れる。
- 追従のpushは、凍結を置かずに画面で止めたスケジュールも含め、リポジトリの定義へ全体を書き戻す。
  リポジトリの定義が正であり、画面での変更を残す仕組みは、そもそも無いため、受け入れる。
- 別の端末で始まった`mise run push`と`deploy`のpushには時間の上限が無い。
  `place`が示す7分の保証は、`self_update`のpushだけを数えている。
  別の端末のpushは人が始めるので、人が凍結の時刻を意識して実行できるため、受け入れる。
- 終わってから24時間を過ぎた行は、次の`place`で捨てられ、追従のpushが行われない。
  スケジュールは次の反映で戻るため、受け入れる。
- `wmill variable list`が100件以上を返すと、変数が無いと判定できず、読み取りの失敗になる。
  失敗側に倒れるので、誤って反映することは無く、受け入れる。
- 安全策の全体が、`wmill`のCLIの挙動に依存する。
  `--excludes`がカンマ区切りで別のパターンとして効くことと、`wmill.yaml`の`excludes`を置き換えることである。
  CLIは1.817.0に固定しており、版を上げるときは`mise run push:dry`で、`deployed_sha`と凍結中のスケジュールが変更に出ないことを確かめるため、受け入れる([運用](operations.md)の「ホスト側で反映するもの」)。
- 書く段が10秒の時間切れになっても、`setVariable`の要求は止まらず、ジョブが終わるまで遅れて届きうる。
  窓は、時間切れのときその分だけ延びる。
  運用手順に、止める直前の`freeze:list`による確認を置いているため、受け入れる。
- 凍結の行を消す書き込みが続けて失敗すると、追従のpushが2分ごとに、通知なしで(警告のログだけで)繰り返される。
  同じ定義を書き戻すだけで害が無く、書き込みが通れば止まるため、受け入れる。
- セッションは、`freeze.ts`の`push`、`place`、`release`を確認なしで実行できる。
  ユーザー全体の許可と`.claude/settings.json`の許可(`bun run scripts/`など)が通るためである。
  `prune`付きのpushを止める根拠は、`CLAUDECODE`の判定と端末の確認だけである。
  `prune`付きのpushが消すのは、人が`push:dry`で確かめる対象であり、誤操作を防げれば足りるため、受け入れる。
- 除外を作る`parseWmillExcludes`は、`wmill.yaml`の最上位の`excludes`だけを読む。
  `workspaces.<name>`の`overrides`に`excludes`を足すと、CLIの`--excludes`が黙って置き換えるので、足さない。
  足さない決まりを守れば、読み違いは起きないため、受け入れる。

## Claude Codeの拒否ルール

`.claude/settings.json`の`deny`は、誤操作を防ぐためのもので、秘匿性を保証しない。設定ファイルを読めば、ルールは誰でも確かめられる。秘匿性は、値をコミットしないこと(`mise.local.toml`はgitignore済み)と、値をWindmillのsecret変数に置くことで保つ。

次の操作を拒否する。どれも、展開した後の秘密値を出力しうる。

| 拒否する操作 | 理由 |
| --- | --- |
| `mise.local.toml`と、その別名のファイル(`.mise.local.toml`、`mise.*.local.toml`)の`Read`と`Edit` | 秘密値そのものが書かれている |
| `.env`、`infra/.env`、`infra/secrets.env`の`Read` | 秘密値が書かれうる |
| `.wmill/`の`remotes.ndjson`の`Read`と`Edit` | wmill CLIのワークスペースのプロファイルで、APIトークンが書かれている |
| `mise env`とその別名(`mise e`) | 展開した環境変数の一覧を出力する |
| `mise config`、`mise cfg`、`mise toml` | 設定値を出力する |
| 引数なしの`mise set`と、別名の`mise ev`、`mise env-vars` | 設定値の一覧を出力する |
| `mise exec -- env`、`mise exec -- printenv`、`mise x -- env`、`mise x -- printenv`、`printenv`、`env` | 環境変数を出力する |
| `cat mise.local.toml` | 秘密値そのものを出力する |

値を指定して書き込むだけの`mise set -E local KEY=value`は拒否しない。これらのルールは、`mise run <task>`を通した迂回(タスクの中で秘密値を出力する処理など)は防げない。

`mise x`は`mise exec`の別名で、`mise x -- bun test`のように通常の作業にも使うので、環境変数を出す形だけをこの設定で拒否する。
`docker exec`と`docker inspect`は、設定のルールが引数を絞れないので、ここには置かない。
どちらも、環境変数を出す形だけを次の節のフックが拒否する。
引数なしの`docker compose config`だけは、設定にも置く。
`mise set -E`は、値を指定して書き込む形があるので、設定では拒否せず、フックが書き込む形の無い呼び出しだけを拒否する。
書き込む形は、オペランドがすべて`KEY=VALUE`の形か、`--stdin`と、展開を含まない鍵の名前1つの形である。
`mise -E local set`のように、サブコマンドの前にグローバルオプションを置いても、値の語を読み飛ばして同じ判定をする。
`mise -E local x -- mise set`のように、オプションを前に置いた`mise exec`の内側の`mise`も調べる。
サブコマンドとその前の語が、展開、glob、ブレースを含むときは、語が変わるので拒否する。
`set`の後ろのオプションは、許可リストにあるものだけを認める。
値を取らないものは、`--stdin`、`-g`、`--global`、`--age-encrypt`である。
値を取るものは、`-E`、`--env`、`-C`、`--cd`、`-j`、`--jobs`、`--file`である。
`--age-key-file`、`--age-recipient`、`--age-ssh-recipient`も、値を取るものとして認める。
未知のオプション、展開やglobやブレースを含むオプションとその値、`--`を持つ形は、値を取ってオペランドを変えるおそれがあるので、一覧を出す形として拒否する。
オペランドに`set`などのサブコマンド名があるときも拒否する。
秘密値を投入する手順([セットアップ](setup.md))は、値を標準入力から渡す`mise set -E local --stdin KEY`を使う。
この形は一覧を出さないので、フックは拒否しない。
投入は人が行う。
フックは書き込みを止めないので、Claudeがこの形を実行すると、既にある値が空文字で上書きされうる。

## Claude Codeのフック

ClaudeがBashを実行する前に、`.claude/settings.json`が`scripts/claude-hooks/`のフックを動かす。
ローカルとクラウドのどちらのセッションでも動く。
FactoryのheadlessなClaudeの実行は`.claude/`を読まないので、このフックは動かない。

| 拒否する操作 | 理由 |
| --- | --- |
| 無条件のforce push(`--force`、`-f`、`+`で始まるrefspec) | 公開した履歴を書き換えると、ほかの作業やFactoryの`pr_fix`の変更を消しうる |
| `main`と`master`へのpush(`--all`と`--mirror`を含む) | mainへの変更は、PRとCIを通してだけ入れる |
| subagentからのpush | subagentには、pushの前に確認する相手がいない |
| `xargs`の引数で渡す`git push`と`git commit` | 標準入力から来る引数は、実行するまで分からない |
| `--no-verify`、`git commit -n`、`core.hooksPath`の設定、`LEFTHOOK`を`0`、`false`、`off`、`no`にすること。追記(`+=`)は、追記後の値を判定できないので、値によらず拒否する | lefthookの検査を飛ばすと、壊れた変更や秘密値がpushされる |
| `LEFTHOOK_EXCLUDE`に`wmill-metadata`と`wmill-metadata-check`以外を書くことと、追記(`+=`) | AGENTS.mdが飛ばしてよいとするのは、この2つだけである |
| `CHECK_IDLE_FORCE`の代入(`=`と`+=`、前置き、`env`、`export`、`declare`、引用符とエスケープを外した後の形、値が動的な場合を含む) | `mise run up`と`mise run deploy`の、実行中の仕事の確認を飛ばせる。付けるのは人が自分の端末で、確かめた後だけである |
| `LEFTHOOK_BIN`と`LEFTHOOK_CONFIG`の設定 | インストール済みのフックが読む、lefthookのバイナリと設定を差し替えられる |
| `lefthook uninstall`、`.git/hooks`と`.git/config`への書き込み | gitのフックを外せる |
| `git -c alias.*`、`remote.*.push`・`push.default`・`include.*`・`includeIf.*`の設定、`GIT_CONFIG_COUNT`・`GIT_CONFIG_GLOBAL`・`GIT_CONFIG_SYSTEM`などの環境変数 | `push`や`core.hooksPath`を別の名前や設定の裏から差し込める |
| フックを実行するgitのサブコマンド(`commit`、`push`、`merge`、`rebase`など)に前置きした`HOME=`と`XDG_CONFIG_HOME=`(`+=`の追記を含む) | gitに別の設定ファイルを読ませて、フックを外せる |
| `echo`や`printf`が変数から組み立てた文字列を、標準入力で読むシェル | 中身を判定できない |
| `mise exec`の`-c`と`--command`、コードを渡したシェル、`env`、`printenv`、`set`、`export -p`などの環境変数の一覧 | `mise exec`は`mise.local.toml`の秘密値を環境変数として渡すので、値を表示できる |
| `docker exec`と`docker compose exec`で実行する環境変数の一覧とコードを渡したシェル(`mise exec --`の前置きがあっても) | コンテナは秘密値を環境変数として持つ |
| フィールドの経路だけの`--format`を持たない`docker inspect`、`Env`か`Config`を含む経路 | コンテナに渡した環境変数が見える |
| 出力を絞らない`docker compose config`と`docker compose convert` | 変数を展開したcompose定義を出力する |
| `/proc/<pid>/environ`(`task/<tid>`の下を含む)を引数やリダイレクトに含むコマンド | プロセスの環境変数がそのまま入っている |
| 書き込む形(`KEY=VALUE`、または`--stdin`と鍵1つ)を持たない`mise set` | `mise.local.toml`の値を一覧する |
| 秘密値のファイル(`mise.local.toml`とその別名、`.wmill/`の`remotes.ndjson`、`.env`系)を名前で指すコマンド | `Read`の拒否はBashに効かず、`cat`や`grep`で読むと値が会話の記録に残る |
| リポジトリの根、`infra`、`.wmill`を起点にした再帰的な`grep`、`-u`や`--no-ignore`を付けた`rg`、`git grep --no-index` | gitignore済みの秘密値のファイルまで読む |

`CHECK_IDLE_FORCE`の拒否は、誤って付けるのを防ぐもので、あらゆる回避を機械的に塞ぐものではない。
予備として、`.claude/settings.json`の`permissions.deny`にも、行頭の代入を置く。
残るリスクとして、次の回避は塞がない。

- 変数名の組み立てと、スクリプトファイルを経由した代入。
- 代入以外で変数を設定する組み込み(`read`、`printf -v`、`declare -n`)と、`set -a`に続く`source`。
- `env -S`と`--split-string`。
- ブレース展開(`CHECK_IDLE_FORCE{,}=1`)。
- フックが外さない前置き(`stdbuf`、`caffeinate`、`bunx`、`npx cross-env`など)。
- 標準入力から渡る値(`xargs`)。
- miseの設定ファイルへの書き込みと、`docker compose up`の直接実行。
- 添字付きの代入(`CHECK_IDLE_FORCE[1]=1`)。
- `mise set CHECK_IDLE_FORCE=1`による`mise.toml`の`[env]`への書き込み。`mise.toml`は保護パスなので、差分はレビューされる。

`env -S`と添字付きの代入(`LEFTHOOK[1]=0`)は、`LEFTHOOK`の拒否にも当たる、既存の穴である。

`--force-with-lease`と`--force-if-includes`は、subagentではないセッションが`main`と`master`以外のブランチへpushするときに限って許す。
リモートが想定と違えば失敗するので、他の人の変更を上書きせずに、自分のブランチの履歴を直せる。

拒否のメッセージには、代わりの操作を示す。
再帰的な検索の代わりには、gitignoreを尊重する`rg`、`git grep`、Grepツールを使う。
`mise exec`の代わりには、ツールを直接指定するか、`mise run`のタスクを使う。
秘密値が設定済みかどうかは`mise run doctor`で確かめる。

### 判定の範囲

フックは、コマンドを字句に分けてから判定する。
引用符の中の文字列と、区切り語を引用符で囲んだヒアドキュメントの本文は、コマンドとして扱わない。
`sh -c`、`eval`、`$(...)`、バッククォートの中身は、別のコマンドとして判定する。
標準入力からコードを読むシェルは、入力がヒアストリング、ヒアドキュメント、`echo`や`printf`が書いた文字列ならその中身を判定する。
`curl`の出力を`sh`に渡す形のように、別のプログラムが渡すコードは、中身を読めないので拒否しない。
コンテナの中でインストーラーを実行する作業を止めないためである。
`bash -`は標準入力から読む形として扱う。
`time`、`command`、`exec`、`env`、`xargs`、`timeout`などの前置きは外してから判定する。
`bash`のほかに、`fish`、`ash`、`mksh`、`tcsh`、`csh`、`busybox sh`も同じように扱う。

秘密値のファイルの判定は、ファイルを読む引数とリダイレクトの先にだけ働く。
検索パターン(`rg mise.local.toml docs`の`mise.local.toml`)と、`sed`や`awk`の式の中の名前は拒否しない。
`find`の`-name`や`-path`などの値も拒否しない。
`ls`、`test`、`[[`、`echo`、`git check-ignore`のように中身を読まないコマンドも、名前を書いて拒否しない。
`process.env`のような識別子と、空白を含む文章は、ファイル名として扱わない。
`rm -rf dist/*`のように`*`だけで終わるglobは拒否しない。
`*.toml`のような秘密値のファイル名に当たりうるglobは、リポジトリの根、`infra`、`.wmill`の中のときだけ拒否する。

再帰的な`grep`と、`-u`や`--no-ignore`を付けた`rg`は、検索の起点がリポジトリの根、`infra`、`.wmill`、またはそれらを含むディレクトリのときだけ拒否する。
`scripts/`のようなサブディレクトリの検索は拒否しない。

`--no-verify`は、フックを実行するgitのサブコマンド(`commit`、`push`、`merge`、`rebase`、`am`、`cherry-pick`、`revert`、`pull`)でだけ拒否する。
`--`より後ろはパスとして扱う。
`git config core.hooksPath`は、値を設定するときだけ拒否する。読むことと`--unset`は拒否しない。

`git push`のブランチを省いたときの今のブランチは、同じコマンド行の前にある文字どおりの`cd`と`pushd`をたどって調べる。
`git -C`、`--git-dir`、`--work-tree`が指すディレクトリも同じように使う。
同じコマンド行の前にブランチを切り替える操作があれば、切り替えた先を今のブランチとする。
対象は`git checkout`、`git switch`、それぞれの`-b`と`-c`と`-t`、`git rebase <上流> <ブランチ>`、`git branch -m`である。
`git rebase`のオプションの値(`-X theirs`、`--onto <先>`など)は、ブランチとして数えない。
`git checkout <名前>`の名前がローカルのブランチなら、切り替え先だけを今のブランチとする。
そうでなければファイルの復元のこともあるので、実際のブランチも候補に残し、どちらかが保護するブランチなら拒否する。
`git rebase --root <ブランチ>`は、最初のオペランドをブランチとする。
`git switch`と`-b`、`-c`は、切り替え先だけを今のブランチとする。
`HEAD`、`@`、`main~2`のような相対の参照は、ブランチを変えないものとして扱う。
次の場合は、今のブランチが決まらないものとして扱う。

- 切り替え先が変数のとき
- `git checkout -`と`git checkout @{-1}`のとき
- `--detach`と`-d`のとき
- `git rebase <上流> <ブランチ>`の`<ブランチ>`が変数のとき

切り替えたブランチは、同じリポジトリの別のディレクトリ(`git -C scripts push`)でも使う。
`;`でつないだ切り替えも、成功したものとして扱う。
移動先が変数のときも今のブランチを調べられないので、そのpushだけを拒否する。
push先に`"$(git branch --show-current)"`を書いたときは、今のブランチとして扱う。
push先のrefspecは、`refs/heads/`と`heads/`を外して`main`、`master`と比べ、`*`を含むものは拒否する。
今のブランチとリポジトリの根を調べるgitの起動は、ディレクトリごとに結果を覚える。
1回の判定で、起動は20回、時間は5秒までに限る。
超えたコマンド行は、分けて実行するよう理由を示して拒否する。

`docker exec`と`docker compose exec`は、環境変数の一覧を出すコマンド(`env`、`/usr/bin/env`、`printenv`)かコードを渡したシェルのときだけ拒否する。
`docker compose exec windmill_worker kill <pid>`のような運用の手順は拒否しない。
`docker inspect`は、`--format`の`{{...}}`がフィールドの経路だけ(`{{.State.Running}}`、`{{json .State}}`)のときだけ拒否しない。
`{{.}}`、`range`、`printf`、`index`のように、オブジェクト全体を出せる指定は拒否する。
経路の区切りに`Env`か`Config`があるものも拒否する(`.HostConfig.Binds`は拒否しない)。
`--format`を複数指定したときは、1つでも拒否する形なら拒否する。
`docker compose config`と`convert`は、出力を絞った形を拒否しない。
絞るオプションは、`--services`、`--profiles`、`--volumes`、`--images`、`--hash`、`-q`、`--no-interpolate`である。

`mise exec`の拒否は、シェルにコードを渡す形と、環境変数の一覧を出すコマンドに限る。
`mise exec node -- env`のように、ツール名の後ろに`--`があるときは、その後ろのコマンドを見る。
名前を指定したツール(`mise exec -- gitleaks`、`mise exec -- wmill`、`mise exec -- bun test`)は拒否しない。
`bun -e`や`python -c`のように、インタープリターにコードを渡す形も拒否しない。
`mise exec -- bash scripts/doctor.sh`のように、スクリプトのファイルを渡したシェルも拒否しない。
この規則はベストエフォートで、`mise exec`経由で秘密値を読む方法をすべては塞げない。
`mise run`のタスクはリポジトリが定義するので、拒否しない。

### 失敗したときの動作

コマンドの意味を判定できないときは拒否する。
字句に分けられないコマンド、push先が実行するまで決まらないコマンド、フック自身の異常終了がこれに当たる。
Claude Codeは終了コード2以外のフックの失敗ではツールの呼び出しを止めないので、`scripts/claude-hooks/run.sh`が失敗を終了コード2に揃える。

実行環境が無いときは、警告を出して通す。
実行環境が無いのは、次の2つの場合である。

- 動くbunも、24以上のnodeも無いとき。依存を入れる前のコンテナが当たる。PATHにあってもshimの中身が無いbunや、24未満のnodeは、動かないものとして扱う
- 起動スクリプトが無いとき。`CLAUDE_PROJECT_DIR`が空のときが当たる

この場合も拒否すると、すべてのBashが止まり、人が復旧できないクラウドのセッションでは作業を続けられない。
`run.sh`は、動くbun、24以上のnode、`$HOME/.bun/bin/bun`、警告して通す、の順に試す。
警告は、終了コード0でも利用者に見えるよう、標準出力のJSON(`systemMessage`)にも出す。
起動スクリプトが無いときの登録コマンドも同じである。
`mise`は経由しない。自動インストールがタイムアウトを超えることがあり、信頼していない設定では動かないためである。
フックが動かない間は、`.claude/settings.json`の拒否ルールだけが残る。
フックは、bunとnodeのどちらでも動く(nodeは型を取り除いて`.ts`を実行できる24以上)。

Claude Codeは、タイムアウトしたフックのツール呼び出しを止めず、通常の権限の確認に進める。
そのため、登録するタイムアウトは10秒にして、処理が長引かないようにしている。
判定は同期の処理で、途中から止められない。
代わりに、gitの起動に回数と時間の上限を置き、gitの1回の実行にも2秒の上限を付ける。
非同期の判定を待つ処理には、8秒で終了コード2の拒否にする上限を付ける。
bunかnodeの起動そのものが止まったときだけ、タイムアウトの扱いになる。

### 拒否された操作を人が実行する

人は、拒否された操作を自分で実行できる。
ローカルのターミナルでは、プロンプトの先頭に`!`を付けると、Claudeを通さずにシェルがコマンドを直接実行するので、フックは動かない。
クラウドのセッションには`!`が無いので、人が別の場所で実行する。
フックをすべて止めるときは、gitignore済みの`.claude/settings.local.json`に`"disableAllHooks": true`を書く。
この設定はすべてのフックを止めるので、必要な間だけにして、済んだら消す。

### 判定しないもの

次の操作は判定できないので、拒否しない。

- 変数に入れたパスやコマンド(`cat "$FILE"`、`"$GIT" push`、`eval $CMD`、`bash -c "$X"`)
- 値が実行時に決まるオプション名(`git push ${X:---force}`など)
- シェルのエイリアスと関数
- `find -exec`、`env -S`、標準入力から名前を読む`xargs`(`git push`と`git commit`を除く)
- `mise`のほかのサブコマンドによる秘密値の出力(`mise env`、`mise config`、`mise hook-env`、`mise en`、`mise direnv exec`、`mise mcp`)
- サブコマンドの前にグローバルオプションを置くと、設定の前方一致の拒否が外れる(`mise -E local env`、`mise -q x -- env`など)
- オプションを前に置いた`mise exec`の内側のシェルの`-c`(`mise -q x -- bash -c 'mise set'`)
- オプションを前に置いた`mise exec`の`-c`と`--command`(`mise -q x -c 'mise set'`)
- オプションを前に置いた`mise exec`の内側に、標準入力やヒアストリングで渡すシェル(`echo 'mise set' | mise -q x -- bash`)
- `mise run`の`-s`と`--shell`、`mise exec`の`-c`の位置と束ねた形、`xargs`から起動する`mise`
- `MISE_UNIX_DEFAULT_INLINE_SHELL_ARGS`などの`MISE_*`の環境変数、`BASH_ENV`や`PATH`の差し替え
- `mise set`のサブコマンドの前に、値を取る隠しオプションを置く形(未知の版で増えたもの)
- `mise set`が、`-E local`を付けずにコミット対象の`mise.toml`へ、`-g`でグローバル設定へ、`--file`で任意のファイルへ書き込む形
- 外すことにしていない前置きのコマンド(`watch`、`flock`、`stdbuf`、`script`、`parallel`、`setsid`、`doas`など)
- スクリプトのファイルの中身
- コマンドを起動するインタープリター(`bun -e`、`python -c`が`git push`を実行する場合など)
- `bash /dev/stdin`や`source <(...)`のように、標準入力や置換から読むシェルのコード
- gitの省略形のオプション(`--forc`など)
- 式の中でファイルを開く操作(`sed`の`r`コマンド、`perl -e`など)
- `cd`やglob、`dd`、`perl -pi`、`find -delete`を使った`.git/hooks`と`.git/config`の書き換え
- `echo ... | cat | sh`のように、間にコマンドを挟んだ標準入力のシェル(直前のパイプの元だけを見る)
- `docker run ... env`のように、新しく起動するコンテナで環境変数を出す操作
- `gh auth token`のように、認証情報を表示するコマンドと、`~/.ssh`やgh CLIの設定ファイルの読み取り
- `mise exec`経由で秘密値を読む方法の一部(ベストエフォートの規則である)
- サブシェルの中の`cd`の範囲(外側にも効くものとして扱う)
- 前置きではない`HOME`と`XDG_CONFIG_HOME`の設定(`export HOME=...`の後のgit、`sh -c`の中のgit)
- 書き方を変えた`/proc/<pid>/environ`(`dd if=/proc/self/environ`、`/proc/self/./environ`、`//proc/...`、`/proc`の再帰的な検索)

フックは誤操作を止める仕組みで、意図した迂回は防げない。

## draw.ioの図の描画

要件定義の図(`<name>.drawio`)は、生のXMLとして、要件定義のファイルと同じworker専用のディレクトリ(`requirement_drafts.doc_dir`の下)に書く。DBの`requirement_drafts.diagrams`列には、`{name, file}`の参照だけを入れる。図の内容とURLは、GitHubのIssueとPRのコメントにも、Discordの通知にも投稿しない。

Consoleは、`f/factory/steps/console_query.ts`の`requirements_doc`ビューで、`requirements.md`と各図のファイルを読み戻す。読む前に、`doc_dir`が`REQUIREMENTS_BASE_DIR`の下にあることを確かめる。図のXMLはWindmillのジョブ結果としてConsoleのフロントエンドに渡るだけで、GitHubとDiscordには送らない。

図のXMLは、`f/factory/lib/drawio.ts`の`validateDrawioXml`で検査する。
検査は2か所でかける。生成の時点と、`requirements_doc`ビューがディスクから読み戻す時点である。
ディスクのファイルは生成の後に書き換わりうるので、読み戻す時点でも同じ検査をかける。
読み戻しで通らない図は、ファイル名が不正な図と同じように、警告のログを残して一覧から落とす。
検査が例外で終わった図も、通らない図として扱い、警告のログを残す。安全と確かめられない図は、表示しないほうを選ぶためである。
文書の本文と、ほかの図は返す。

検査は、大きさ、ルート要素に加えて、次のものを加工せずに拒否する。
拒否したときは`valid: false`と理由を返す。

- 圧縮した図。すべての`<diagram>`について、空白以外のテキストとCDATAを拒否する。`<mxfile>`の`compressed`属性の値が`true`のときも、引用符の種類を問わず拒否する。圧縮した図は中身が見えず、以降の検査を素通りするためである
- `link`属性と`usemap`属性
- `placeholders`属性と、`<mxfile>`の`vars`属性。理由は下にある
- 図の構造としての`<a>`、`<area>`、`<map>`、`<meta>`、`<iframe>`要素
- ラベルのHTMLの、パーサーによって読み方が分かれる構文。大文字小文字を区別しない。
  - `<!`で始まる構文(コメント、DOCTYPE、CDATA、偽のコメント)、`<?`、`</`の後ろが英字でない形
  - 中身をタグとして読まない要素。属性の有無を問わない。
    対象は`<textarea>`、`<title>`、`<xmp>`、`<noscript>`、`<noembed>`、`<noframes>`、`<plaintext>`、`<iframe>`、`<style>`、`<script>`である
  - 外来要素の`<svg>`と`<math>`
  - SVGのアニメーション要素: `<set>`、`<animate>`、`<animateMotion>`、`<animateTransform>`

  理由は、下の「ラベルのHTMLの読み方」にある。
- ラベルのHTMLの、属性付きの次の要素。属性付きとは、`名前=`の形の属性を持つことである。
  - リンク: `<a>`、`<area>`、`<map>`
  - ページ遷移: `<meta>`、`<base>`、`<link>`
  - 埋め込み: `<object>`、`<embed>`、`<frame>`、`<img>`、`<image>`、`<video>`、`<audio>`、`<source>`、`<use>`
  - 送信: `<form>`、`<input>`、`<button>`

  `<image>`は、HTMLのパーサーが`<img>`に置き換えるので、`<img>`と同じに扱う。
  `<iframe>`と`<svg>`は、上の読み方が分かれる構文として、属性の有無を問わず拒否する。
- ラベルのHTMLのタグの中のイベントハンドラ属性。`onclick=`のように、`on`と英字の名前に`=`が続く形である
- ラベルのHTMLの`usemap=`、`formaction=`、`srcdoc=`
- 構文が不正なXML。閉じていないコメント、CDATA、処理命令、タグ、引用符と、タグの引用符の外の`<`である。XML全体を前から1回だけ読み、読めない箇所があれば拒否する。正規表現の打ち切りで、手前までしか検査されずに通ることを防ぐためである

`Promise<Object>`、`List<Map>`、`Result<A, E>`のように、属性を持たない要素名だけの表記は通す。
型の書き方としてラベルに現れ、属性の無い要素は行き先も資源のURLも持てないためである。
`<A extends B = C>`のような表記は拒否することがある。要素名と同じ型引数の名前に`名前=`が続くと、属性付きの要素と見分けられないためである。

図のXMLを加工して取り除くと、図の見た目が変わり、ビューアの解釈との差が新しい抜け道にもなる。
そのため、取り除かずに拒否し、理由を生成のやり直しでClaudeに伝える。

属性の値とテキストは、XMLの実体参照(`&lt;a`、数値文字参照の`&#60;`と`&#x3c;`)を復号してから調べる。
ビューアは`html=1`のラベルをHTMLとして解釈するためである。
二重にエスケープした`&amp;lt;a`も、安全側に倒して復号し、拒否する。実際に何として読まれるかは追わない。
復号は5段までで、それでも変わり続ける値は調べきれないので拒否する。
`placeholders`属性は、どの要素にあっても値を問わず拒否する。`<mxfile>`の`vars`属性も拒否する。
`placeholders`を持つセルでは、draw.ioがラベルの`%名前%`を別の値に置き換える。
置き換える値は、祖先のセルの属性、ページの名前、`vars`に書いた値などである。
タグを置き換え元の値とラベルに分けて書けるので、置き換えた後のラベルを検査では確かめきれない。
要件定義の図には置き換えが要らないので、使うこと自体を拒否する。
要素と属性の名前は、大文字小文字を区別せずに比べる。
`link`と`usemap`は名前の完全一致だけを見るので、`linkTarget`のような別の属性や、ラベルの文章にあるだけの単語は拒否しない。
`<object>`は、draw.ioがセルを包む要素として正しい。構造としては許し、ラベルのHTMLの中の、属性付きのものだけを拒否する。

### ラベルのHTMLの読み方

検査は、ラベルのHTMLのタグを、引用符を読む走査で読む。
`<`に英字が続く開始タグと、`</`に英字が続く終了タグを、HTMLのパーサーと同じ規則で、引用符の外の`>`まで読む。
終了タグも読むのは、HTMLのパーサーが終了タグの属性の引用符も読むためである。
この走査で、イベントハンドラ属性と、属性付きの拒否する要素を探す。
タグの外の文章にある`one = 1`、`online = true`、`https://x/?online=1`は拒否しない。

パーサーによって読み方が分かれる構文を拒否するのは、検査とブラウザがタグを同じ位置で区切る入力だけを通すためである。
HTMLのパーサーは、コメントや`<textarea>`の内側をタグとして読まない。
検査がその内側の引用符を読むと、タグの終わりが検査とブラウザでずれ、本物のタグのハンドラを見逃す。
`<svg>`と`<math>`の内側は、CDATAを読むなど、別の規則で読まれる。
これらの構文が無いラベルでは、ブラウザはタグの外を常に同じ規則で読み、引用符を読む走査と同じ位置でタグを区切る。
SVGのアニメーション要素は、`href`などの属性を後から書き換えてリンクを作れるので、`<svg>`の外にあっても拒否する。

要素名は、後ろに空白、`/`、`>`、文字列の終わりが続くときだけ当てる。
HTMLのパーサーは、それ以外の文字を要素名の続きとして読むので、`Map<Settings>`や`List<Titles>`は通す。
`<title>`は、属性が無くても拒否する。
属性の無い`<title>`でも、閉じるまでの内側をタグとして読まない状態に入るためである。
`Map<title>`のような型の表記は拒否されるので、型の名前を変えるか、文章で書く。
`a < b`のように`<`の後ろが英字でない形は通す。
`x </ y`のように`</`の後ろが英字でない形は、HTMLのパーサーが偽のコメントとして読むので拒否する。

補助として、引用符を読まない走査も行う。
`<`に英字が続く箇所から次の`>`までの区間を、引用符を無視してタグとして調べ、イベントハンドラ属性があれば拒否する。
属性付きの要素も、要素名の後ろから最初の`>`までに`名前=`があれば拒否する。
引用符を読む走査とブラウザで読み方の分かれる入力が、まだ残っていたときに備えるためである。
引用符の中の`>`で区間が切れるので、補助の走査だけでは足りない。

どの走査も、調べ終えた位置の後ろから次を探すので、検査の時間は入力の長さに比例する。
この検査は1層目である。
2層目は、iframeのCSPである。
`script-src`に`'unsafe-inline'`が無いので、検査をすり抜けたハンドラも実行されない。

### 隔離したiframeで描く

ConsoleのSPAは、図を最上位のページでは描かず、隔離したiframeの中で描く。
図のXMLはIssue本文に由来する信用できない入力で、ビューアは第三者の大きなコードだからである。
最上位のページで描くと、ビューアの欠陥が、Windmillを管理者として操作できるXSSになる。
実装は`console/src/components/drawio/DrawioFrame.tsx`と、`console/public/drawio.html`である。
要件定義書の画面(`/console/items/:id/requirements`)が、図ごとに`DrawioFrame`で描く。
安全の検査を通らなかった図(`rejected_diagrams`)は、iframeを作らず、表示しない旨だけを出す。
仕組みは[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

| 守ること | 内容 |
| --- | --- |
| ビューアを同梱する | CDNからは読まない。CIが、版を固定したURLからビューアを取得し、固定のsha256と照合してから、配信物の`drawio/`に置く。照合に失敗すると、CIが止まる |
| 本体から読めない場所に置く | ビューアと受け口は、Console本体のscriptの置き場所`/console/assets/`ではなく`/console/drawio/`に置く。本体のCSPは`/console/assets/`だけを許すので、本体にHTMLが注入されても、信頼されたオリジンでビューアを動かせない |
| 取得元を固定する | 固定する値は`console/drawio-viewer.json`にある。URLはbranchやtagではなくcommitを指す。この固定ファイルと、固定を書き換えるPRを作るscriptとその部品、固定を強制するスクリプトは保護パスで、人のレビューを経ずには変えられない。一覧は[保護パスの変更を止める](#保護パスの変更を止める)にある |
| 不透明なオリジンで動かす | iframeの`sandbox`は`allow-scripts`だけにする。`allow-same-origin`が無いので、iframeはCookieにも、Windmillにも、親のDOMにも届かない。ポップアップと最上位のページの遷移も許さない。`/console/drawio.html`のCSPにも`sandbox allow-scripts`を付け、ページを直接開いても不透明なオリジンで動かす |
| 外への取得をCSPで止める | `/console/drawio.html`だけに、別のCSPを付ける。scriptは`/console/drawio/`の同梱のファイル(ビューアと受け口)に限り、`connect-src`、画像、フォント、フォームの送信先は外を許さない。XMLが外部の画像やフォントを指していても、取得されない |
| XMLを1回だけ送る | 親は、XMLごとにiframeを作り直す。1つのiframeに送るのは、最初のloadの後の1回だけである。2回目のloadは、iframeが別の文書へ遷移したことを表す。親はiframeを`about:blank`にして表示を止め、以後そのiframeのメッセージを受けない。遷移した先へ、次のXMLは渡らない。この停止は最善の努力で、loadが起きない遷移は止められない。その場合も、親が受ける値は、数値と固定の失敗の種類だけである |
| メッセージを絞る | iframeは、親のwindowからの描画の依頼を最初の1回だけ受ける。親は、iframeのwindowからの高さと失敗の種類(固定の3つ)だけを受け、高さは数値に絞って80〜1600pxに収める。256KBを超えるXMLは送らない |
| リンクを開かない | ツールバー、lightbox、図のリンクを無効にする。ページ内のクリックとauxclickの既定の動作は、押された要素を問わず止める |

固定するsha256は、commit固定のURLから取得したバイト列の値である。
版の更新は、[ビューアの更新](#ビューアの更新)で自動のPRにする。
手で上げる手順は[Consoleの配信の仕様](internals/console.md)の「draw.ioの図」にある。

XMLをiframeへ送るときの`targetOrigin`は`"*"`にする。
不透明なオリジンには、送り先のオリジンを指定する方法が他に無いためである。
送るのは図のXMLだけなので、宛先を絞れなくても許容する。

サーバー側で図の`link`属性と`html=1`を落とす処理は入れない。
`validateDrawioXml`は1層目として、リンクを含む図のうち既知の形を拒否する。網羅はしない。
すり抜けた図は、2層目のCSP、sandbox、受け口のscriptとビューアの設定が受け止める。
iframeの中で動くscriptが取れるのは、そのiframeが受け取った図のXMLだけで、リンクを押せず、外への取得はCSPが止める。
`html=1`を落とすと、`<br>`による改行のような正しい図が壊れる。

残るリスクは次のとおりである。

- ビューアの欠陥でiframeの中でscriptが動くと、iframe自身を別のURLへ遷移させ、受け取ったXMLをURLに載せて外のサーバーへ送れる。CSPは、ページの遷移を止められない。
  送った1回のXMLは外へ出せる。
  次のXMLを渡さないので、被害は、そのiframeが受け取った図1枚に限る。
  CookieとWindmillの資格情報には届かない。
- `'unsafe-eval'`は許さない。根拠は、32.4.1のビューアのコードの読解と、ヘッドレスのChromeでの確認である。
  自動で上げた版は、この調査を経ていない。`eval`が要る版は、図が描かれなくなるだけで、CSPが評価を止める。
  - ビューアが`eval`を呼ぶ箇所は2つある。図のスタイルや定義に書かれた式を評価する経路は、評価を許すフラグがどれも既定で無効である。外部の図形ライブラリのscriptを取得して評価する経路は、取得をCSPの`connect-src 'none'`が止める。`new Function`は無い。
  - `'unsafe-eval'`を付けずに、普通の図と、リンク、外部の画像、フォント、図形ライブラリ、評価を許す式を含む図を描いた。`eval`の違反は出なかった。
- 外部の図形ライブラリ(AWSなどのアイコン集)を使う図は、その図形が描かれない。外部への取得をCSPが止めるためである。

### 親の部品が守ること

`DrawioFrame`が、iframeを作る。
iframeとのメッセージは、`console/src/lib/drawioMessages.ts`と`console/src/lib/drawioFrameState.ts`の純関数が扱う。

| 守ること | 内容 |
| --- | --- |
| 不透明なオリジンで動かす | `<iframe src="/console/drawio.html" sandbox="allow-scripts" referrerPolicy="no-referrer">`にする。`srcDoc`は使わない。`allow-same-origin`、`allow-popups`、`allow-forms`、`allow-top-navigation`は付けない。iframeは、WindmillのCookie、親のDOM、最上位のページの遷移、ポップアップ、フォームの送信から切り離される。外への取得は、CSPの`connect-src 'none'`が止める |
| 受け口と値を合わせる | メッセージの種別と失敗の種類は、`console/public/drawio/drawio-frame-*.js`と同じにする。`tests/lib/drawio_frame_isolation.test.ts`が、ソースを文字列として読んで確かめる |
| XMLは1回だけ渡す | 最初のloadの後にpostMessageで1回だけ送る。親は、送り元がそのiframeの`contentWindow`のものだけを受け取り、高さを80〜1600の範囲に収め、失敗は固定の3つの種類だけを受ける。iframeが2回目のloadを起こしたら、遷移とみなして表示を止める |
| 図を拒否する | 上の`validateDrawioXml`が、生成の時点と読み戻しの時点で、リンク、危険な要素、圧縮した図を拒否する |

読み戻しで拒否した図は、`requirements_doc`ビューが名前を`rejected_diagrams`で返す。
本文は、その名前の図を「安全の検査を通らなかったので表示しません」と表示し、図が見つからない場合と区別する。

読み戻しの検査は、すでにディスクにある図にもかかる。検査を通らない図は表示しない。
`link`属性や`<a>`を含む既存の図は、「表示しません」になる。
承認する人は、図を見ないまま判断することになる。
図が判断に要るときは、要件定義の作り直しを求める。

#### sandboxが止められない経路

`sandbox`は、iframeの`window.top.postMessage`と`window.parent.postMessage`を止められない。
ConsoleのSPAの親のページは、iframeから高さと失敗の種類だけを受け、ほかのメッセージの通り道を持たない。
図のscriptが親へ送れるものは、範囲に収めた数値の高さと、固定の失敗の種類に限られる。

#### 保護パス

次のファイルは、保護パスである。

- `tests/lib/drawio_frame_isolation.test.ts`

書き換えられると、sandboxを外したり、別のページをiframeに読ませたりしても、検査を通ってしまうためである。
`DrawioFrame.tsx`は保護しない。
画面の普段の変更を、保護パスで止めないためである。
`sandbox`の値は上のテストが固定し、HTTPのCSP(`infra/Caddyfile`の`drawio_headers`)も後ろ盾になる。
別の部品が`/console/drawio.html`をsandboxなしのiframeで読む迂回は、CSPの`sandbox allow-scripts`が、ページを不透明なオリジンに固定して止める。
`frame-ancestors`は、埋め込める親を、このサイトと同じオリジンのページに限る。

制約は次のとおりである。

- `/console/drawio.html`が配信されていないと、図は描かれない。親は、応答がないものとして固定の文を出す。
- 外部の図形ライブラリ(AWSなどのアイコン集)と、ビューアのtoolbar、ズーム、レイヤは使えない。

残るリスクは次のとおりである。

- ビューアがiframeの中で`window.location`を書き換えて遷移する経路は、`sandbox`で防げない。2回目のloadの検知で表示を止めるが、loadが起きない遷移は検知できない。そのときも、親が受け取るのは、範囲に収めた高さと、固定の失敗の種類だけである。
- ラベルの`%名前%`を別の値に置き換える`placeholders`と`vars`は、検査が拒否する。
  draw.ioが別の属性でも同じ置き換えをするようになると、検査はその図を拒否できない。
  その図は、iframeの隔離とCSPで止める。

実機でしか確かめられない点は次のとおりである。

- 図が描かれ、高さが図に追従すること。
- リンクを含む図を描いても、クリックで遷移しないこと。

### ビューアの更新

固定は、Windmillの`f/factory/drawio_viewer_bump`が週に1回確かめ、新しい版があればPRにして上げる。
GitHub Actionsではなく、Windmillで動かす。
ActionsでPRを作るには、PRに書ける長期のトークンをActionsのsecretに足す必要があるためである。
Actionsの既定のトークンで作ったPRは、CIを起動しない。
このリポジトリは、`ci.yml`の権限を読み取りだけに保つ。
Windmillは、実装とPR修正が使う`f/factory/github_token`で足りる。このトークンはWorkflowsの権限が無いので、`.github/workflows/`には書けない。

| 守ること | 内容 |
| --- | --- |
| 取得元を絞る | 公式のjgraph/drawioのGitHubのリリースだけを読む。下書きとプレリリースは読まない。タグが指すcommitは、GitHubのAPIでたどって決める。ビューアのURLはcommit固定で、リダイレクトは許さない |
| 2つの時計で待つ | 公開日(`published_at`)から14日以上たち、かつ、同じcommitを14日以上前から見ている版だけを上げる。公開日はリリースを作る側が書き換えられるので、それだけを根拠にしない。見始めた時刻は、タグごとにDBの`factory.drawio_viewer_observations`へ記録する。記録は、Factoryの通常の経路からは書き換えない。DBを直接触る変更(migration、WindmillのSQL)は、この保護の外にある |
| 付け替えで待ちを数え直す | タグが別のcommitに付け替えられたら、記録の時刻を今に取り直す。付け替えた版は、取り直した時刻から14日待つ |
| 正式版から数える | プレリリースは読まず、記録もしない。プレリリースから正式版に切り替わった版は、正式版として初めて見た時刻から14日を数える |
| メジャー版に目印を付ける | メジャー版が変わる版も、他の確認を通ればPRにする。固定のファイルは保護パスで、マージは人が行うため、メジャー版で止めても安全は増えない。題名を`[major]`で始め、本文の先頭に、リリースノートとCSP、sandbox、図の隔離のテスト(`drawio_frame_isolation`)の確認を人が行うと書く |
| 大きさの急変を上げない | 今のビューアの大きさから2割を超えて増減した版は上げない。noticeに残し、人が版を指名したときだけ上げる。空のファイルと、CIの取得の上限(10MB)を超えるファイルは、指名しても上げない |
| 2つの経路で照合する | 取得したバイト列の大きさとgit blobのIDを、GitHubのAPIが返す同じcommitのファイルの値と照合する。違えばPRを作らず、noticeに残す。sha256はこのバイト列から計算して固定ファイルに書く。CIは別の経路(`raw.githubusercontent.com`)で取得し直して照合する |
| 書き込みを絞る | PRのブランチを1つ作るだけで、`main`には書かない。変えるのは固定のファイルと、ビューアを読むページ(`console/public/drawio.html`)の2つだけである。commitの名義はGitHubのnoreplyにする |
| 重複を作らない | 同じ版のブランチをheadにしたPRが、閉じたものを含めて1件でもあれば、ブランチが消えていても作らない。未完了の更新のPRがあるあいだも、新しいPRを作らない。数えるのは、このリポジトリのブランチをheadにしたPRだけで、forkに同じ名前のブランチを作られても更新は止まらない |
| 既存のブランチを確かめる | PRの無いブランチが既にあれば、先頭のcommitを1回だけ取り、そのcommitに対して確かめる。各ファイルのgit blobのIDが作るはずの内容と一致し、`main`との差分がその2ファイルだけで、名前の変更を含まないことを確かめる。合わなければPRを作らず、noticeに残す。PRを作った後に、PRのheadのcommitが確かめたcommitと同じかを確かめ、違えば自動レビューのラベルを付けずに止めて、noticeに残す |
| 自動でマージしない | PRはDraftにせず、自動レビューのラベルを付ける。マージは人が行う |
| 修正を人に限る | ブランチ名が`factory/drawio-viewer-`で始まるPRには、PR修正を始めない。修正の準備のステップも止める。修正を許すと、固定のファイル以外も書き換えたcommitを、人が気づかずにマージするおそれがある。自動レビューは動く。`factory:fix`ラベルは消費されず残る。修正は人が行う。判定はブランチ名だけで行うので、`factory_repo`に限らず、担当するすべてのリポジトリのPRに効く |
| 部品を保護パスにする | 更新のscript、判断、GitHubの読み取り、観測の記録、scriptとスケジュールの定義を保護パスにする。書き換えられると、別の版や取得元の更新を人の確認なしに提案できるためである。一覧は[保護パスの変更を止める](#保護パスの変更を止める)にある |

更新のPRは、通常のCIを通る。
`console`ジョブが固定のURLからビューアを取得してsha256を照合し、`public-assets`のテストがページの参照と固定の一致を、CSPと図の隔離のテストが設定を確かめる。

残るリスクは次のとおりである。

- 新しい版が図を描けるかは、自動では確かめない。描けない版は、iframeが固定の失敗の文を出す。PR本文が、マージ後にConsoleで図を開いて確かめるよう求める。
- 上流のリポジトリが侵害され、2つの待ちと大きさの確認をすり抜けた版は、PRになる。マージの前に人が見る。マージ後も、iframeの隔離とCSPが被害を限る。
- 観測の時刻は、こちらが見た時刻である。公開日を古く偽られても、こちらが初めて見た時刻から数えるので、14日の待ちは回避されない。
- 観測は週に1回なので、観測の間にタグを付け替えて元に戻されると、気づけない。
- 最初に動かした週は、すべての版の観測が始まったばかりなので、14日間は何も上げない。記録が消えたときも、同じように待ちを数え直す。
- 上げる版に選んだ最新の版を保留している間は、それより古い版も上げない。保留の理由はnoticeに出る。
- 保護するのは更新に専用の部品である。汎用の層(`github.ts`、`db.ts`、`types.ts`、`workspace.ts`)は保護していない。更新はこれらの関数を呼ぶので、挙動を変える変更は通常のレビューで確かめる。
- script定義とlockのうち、`drawio_viewer_bump.script.lock`と`lib/drawio_viewer_observations.script.lock`は保護しない。`windmill-client`の版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。部品のscript定義を保護し、部品の依存の無いlockを保護しない(理由は[保護パスの変更を止める](#保護パスの変更を止める)の「libのlockを保護しない理由」)。
- ブランチ名が`factory/drawio-viewer-`で始まる未完了のPRが残ると、更新は止まる。そのPRを閉じるかマージすると、次の週に再開する。

## 要件定義書のリンク

要件定義書のMarkdownは、Issueの内容に由来する。
Consoleは、これをWindmillと同じオリジンで描く。
`rehype-sanitize`の既定のスキーマは`javascript:`などを除くが、任意の`http(s)`のURLの`a[href]`は通す。
そのため、読み手がリンクの文字を信じて、外のページを開くおそれがある。

`src/components/markdown/Markdown.tsx`は`a`を差し替える。
リンクにするものは、`src/lib/markdownLink.ts`の`resolveMarkdownLink`で絞る。

- 作業項目と同じリポジトリのIssueとPRのURL。`src/lib/safeUrl.ts`の`safeGitHubUrl`を通り、ownerとrepoが作業項目のものと一致するものに限る。ownerとrepoは、大文字小文字を区別せずに比べる。信頼できない本文が、読み手を別のリポジトリへ誘導できないようにするためである。
- 同じページの見出しへのフラグメント。`#`で始まり、`slugify`が作るslugと同じ形に限る。

それ以外は、リンクにせず文字で出す。
リンクの文字とURLが違うときは、URLも括弧で添える。
読み手が行き先を判断できるようにするためである。
添えたURLは`<bdi>`で包む。文字の向きを変える制御文字が、周りの表示を崩さないようにするためである。
同じページの見出しへのリンクは、行き先を取り違えようがないので、URLを添えない。
GitHubへのリンクは、`rel="noopener noreferrer"`を付けて新しいタブで開く。

`Markdown`が`repo`を必須の引数で受けるので、リポジトリを渡さずにGitHubのURLをリンクにする経路は無い。
見出しへのフラグメントは、接頭辞`h-`を付けた見出しの`id`を指すように読み替える。
見出しの`id`が、ページの他の要素の`id`や`name`と重ならないようにするためである。
脚注の記法は使わない。脚注への参照(`#user-content-fn`で始まるフラグメント)は、リンクにせず文字で出す。
本文、要約、未確定事項、題名は、描く前に`displayableIssueText`で見えない文字を置き換える。
画像は図の参照`<name>.drawio`だけを無害化のスキーマで通し、それ以外の画像のURLは描かない。
`src/components/markdown/Markdown.test.tsx`が、次のものを描かないことを固定している。
生のHTML、外のリンク、別のリポジトリのリンク、`javascript:`のリンク、外の画像である。

### 監査レポートの本文

新しいConsoleの監査レポートの本文(`console/src/screens/reports/AuditMarkdown.tsx`)は、リンクを張らない。
本文は、監査のClaudeが信頼できない運用記録から書くためである。
監査レポートの本文にはURLを書かない決まりで、リポジトリの情報も渡されないので、張ってよいリンクが無い。
同じページの見出しへのリンクも張らない。見出しに`id`を付けないので、行き先が無い。

リンクの文字はそのまま文字で出し、URLが文字と違うときは括弧で添える。
添えたURLは`<bdi>`で包む。
画像は読み込まず、「画像は表示しません」と出す。
外のURLを読み込むと、レポートを開いただけで外へ通信が出るためである。
本文の生のHTMLは、`rehype-raw`を使わないので要素にならず、描かずに捨てる。
`rehype-sanitize`の既定のスキーマは、変換後の要素と属性を絞る二重の防御である。
描く前に`displayableIssueText`で見えない文字を置き換える。

## 更新履歴のPR

Consoleの更新履歴は、反映に含まれるPRの題名と番号を出す。
FactoryのPRの題名は、信頼できないIssueに由来する。
題名は、マージのコミットの本文として`self_update`が読み、`deployments.pull_requests`に記録する。
そのため、記録から画面までの各段で、値の形を確かめ直す。

| 段 | 守ること |
| --- | --- |
| 取り出し | self cloneの`git log --first-parent`だけを読む。PRのブランチの中のコミットが、件名でマージのコミットを装えないようにするためである。件名`Merge pull request #<N> from <owner>/<branch>`は、親が2つ以上のコミットだけを読む |
| 取り出し | 題名は本文の1行目だけを取る。制御文字、書字方向の制御文字、幅の無い空白などの見えない書式文字、タグ文字を空白にし、200字で切る。ZWJとZWNJは、絵文字の列や一部の文字の題名が崩れるので残す。題名は表示だけに使い、承認の判断には使わない。この処理は`sanitizePullRequestTitle`で、読み出しでも同じものを通す |
| 取り出し | リンクは、Factoryのリポジトリから`https://github.com/<owner>/<repo>/pull/<N>`の形に組み立てる。GitHubのAPIは呼ばない。呼ぶと、Console用のworkerのネットワークとトークンの権限が広がる |
| 読み出し | `console_query`が、番号が正の整数であること、URLがPRのURLの形であること、題名を`sanitizePullRequestTitle`でもう一度通す(取り出しと同じ文字を空白にし、200字で切る)。形が違う要素は捨てる |
| 画面 | 題名は文字としてだけ描く。リンクにするのは、GitHubのPRのURLの形で、末尾の番号がPRの番号と一致するものだけである。それ以外は番号を文字で出す |

作り手のバッジは、確かな証明ではなく、ブランチの名前から決めた印である。
ownerがFactoryのリポジトリと同じで、ブランチが実装ブランチ(`factory/issue-<N>-wi-<id>`)のときだけ「Software Factory」にする。
同じ名前のブランチを作れるのは、リポジトリに書ける人だけである。forkのブランチは「人」になる。
マージの方式がsquashのPRと、Factoryのリポジトリを読めないときは、ブランチが確かめられないので「不明」にする。

mainに直接pushされたコミットも、件名の末尾が`(#<N>)`で親が1つなら、PRとして記録される。
記録は表示のための印で、PRの実在は確かめない。
mainのrulesetが直接pushを止めていることを前提にする。

## PR修正の安全策

PR修正のフロー(`pr_fix`)は、Claudeに書き込みのツールを与える。次の安全策で、信頼できないPRの内容やコメントから、Factoryの設定やworkerを書き換えられないようにする。仕組みの詳細は[PRワークフローの仕様](internals/pr-workflow.md)にある。

### Factory自身の投稿の判定

コメントがFactory自身の投稿かどうかは、投稿者がFactoryのGitHubアカウントであり、かつ本文にFactoryのマーカーがあるかで判定する。Factoryは人と同じGitHubアカウントで動くので、ログインだけでは人の投稿と区別できない。マーカーだけでは第三者が偽装できる。

この判定で除外するのは、Factory自身のPR修正の返信だけである。人のコメントと、Factoryの最初のレビューの指摘は、修正の依頼として扱う。

### ツールの制限

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。`--restricted`でコード実行のツールとWebFetchを外し、ファイルのツールを作業ディレクトリに閉じる。ネットワークは遮断しない。

### 検査コマンドはフローが実行する

対象リポジトリのlintやテストは、Claudeではなくフローのステップが`factory_config`の`allowed_check_commands`として実行する。
実装フローは、`check_commands_by_repo`に明示したコマンドを実行する。
検査コマンドは対象リポジトリのコードを実行するので、workerのrootではなく、非特権のユーザー(`factory-check-N`)で動かす([検査コマンドの権限](#検査コマンドの権限))。
ただしコンテナ、network、CPUとメモリはworkerと共有する。
そのため既定値は空の配列にし、空でなければ、コンテナの分離が無いことを知らせる記録(notice)を作業項目ごとに残す。
同じ本文の未解決の記録があれば新しく作らない。作成から1日を過ぎていれば、時刻を更新する。

検査コマンドに渡す`PATH`は固定の`/usr/local/bin:/usr/bin:/bin:/usr/local/go/bin`で、workerの`PATH`は引き継がない。
どのディレクトリもrootが所有し、非特権のuidは書き込めない。
rootのホームと`/tmp`の下は入れない。そこに置かれた実行ファイルを、名前の解決で拾わないようにするためである。

### 検査コマンドの権限

検査コマンドは、実uidと実gidを検査用のユーザー`factory-check-N`にして実行する。
対象リポジトリのコードから、workerの秘密と、workerが後で実行するファイルを守るためである。
実装は`f/factory/lib/check_runner.ts`と`f/factory/lib/check_sandbox.ts`にある。

検査用のユーザーは複数ある(枠)。
実行ごとに、空いている枠を1つ取り、終わったら手放す。
枠が複数あるのは、片付けられず飛ばした枠の代わりを取れるようにするためである。
workerの同時実行数が増えても、並行して動く検査どうしが同じuidを共有しないための備えにもなる。
枠の数は`FACTORY_CHECK_POOL_SIZE`で、既定は8である。
workerの同時実行数(nativeでないworkerは1)に、片付けられず飛ばす枠の分を足した数以上にする。
先頭のuidは`FACTORY_CHECK_UID`で、既定は10001である。
どちらもイメージのビルド引数で、`mise.toml`の`[env]`が値を持つ。
ジョブにはworkerの環境変数がほとんど渡らないので、scriptは`/etc/passwd`の`factory-check-N`から枠のuidを読む。
読んだuidが1000未満(rootを含む)なら、検査を始めずに失敗させる。

| 守るもの | 仕組み |
| --- | --- |
| 権限 | `setpriv`で、実uidと実gidを枠のuidにし、補助グループを実行ごとの目印の1つだけにし、ケーパビリティの上限と継承を空にし、`no_new_privs`を立てる。setuidのバイナリやファイルのケーパビリティで特権を戻せない |
| プロセス数 | `setpriv`の前に`prlimit`で、枠のuidが持てるプロセス(スレッドを含む)を256までにする。カーネルは実uidごとに数えるので、検査が上限まで使っても、workerのコンテナのpidsの上限(1024)の内に検査の外の分が残る([プロセス数の上限の決め方](#プロセス数の上限の決め方))。後始末の`kill`は上限を付けずに起動するので、上限に達した枠のプロセスも止められる |
| 並行する検査 | 枠ごとにuidが違うので、並行して動く別の検査があっても、そのworktreeとHOMEに書き込めない。枠は`/var/lib/factory/check-slots`のロックファイル(`flock`)で取る。ロックを持つプロセスの標準入力のパイプが閉じると解放されるので、ジョブが殺されても枠は塞がったままにならない |
| 枠の使い回し | 枠は、後の実行で別のリポジトリの検査に使う。枠を取るたびに、前の実行が残したプロセス、所有権、HOME、共有の一時ディレクトリのファイル、System VのIPCを消してから使う([枠の記録と片付け](#枠の記録と片付け)) |
| 環境変数 | 許可リストの`PATH`、`HOME`、`TMPDIR`、`LANG`と、worktreeだけを`safe.directory`にするgitの設定(`GIT_CONFIG_COUNT`など)だけを渡す。workerの環境変数は1つも引き継がない。`TMPDIR`は`HOME`の下の0700のディレクトリである |
| workerの秘密 | 別のuidのプロセスは、rootのプロセスの`/proc/<pid>/environ`とfdを読めない。`DATABASE_URL`や`WM_TOKEN`などの環境変数と、0600のファイルに届かない。枠のロックファイルと記録のディレクトリは0700である |
| worktreeのロック | worktreeのロックファイルは0600で、検査用のユーザーは開けない。flockは読み取りで開いたファイルにもかけられるので、開けるとロックを握ってworktreeを塞げるためである |
| 書き込める場所 | worktree、実行ごとの`HOME`、共有の一時ディレクトリ(`/tmp`、`/var/tmp`、`/dev/shm`、`/dev/mqueue`、`/run/lock`)である。main cloneの`.git`、worktreeの隣、システムのディレクトリ、`/var/lib/factory`には書けない。ベースのイメージが誰でも書けるようにしている`/usr/src/app`(Windmillの実行ファイルと共有ライブラリの置き場)と`/tmp/.cache`は、イメージのビルドで、中のファイルも含めてグループとその他が書けないようにする。共有の一時ディレクトリそのもののほかに、誰でも書けるファイルかディレクトリがあれば、ビルドを失敗させる |
| Windmillの実行時のディレクトリ | `/tmp/windmill`の下の`cache`などは、Windmillが誰でも書き込める権限(0777)で作る。rootのworkerが実行する依存のバンドルを検査用のユーザーが差し替えられないよう、検査の前に`/tmp/windmill`を所有者以外が入れない権限(0700)にする |
| 後始末 | コマンドごとと実行の最後に、枠のuidのプロセスをSIGKILLで止める。止まらないプロセスが残れば、所有権を戻さずに失敗させる。実行の最後には、共有の一時ディレクトリとIPCからも枠のuidのものを消す |
| イメージと実行時の前提 | 準備の最初に、後始末が呼ぶ道具(`setpriv`、`prlimit`、`find`、`chown`、`chmod`、`flock`、`rm`、`ipcrm`、`kill`、`getfacl`、`setfacl`)と、枠のuidの`factory-check-N`がイメージにあるかを確かめる。誰でも書けるものが無いことも確かめる([誰でも書き込めるものの探し方](#誰でも書き込めるものの探し方))。満たさなければ、所有権と枠の記録のどちらにも触れずに止まる |

実行の順序は次のとおりである。

1. イメージと実行時の前提を確かめる。満たさなければ止まる。
2. `/tmp/windmill`を0700にする。
3. 空いている枠を取る。全部埋まっていれば、2秒おきに取り直し、最大5分待つ。待っても取れなければ「検査の枠が空かない」という失敗にする。
4. 枠を片付ける。片付けられなければ、その枠を手放し、noticeを残して次の枠を試す。
5. 枠の記録に、worktreeと`HOME`のパスを書く。
6. worktreeと`HOME`のうち、rootが所有するものを枠のuidに渡す。
7. コマンドを、worktreeのロック(`flock`)の下の`prlimit`と`setpriv`で実行する。コマンドごとに、残ったプロセスを止める。
8. 枠のuidのプロセスがいないことを確かめてから、worktreeの所有権を取り戻す。
9. `HOME`を消し、共有の一時ディレクトリとIPCから枠のuidのものを消し、枠の記録を消して、枠を手放す。

待つのは、同時実行が枠の数を超えても開発を止めないためである。
実行を直列にはしない。

1で止まったときの理由は、イメージの問題なら`worker image is stale: run mise run up`で始まる。
稼働中のworkerの問題なら`worker runtime is unsafe for checks:`で始まる。

1でイメージの前提を確かめるのは、`f/`の変更がイメージの作り直しより先に反映されても、開発を止めないためである。
前提を確かめずに進むと、古いイメージに無い`getfacl`で取り戻しが失敗し、記録と所有権が残る。
次にそのworktreeを使う準備も同じ失敗で止まり、枠が1つずつ飛ばされて、すべての検査が失敗する。
実装とPR修正の準備のステップも、検査コマンドがあれば、Claudeを動かす前に同じ前提を確かめる。
前提を満たさずに止まった実行は、検査の失敗として数えず、ラウンドも記録しない。
PR修正の完了のステップが、commitの前に同じ理由で止まったときも、ラウンドを記録しない。
実装は人の対応待ち、PR修正は`blocked`で止まる。
イメージの問題なら、要対応の通知`host_action_required`で`mise run up`を求める([運用](operations.md#fとworkerのイメージを両方変えたとき))。
稼働中のworkerの問題なら、要対応の通知`check_runtime_unsafe`で、パスを閉じるか、workerのコンテナを作り直すよう求める([運用](operations.md#稼働中のworkerが検査の前提を満たさないとき))。
確かめた結果は、1回の実行の間だけ覚える。

9で共有の一時ディレクトリを消し切れなくても、検査は失敗にしない。次にその枠を取る実行が、4で消し直すためである。
9で消すのは、番号の大きい枠が次に使われるまで、検査の残したファイルを共有の場所に長く置かないためである。

#### 誰でも書き込めるものの探し方

前提の確かめは、`find`で`/`と`/dev/shm`からたどり、誰でも書き込めるもの(symlinkを除く)を探す。
ほかのマウント(`/proc`、ボリューム)には入らない。
`/dev/shm`は`/`と別のファイルシステムなので、`/`からはたどれず、起点に足す。
rootのジョブがそこに誰でも書けるディレクトリを作ると、`/tmp`の下と同じく、検査用のユーザーが名前を差し替えられるためである。
`/dev/mqueue`は見ない。ディレクトリを作れないファイルシステムで、共有の一時ディレクトリの下ではディレクトリだけを数えるためである。
ボリュームのマウントポイントそのものは見るので、`/workspaces`と`/var/lib/factory`はrootの0755にしておく。
誰でも書ける権限にすると、検査のたびに止まる。
ボリュームの中は見ないので、そこに残ったものは、導入のときに人が確かめる([前提と残るリスク](#前提と残るリスク))。
`/tmp/windmill`の下は見ない。検査の前に、所有者だけが入れる権限(0700)へ変えるためである。

共有の一時ディレクトリ(`/tmp`、`/var/tmp`、`/run/lock`、`/dev/shm`)そのものは数えない。
その下では、rootが所有し、stickyでない、誰でも書き込めるディレクトリだけを数える。
検査用のユーザーが、rootの使う名前のファイルを差し替えられる場所になるためである。
枠のuidのものは数えない。枠を取るたびに消すためである。
ただし、`/tmp/.cache`とその下では、この緩和を当てず、ファイルも含めて数える。
ベースのイメージが開いている場所で、新しいイメージはビルドで中のものまで閉じるためである。

見つかったものが`/usr/src/app`か`/tmp/.cache`のディレクトリそのものなら、イメージの問題とする。
ベースのイメージで誰でも書けるのは、この2つのディレクトリそのものだけで、下のものは閉じているためである。
新しいイメージは、ビルドで2つのディレクトリを閉じ、念のため下のものからも書き込みの権限を落とす。
それ以外は、ビルドが同じ確かめをするので、稼働中にできたものとして、実行時の問題とする。
2つのディレクトリの下にあるものも、実行時の問題とする。
イメージの問題の通知は`mise run up`の後に自動で解決されるので、稼働中にできたものをそこに混ぜると、閉じないまま通知が消えるためである。
2つのディレクトリの下にも誰でも書けるものを置く別のベースのイメージでも、検査は実行時の問題として止まる。
イメージの問題と実行時の問題が一緒に見つかったときは、両方の通知を残す。
走査がタイムアウトしたとき、`find`が0と1以外で終わったとき(シグナルでの終了を含む)、起動できなかったときも、実行時の問題とする。
途中までの結果では、見落としが無いとは言えないためである。
終了コードの1は、走査の間にエントリが消えると起きるので、出力で判断する。

走査の上限は300秒である。
稼働中のworkerで測ると、約5万7千のエントリをたどる走査が、`docker exec`の起動を含めて0.1〜0.4秒で終わった。

#### 所有権の受け渡し

所有権を渡すときは、symlinkをたどらない。
`find -P`はsymlinkに入らず、`chown -h`はsymlink自身の所有者を変える。
`-execdir`は、見つけたエントリの親ディレクトリを起点に`./名前`だけを渡す。
列挙と変更の間に、親のパスがsymlinkに差し替えられても、worktreeの外のファイルの所有者は変わらない。
ハードリンクが2つ以上あるファイルは渡さない。
worktreeの外のファイルへのリンクの所有者を変えないためである。
渡さなかったファイルはrootの所有のままで、検査コマンドは書き換えられない。

ハードリンクのあるファイルが無ければ、`chown -R -P -h --from=0:0`で一括して渡す。
`chown -R`も`fts`でfdを起点に降り、symlinkをたどらないので、差し替えへの強さは変わらない。
渡す時点では、枠のuidのプロセスは動いておらず、木はrootの所有で、列挙の間に差し替える者がいないためである。
ディレクトリごとに`chown`を起動する方法は、9,091個のディレクトリで約7秒、一括は約0.06秒だった(workerのイメージで測定)。
一括ではハードリンクのあるファイルを除けないので、1つでもあれば、ディレクトリごとの方法で渡す。
ハードリンクの確認と受け渡しは別のコマンドなので、その間にハードリンクを作られる窓がある。
前提は、渡す時点で枠のuidのプロセスが動いておらず、ほかの非特権のユーザーもこのworktreeに書けないことである。
一括の`chown -R`は、worktreeの下の別のファイルシステムにも入る。
ハードリンクの確認も`-xdev`を付けずに、同じ範囲を見る。
前提は、worktreeの下にマウントが無いことである。
マウントを作れるのはrootだけなので、検査コマンドは作れない。

`node_modules`は渡す対象から外さない。
検査コマンドは先頭で依存関係をインストールするので、検査用のユーザーの書き込みが要るためである。

#### 所有権の取り戻し

取り戻しは次の4段で行う。
rootは権限のビットを変えず、権限のビットは枠のuidとして落とす。
rootの`chmod`はコマンドラインのsymlinkをたどるので、差し替えられると任意のパスの権限が変わるためである。
rootが行うのは、`chown`と、後で述べるACLの削除だけである。
`chown -R`は受け渡しと同じく`fts`でfdを起点に降り、symlinkをたどらない。
一括の戻しは、1から3の後に行う。
木のほとんどが枠のuidの所有になっているので、ディレクトリごとに`chown`を起動すると時間がかかるためである。
一括の戻しの後に残るのは、ほかのユーザーのごく少数なので、ディレクトリごとの戻しは短く終わる。

1. rootで、枠のuidのものでないディレクトリすべてと、ほかの非rootのユーザーのものを、枠のuidに集める。書き込みかsetidのビットが立った、rootの単独のファイルも集める。
2. 枠のuidとして、所有者が入れないディレクトリを開ける。
3. 枠のuidとして、グループとその他の書き込みと、setuidとsetgidのビットを落とす。
4. rootで、枠のuidのものを`chown -R -P -h --from=<枠のuid>`で一括して戻し、続けて、残ったrootでないものをすべてrootに戻す。

1で集めるものには、検査が誰でも書けるようにしたディレクトリへ、並行して動く別の枠の検査が置いたものも含む。
取り戻した後も、rootでないものか、書き込みかsetidのビットを持つものが残っていれば、失敗にする。
並行して動く別の枠のプロセスが、途中で書き足したときに起きる。

ハードリンクは、リンク先のファイルがworktreeの外にあっても、同じファイルとして扱う。
非rootのファイルは、リンクの数によらず1で集め、最後にrootの所有になり、書き込みのビットも落ちる。
worktreeの外の同じファイルも変わるが、リンクを作れるのは、そのファイルを所有するか読み書きできるユーザーだけである(`fs.protected_hardlinks`)。
そのため、変わるのは、リンクした枠がもともと書き換えられたファイルに限られる。
rootのファイルは、リンクが1つのものだけを集める。
worktreeの外のrootのファイルの権限を変えないためである。
検査が書き込めるrootのファイルへリンクすると、そのリンクは書き込めるまま残るので、確かめで見つけて失敗にする。
書き込めるファイルをworktreeに残したまま、rootが後で読み書きしないためである。

続けて、拡張のACL(名前付きのエントリと、ディレクトリのデフォルトのACL)が残っていないかを`getfacl`で確かめる。
確かめは、先に`getfacl -R -P -s -p`の1回で行う。
終了コードが0で標準出力と標準エラーが空のときだけ、ACLが無いものとする。
失敗、タイムアウト、出力があるときは、ディレクトリごとの確かめを正とする。
ディレクトリごとの確かめは、`find -execdir`で各ディレクトリの中から、名前だけで`getfacl`を呼ぶ。
`getfacl -R`はパスを組み立てるので、パスの長さがPATH_MAXを超えるエントリがあると失敗する。
失敗するとき、終了コードは1である。確かめた木(ACLを付けたエントリがどちらもPATH_MAXより深い位置にある)では、標準出力も空だった。
PATH_MAXを超える木で、終了コード0かつ出力なしになる例は、確かめた範囲では無かった。
一括が失敗したときは、出力の有無によらず、ディレクトリごとの確かめに戻る。
そのため、パスが長すぎる木を、一括の確かめで「無い」とみなすことは無い。
一括は見つけたが、ディレクトリごとの確かめでは見つからなかったときは、無いものとして通す。
一括の出力は、ディレクトリごとの確かめを行う合図にすぎず、ACLの有無はディレクトリごとの確かめが決めるためである。
確かめた事実は[取り戻しのACLの一括確認が頼る挙動を確かめる](operations.md#取り戻しのaclの一括確認が頼る挙動を確かめる)にある。
ACLは`chown`と`chmod`では消えない。
検査がディレクトリに`o::rwx`のデフォルトのACLを付けたまま残ると、後でrootが作るファイルに、ほかの枠から書ける権限が付くためである。
ACLはファイルの所有者が付けられ、ケーパビリティは要らない。
残っていれば、rootで`setfacl -b -k`を`find -execdir`から実行して消し、権限のビットとACLをもう一度確かめる。
ACLの確かめ直しも、一括を先に行い、失敗、タイムアウト、出力があるときはディレクトリごとの確かめを正とする。
rootが消すのは、すべてrootの所有で、グループとその他が書き込めない状態を確かめた後だけである。
その状態では、ほかのユーザーがエントリをsymlinkに差し替えられないので、rootの変更がworktreeの外に及ばない。
`setfacl -b`は権限のビットを変えず、グループのビットはマスクの値のまま残る。
ACLの無いファイルシステムでは、`getfacl`は何も出さないので、`setfacl`は呼ばない。
消した後もACLか書き込めるものが残れば、失敗にする。

失敗したときは枠の記録が残り、次にその枠を取る実行が取り戻し直す。

#### 検査が置いたsymlinkの検出

検査が置いた、worktreeの外を指すsymlinkは、取り戻しの後も残る。
取り戻しはsymlink自身の所有者をrootに戻すだけで、消さないためである。
rootで動く修正のClaudeが、次のラウンドでそのsymlinkをたどって`Edit`か`Write`をすると、worktreeの外に書きうる。
そのため、取り戻しの後に見つけて消す。

検出は、一覧の書き出し、一覧の大きさの抑え、一覧の欠けの検出、名前と中身の扱いと走査、パスで読めないsymlink、消す動作と失敗の扱いの順に行う。

##### 一覧の書き出し

一覧は、`find -P`の`-fprint0`で、rootだけが入れる一時ディレクトリのファイルに書き出す。
標準出力に出すと出力の上限で省かれうるので、ファイルに書いて全件を受け取る。

一時ディレクトリは、枠の記録のディレクトリ(rootの0700)の下に、枠ごとに決まった名前(`slot-N.links`)で作る。
使う前に同じ名前の残りを消してから`mkdir`で作り、読んだ後にもディレクトリごと消す。
取り消しやworkerの再起動で消されなかった残りを、次にその枠を取る実行が片付けるためである。
枠を持たずに走査するときだけ、ランダムな名前にする。
親をrootだけが書ける場所にするのは、共有の`/tmp`のように親を差し替えられる場所だと、書き込み先を差し替えられるためである。

##### 一覧の大きさの抑え

一覧の大きさは、書き込みと読み込みの2段で抑える。

- 書き込みでは、`find`に`prlimit`の`--fsize`を付け、書けるファイルの大きさを128MiBまでにする。
  超えて書こうとすると、`find`は失敗する。
  `prlimit`には`--core=0:0`も付け、制限で止められた`find`がコアダンプを書かないようにする。
  - 書き込み量の制限で`find`が失敗したときも、出力ファイルが64MiBを超えていれば、読み込みの上限と同じく不完全として扱う。
    異常に大きい木で作業項目が停止し続けないためである。
    このとき、`find`の失敗について、秘密値をマスクした先頭1行をログに残す。
  - それ以外の`find`の失敗は、例外にして作業項目を停止する。
- 読み込みでは、読む前に`stat`で大きさを見て、64MiBを超えていたら読まずに、検出が不完全だったものとして扱う。
  読んだ後のBufferと文字列と配列が同時に生きるので、メモリを抑えるためである。
  一覧を読めなかったときも、検出が不完全だったものとして扱う。

##### 一覧の欠けの検出

`find`の終了コードだけに頼ると、一覧の後半が黙って欠け、外向きのsymlinkを見逃す。
そのため、欠けは次の2つで見つける。

- 末尾の確認では、読んだ一覧が空でなく、末尾が`\0`でなければ、途中で切れているとみなす。
  最後の断片は名前として扱わず、検出が不完全だったものとして扱う。
- 件数の突き合わせでは、`find`が`-printf .`で、見つけたsymlinkごとに標準出力へ1バイトを出す。
  この数と、一覧の名前の数が違えば、検出が不完全だったものとして扱う。
  標準出力が上限で省かれたときも同じである。

##### 名前と中身の扱いと走査

- 名前と中身は、バイト列のまま扱う。
  `\0`で区切り、`readlink`と`realpath`と`unlink`には、バイト列のパスをそのまま渡す。
  UTF-8でない名前やU+FFFDを含む名前は、別々の名前として照合でき、それだけでは不完全にならない。
- 準備で、枠の記録を書いた後の、渡す前のworktreeから、外を指すsymlinkを名前と中身の組で控える。
  控えの収集が失敗しても、枠は後始末で手放される。
  控えの収集が不完全だと、準備の時点にあった外向きの追跡symlinkが、新しく置かれたものとして消される。
  不完全の条件は、後述の「検出が不完全だった」と同じである。
  消す方向の動きなので安全側であり、意図どおりである。
- 取り戻しの後に、同じ走査をする。
  控えに無い組は、新しく置かれたものとして消す。
  控えにある名前で中身が変わった組は、消さずに、控えた中身で張り直す。
- 指す先は、中身を1要素ずつたどって決める。
  存在する要素は`realpath`で解き、`..`は解いた後の親に進む。
  `..`を含むパスは`realpath`に渡さない。
  実行系によって、途中のsymlinkを経由する`..`の解き方が違うためである。
- 途中でworktreeとその祖先の外に出たら、戻ってくるとしても外とみなす。
  外のディレクトリは、検査に差し替えられている恐れがあるためである。
- 次の場合は、決められないので外とみなす。
  - 先が無い要素の後ろに、`.`か`..`が続く。
  - 先が無い要素を、symlinkと見分けられない。
  - `realpath`が、名前が長すぎる、または輪になっているために解けない。
- 解く途中の予期しない失敗(権限など)も、止めずに外とみなし、ログに残す。
  1件の失敗で、ほかのsymlinkを調べ損ねないためである。
  ログには、エラーの種類だけを載せる。
  symlinkの中身が、例外のメッセージ経由で出ないようにするためである。
- 中身の要素が1,000を超えるものは、たどれないので外とみなす。
- 走査には60秒の上限を設ける。
  超えたら、検出が不完全だったものとして扱う。
- 木はrootの所有で書き込めない状態なので、決める間にsymlinkが差し替わらない。

##### パスで読めないsymlink

パスの長さがPATH_MAX(4096バイト)以上のsymlinkは、`readlink`と`unlink`にパスで渡せない。
そのため、`readlink`が失敗したsymlinkだけは、パスを使わない経路で読んで消す。

- 読むときは、`find -P`の`-fprintf`で、パスとinode番号と中身を`\0`区切りで、別のファイルへ書き出す。
  書き出しの大きさの制限と、書く場所(`slot-N.details`)の作り方は、一覧と同じである。
  `find`は出力にパスを書くだけで、パスで開かないので、長いパスでも書ける。
  先頭のパスを一覧の名前と突き合わせ、走査の順に頼らない。
  書き出しの件数が一覧の名前の数と合わないとき、パスが食い違うとき、末尾で切れているとき、`find`が失敗したときは、読めなかったものとして扱う。
  `find`が失敗したときは、秘密値をマスクした先頭1行をログに残す。
- 中身が絶対パスか`..`を含むものを、外向きとみなす。
  パスを決められないので、指す先は調べない。
  中身が相対パスで`..`を含まなければ、そのsymlinkのディレクトリの下に収まるので、残す。
- 消すときは、パスを組み立てずに、`find -P`の`-inum`でinode番号を選び、`-delete`で消す。
  別のファイルシステムの同じinode番号を巻き込まないよう、中身が絶対パスか`..`を含む条件も付ける。
  巻き込んでも、消えるのは外を指しうるsymlinkに限られる。
- 控えにあって中身が同じものは、残す。
  新しく置かれたものは、消して`removed`に載せる。
  失敗にはしない。
  控えにあって中身が変わったものは、消し、失敗にする。パスで張り直せないためである。
- 書き出しを読めないか、inode番号で消せなかったときは、読めないパスとして扱い、後述の全消しの後始末に倒す。

##### 消す動作と失敗の扱い

追跡されている正当なsymlinkは、準備の時点で既にworktreeにあるので、控えに入って数えない。
追跡の有無をgitに問わないのは、検査が書き換えたworktreeの設定を、rootのgitが読まないためである。
追跡されている内向きのsymlinkでも、検査が途中のディレクトリを外向きに差し替えると、外に解決される。
その場合は消す。
外に解決される以上、消すほうが安全だからである。
控えは外向きのsymlinkだけなので、内向きの追跡symlinkを検査が同じパスで外向きに書き換えると、控えに無いものとして消されるだけで、失敗にはならない。
消されたsymlinkは、差分に削除として残る。
控えを全symlinkに広げると、node_modulesのように多い木でコストが大きいため、広げない。

消すのは、木がrootの所有になり、枠のuidが書けなくなった後で、symlink自身だけである。
たどらない。
`python3 -m venv`や`uv venv`のように、正当な道具も外を指す絶対パスのsymlinkを置く。
そのため、消しただけでは検査を失敗にしない。
消したパスはログに残す。
そのうち、中身がHOMEの外にあるものを調べる。
中身がシステムのインタープリタの置き場(`/usr/bin`、`/usr/local/bin`、`/bin`)の下でもなければ、疑わしい外向きのsymlinkとして区別してログに残す。
ログに載せるのはパスだけで、中身は載せない。

次の場合だけ、検査の結果に失敗した検査を1件足す。
ほかの検査の失敗と同じに、修正のClaudeへ渡る。

- 検出が不完全だった。
  次のどれかである。
  - 一覧が大きすぎるか、読めないか、末尾で切れているか、件数が目印と合わない。
  - パスでも、パスを使わない書き出しでも、中身を読めないsymlinkがある。
  - 消せなかったsymlinkがある。
  - 準備の時点にあった、パスの長さがPATH_MAX以上の外向きのsymlinkの中身が変わり、消した。
  - 走査の時間の上限を超えた。
- 追跡されているsymlinkの中身が書き換えられた。
  消すと差分に意図しない削除が出る。
  そのため、控えた中身で張り直し、失敗にする。

検出が不完全なら、失敗として報告する前に、危険なsymlinkをまとめて消す。
`find -lname`で、中身が絶対パスか`..`を含むsymlinkを、すべて消す。
`find`は名前をバイトのまま扱うので、名前の文字コードと長さに依らない。
`-delete`は親のfdを起点に消すので、差し替えられてもたどらない。
消えるのは、中身が絶対パスか`..`を含むsymlinkすべてである。
内向きでも、追跡されていても消える。
追跡された内向きのsymlinkも、中身に`..`を含めば消える。
消えた追跡symlinkは、worktreeの差分に削除として出る。
戻すのは、使い回しの経路の`reset --hard`だけである。
それまでの差分には、削除が残る。
後始末の`find`が失敗したら、例外にして作業項目を停止する。
rootのClaudeのラウンドへ進ませないためである。

走査そのものが投げる場合も、例外のまま作業項目を停止する。
`find`の失敗と、worktreeの正規のパスを決められない場合である。
失敗した検査には畳まない。
走査できていない木を、rootのClaudeのラウンドへ渡さないためである。

失敗にする場所は、取り戻しの後の呼び出し側で、取り戻しの中ではない。
取り戻しの中で失敗にすると、枠の記録が残り、次にその枠を取る実行が同じworktreeを取り戻し直すためである。

走査と後始末は、取り戻しの後も、枠のロックを持ったまま行う。
ロックを手放した後に行うと、ほかの実行が同じ枠を取り、残っている記録を、壊れた前の実行のものと見て回復してしまうためである。
その回復は、正常な実行のworktreeを掃き、並行する削除で走査を失敗させる。
回復が途中で失敗すると、worktreeが枠のuidの書ける状態のまま、どの記録からも指されなくなる。
そのため、枠を手放すのは、走査と後始末が終わり、記録を消した後である。
走査が長いと、その枠を待つ実行の待ちが延びうる。

走査か後始末が投げたときは、記録を残して枠を手放す。
手放す処理は投げず、例外を保持して、`escapingSymlinks`が投げ直す。
作業項目は止まり、次の回復が記録を頼りに掃く。
控えを取る前に準備が失敗した実行は、走査をしないので、手放すときに記録を消す。

取り消し、タイムアウト、取り戻しの失敗、走査の前の中断で検出まで進まなかった実行は、次にその枠かそのworktreeを使うときの回復の経路で取り戻す。
その経路でも、取り戻しの後に、`find -lname`で同じ後始末をする。
検査が置いた外向きのsymlinkが、次の準備で控えに入って、消されずに残るのを防ぐためである。
後始末が失敗したら、例外にして枠の記録を残し、次の実行が取り戻し直す。

既知の限界は次のとおりである。

- 回復の経路の後始末は、追跡されている正当な外向きのsymlinkも消しうる。
  再利用されるworktreeは、使い回しの経路が`git fetch`の後に`reset --hard`と`clean`を行うので、追跡されているsymlinkは戻る。
  ただし、gitが無視するパスのsymlinkは、`clean`の対象外なら戻らない。
- パスの長さがPATH_MAX以上のsymlinkは、中身が絶対パスか`..`を含むかだけで外向きとみなす。
  指す先を調べないので、`..`を含んでも結局はworktreeの中に戻るものも、新しく置かれていれば消す。
- パスの長さがPATH_MAX以上のsymlinkで、準備の時点にあって中身が変わったものは、パスで張り直せないので、消して失敗にする。
- inode番号で消すとき、別のファイルシステムの同じ番号のsymlinkを巻き込みうる。
  ただし、巻き込んで消えるのは、中身が絶対パスか`..`を含むsymlinkに限る。
- inode番号で消すとき、同じsymlinkへのハードリンクも消える。
  検査用のuidは、自分でそのリンクを消せるので、新しい能力は与えない。
- ACLの確かめは、先に`getfacl -R`の1回で行う。
  終了コードが0で標準出力と標準エラーが空のときだけ、無いものとする。
  失敗、タイムアウト、出力があるときは、ディレクトリごとに`getfacl`を起動する確かめを正とする。
  パスの長さがPATH_MAXを超えるものがあると、`getfacl -R`は終了コード1で失敗するためである。
  ディレクトリごとの確かめは、1個あたり約0.5ミリ秒かかり、ディレクトリが50万を超える木では、1回の上限(300秒)に達しうる。
  一括が300秒で打ち切られた後に、ディレクトリごとの確かめにも300秒が与えられるので、確かめ1回の最悪は約600秒である。
- 枠を持たない走査のランダムな名前(`scan-<uuid>.links`と`scan-<uuid>.links.details`)の一時ディレクトリは、実行が途中で殺されると残りうる。
  残りは最大でも書き込み量の制限(128MiB)の大きさで、頻度は低いので、受け入れる。
- `pr_fix`では、後始末で`.venv/bin`のsymlinkが消えるので、仮想環境を作らずに使う検査コマンドがあるリポジトリでは、検査が失敗しうる。

#### 枠の記録と片付け

取り消し、タイムアウト、workerの再起動で後始末が走らないと、worktreeと`HOME`が枠のuidの所有のまま残る。
そのままだと、同じ枠を次に取る別のリポジトリの検査が、古いworktreeを書き換えられる。
そのため、所有権を渡す前に、枠の記録(`/var/lib/factory/check-slots/slot-N.state`、rootの0600)へworktreeと`HOME`のパスを書く。
記録は、後始末と、続く外向きのsymlinkの走査が最後まで終わったときだけ消す。
走査の間も、枠のロックは持ち続ける。

記録は、書く前に、読み直せる形(正規化された2段以上の絶対パス)かを確かめる。
読めない記録を書くと、その枠を取るたびに片付けが失敗するためである。

枠を取った実行は、ロックを持ったまま、次の順で片付けてから使う。

1. 枠のuidのプロセスをすべて止める。枠のロックを持つ間、残っているのは終わった実行のものだけだからである。
2. 記録があれば、そのworktreeの所有権を取り戻し、`HOME`を消し、記録を消す。
3. 共有の一時ディレクトリから、枠のuidのファイルとディレクトリを消す。消し切れなければ失敗にする。
4. 枠のuidが所有するか作ったSystem VのIPC(共有メモリ、セマフォ、メッセージキュー)を消す。workerのrootは`CAP_IPC_OWNER`を持たないので、枠のuidとして消す。

2で記録が読めなければ、記録を`slot-N.state.corrupt-<時刻>-<乱数>`へ退避する。
続けて`check_slot_record_unreadable`のnoticeを残し、記録が無いものとして片付けを続ける。
読めない記録を残すと、その枠を取るたびに片付けが失敗し、枠をずっと使えなくなるためである。
記録が指していたworktreeは自動では戻らないので、人が片付ける([運用](operations.md#検査の枠の記録を片付ける))。

片付けに失敗した枠は手放し、`check_slot_skipped`のnoticeを残して次の枠を試す。
例えば、止まらないプロセス(D状態など)が残ると、片付けに失敗する。
すべての枠で失敗すれば、検査を失敗させる。

`HOME`は`rm -rf`で消す。GNUの`rm`は`openat`で降り、symlinkをたどらない。
後始末に失敗した実行は`HOME`を消さず、記録を通して次の片付けに任せる。
止まらないプロセスが書き換えている木を、rootでたどらないためである。

worktreeを次に使うときにも片付ける。
関係するプロセスが走査で見えないと分かった後に、記録がそのworktreeを指す枠のロックを取り、上の1と2を行う。
worktreeのロックが塞がっているのに保持者が見えないときも行う。取り消された検査が別のセッションに残したプロセスが、worktreeのロックを持ち続けることがあるためである。
1でそのプロセスが止まるので、ロックが空く。
枠のロックを最大5秒待っても取れなければ、記録を読み直す。
記録がもうそのworktreeを指していなければ、ロックを持つ実行が片付けを終えたので、先へ進む。
まだ指していれば、worktreeには触れず、使用中として引き返す。
その枠を持つのは、そのworktreeで検査している実行か、その枠を取って記録を片付けている実行だからである。
プロセスを止められないか、取り戻しが失敗したときも、使用中として引き返す。
理由には、枠のユーザーと失敗の詳細が載り、準備は人の対応待ちになる。
読めない記録は、どのworktreeを指すか分からないので飛ばす。
ただし、読めない記録があってworktreeにrootでないものが残っていれば、その記録がworktreeを指していたとみなす。
このときは、記録のパスを載せて使用中として引き返す。
rootでないものが残ったworktreeでは、rootのgitが所有者の違いで実行を拒み、理由の分からない失敗になるためである。
記録の読み取りのそれ以外の失敗は、そのまま例外にする。
記録がそのworktreeを指すと分かったら、枠のロックを取る前に、イメージの前提を確かめる。
満たさなければ、所有権と記録のどちらにも触れずに止まり、要対応の通知`host_action_required`を残す。
古いイメージには取り戻しの道具が無く、途中で失敗すると、取り戻しの失敗と区別できないためである。
記録は残るので、イメージを作り直した後に同じ手順で取り戻す。
この確認は、worktreeを使うステップの準備と完了の前と、掃除が行う([実装フロー](internals/implement.md#残った所有権の復旧))。

#### プロセスの止め方

枠のuidのプロセスは、枠のuidとして`kill -9 -- -1`を送って止める。
`kill -1`は、送り手が送れるすべてのプロセスに送り、送り手自身には送らない。
枠のuidとして送るので、rootのプロセスと別の枠のプロセスには届かない。
1回のシグナルで、その時点で生きているものがすべて止まるので、止める間に子を作り続けるプロセスにも追い越されない。
`/proc`で枠のuidの生きたプロセスが見つからなくなるまで、100msおきに送り続ける。30秒を過ぎても残れば、止められないものとして失敗にする。
この操作は、枠のロックを持つ間にだけ行う。ロックを持たずに行うと、並行して動く別の検査を巻き込むためである。

検査のコマンドには、実行ごとの目印として、補助グループの大きなgidを1つ付ける。
子孫に受け継がれ、検査用のユーザーは`CAP_SETGID`が無いので外せない。
別のセッションに抜けたプロセスも、`/proc/<pid>/status`の`Groups`行で、どの実行が起動したかを見分けられる。
止める対象は目印ではなくuidで選ぶ。枠を取るときに前の実行の残りを止めるので、枠のロックを持つ間の枠のuidのプロセスは、その実行のものだけだからである。

workerには`CAP_SYS_PTRACE`が無いので、別のuidのプロセスの環境変数とfdは読めない。
プロセスロックの走査は、枠のuidで動くプロセスを一覧に入れない。
どのworktreeの検査かを特定できず、一覧に入れると無関係なworktreeの走査まで塞ぐためである。
目印のgidを記録に残して走査で照らし合わせる形は採らない。枠のロックを取れるかどうかで、そのプロセスを起動した実行が終わったかが分かり、記録から止められるためである。

#### プロセス数の上限の決め方

枠ごとの上限(`CHECK_NPROC_LIMIT`)と、workerのコンテナのpidsの上限は、次の関係を保つ。
`tests/infra/docker_compose.test.ts`がこの関係を確かめる。

```text
(同時に動く検査の数 + 飛ばした枠の数) × CHECK_NPROC_LIMIT + 検査の外に残す数 ≦ pids
(1 + 2) × 256 + 256 ≦ 1024
```

nativeでないworkerはジョブを1つずつ動かす(Windmillの制限)ので、同時に動く検査も1つである。
カーネルは枠のuidごとに数えるので、検査が上限まで使うと、その分がコンテナのpidsを使う。
この式は、`NUM_WORKERS`と`I_ACK_NUM_WORKERS_IS_UNSAFE`を置かないことが前提で、テストが固定する。
並列を増やすなら、枠のプール、pidsの式、`factory_workspaces`の共有を見直す。

検査の外に残す数は256である。
動いているworkerのpidsは、待機中が53、起動からの最大が112だった。
Windmill本体、ジョブのbun、Claude、gitが使う分で、その2倍強を残す。
片付けられなかった枠を飛ばしても、止まらないプロセスが残っていれば、その枠の分(最大256)も、検査1つの分の外で使う。
pidsの上限に余りがあるのは、この分を見込むためである。
余りの512は、飛ばした枠2つ分まで収まる。
それを超える前に止まらないプロセスを消せるよう、枠を飛ばしたときの通知`check_slot_skipped`は、workerの再起動を求める。

pidsの上限はコンテナごとで、同じDockerのVMの別のコンテナは数えない。
VM全体の上限は別にあり、測ったVMでは`kernel.threads-max`が64,272、`kernel.pid_max`が4,194,304だった。
そのとき、すべてのコンテナのタスクの合計は約500で、上限には遠い。
一方、枠ごとの上限(`RLIMIT_NPROC`)は、コンテナではなく実uidごとにVM全体で数える。
別のコンテナが枠と同じuid(既定は10001〜10008)でプロセスを動かすと、その数も枠の上限を使う。

枠ごとの上限は、workerのイメージの使い捨てのコンテナで、検査コマンドが同時に持つタスク(プロセスとスレッド)の最大を測って決めた。
測ったのは次の値で、測る道具自身の約7を含む。
対象はatelier-worksのリポジトリと、`net/http`を使う小さなGoのモジュールである。

| コマンド | 1コア | 4コア | 12コア |
| --- | --- | --- | --- |
| `bun install --frozen-lockfile` | 13 | 15 | 23 |
| `bun test` | 25 | 31 | 41 |
| `tsc --noEmit` | 12 | 15 | 28 |
| `biome check .` | 16 | 19 | 27 |
| `go build`(キャッシュが空) | 測っていない | 48 | 112 |

どれもコア数とともに増え、`go build`が最も多い。
`go build`はコアの数だけコンパイラを並べ、それぞれがスレッドを持つためである。
測ったのは、Dockerに12コアを割り当てたVMである。
上限を256にすると、`go build`も20コア台まで収まる。
それより多いコアで上限に達するときは、検査コマンドを`go build -p 8`のように並列の数を絞った形にする。

#### main cloneの保護

main cloneの`.git`はrootが所有する。
検査用のユーザーは、`config`、`hooks/`、`info/attributes`、worktreeごとの`config.worktree`を書き換えられない。
そのため、検査コマンドがgitの設定を書き換えて、rootのgitに実行させる経路は無い。
検査コマンドの中のgitは、indexを書けないので`git add`と`git commit`が失敗する。`git status`と`git diff`は動く。

#### 前提と残るリスク

前提は次のとおりである。

- ホストのカーネルで`fs.protected_hardlinks`と`fs.protected_symlinks`が1である。他のユーザーのファイルへのリンクを作らせないためである。1でなければ、検査の実行のたびにnoticeへ警告を足す。検査は止めない。
- Docker Engineがuser namespaceの再マップ(userns-remap)やrootlessで動いていない。再マップがあると、目印の補助グループが設定できず、検査が失敗する。検査が失敗するだけで、安全側に倒れる。
- `allowed_check_commands`と`check_commands_by_repo`に、`.git`へ書き込むコマンドを置かない。
  `git add`、`git commit`、`git stash`、lint-stagedなどである。
  main cloneの`.git`はrootの所有なので、検査用のユーザーでは失敗する。
- 次の変更の前に、枠の記録が残っていないことを確かめる。
  枠の数(`FACTORY_CHECK_POOL_SIZE`)を減らす、先頭のuid(`FACTORY_CHECK_UID`)を変える、検査を枠のユーザーで動かす前の版へ`f/`を戻す、の3つである。
  範囲の外の枠の記録と、前の版が読まない記録は、どの実行も片付けないためである。
  手順は[運用](operations.md#検査の枠の記録を片付ける)にある。
- 検査を枠のユーザーで動かす前にrootが作った、誰でも書けるworktreeやファイルが、`/workspaces`と`/var/lib/factory`に残っていない。
  実行時の前提の確かめはボリュームの中に入らないので、残っていても止まらず、検査用のユーザーがそこへ書き込めるためである。
  導入のときに、イメージを作り直す前と後に、ボリュームの中を走査して閉じる([運用](operations.md#稼働中のworkerの状態の確かめ方))。

残るリスクは次のとおりである。

- 検査用のユーザーは、`/workspaces`の下の他のリポジトリのcloneとworktreeを読める。cloneのURLにトークンは無い。`/workspaces/<owner>/<repo>`を0700にすると、worktreeの受け渡しと衝突しやすいので、今は受け入れる。
- 検査が並行して動く構成にしたときは、検査の間でもworktreeのファイルは読める。書き込めるのは、検査が権限のビットかACLで誰でも書けるようにしたものだけで、そこに置かれたものは取り戻しでrootに戻り、ACLも消える。ハードリンクで置かれたものは、worktreeの外のリンク先ごとrootに戻る([所有権の取り戻し](#所有権の取り戻し))。HOMEは他の枠から書けないが、0755にされると読める。
- 検査コマンドは、workerと同じコンテナとnetworkで動く。DBとWindmillの宛先に届く。認証に使う秘密には届かないが、認証が要らない経路には届く。
- メモリとCPUはworkerと共有する。検査コマンドがworkerのジョブを枯渇させうる。プロセス数は、検査が上限まで使い、飛ばした枠が2つ残っても、検査の外に256が残るように抑える。
- 検査のプロセス自身は、worktree、`HOME`、共有の一時ディレクトリの外に書けない。
  ただし、検査がworktreeの中身を書き換えた結果は、次のラウンドでrootの処理に影響しうる。
  例えば、gitが無視するパス(`node_modules/`など)に、worktreeの外を指すsymlinkを置ける。
  取り戻しはsymlinkの所有者をrootに戻すが、symlink自体は消さない。
  そのため、取り戻しの後に、worktreeの外を指すsymlinkを調べて消す([検査が置いたsymlinkの検出](#検査が置いたsymlinkの検出))。
  失敗にするのは、検出が不完全だったときと、追跡されているsymlinkが書き換えられたときだけである。
  取り戻しが失敗した実行と、取り消された実行は検出まで進まない。
  その場合は、回復の経路が取り戻した後に、絶対パスか`..`を含むsymlinkをすべて消す。
  実装フローは、次の検査の前の`git clean -fdX`で、無視されるパスのsymlinkを消す。
- 共有の一時ディレクトリとSystem VのIPCは、並行して動く別の枠の検査と共有する。権限で開いたものは、別の枠から読み書きできる。同じuidを次に使う実行には、枠を取るときに消してから渡す。
- `/proc/<pid>/cmdline`は誰でも読める。workerのプロセスの引数に秘密を載せない。
- `/var/lib/factory`の`requirements`と`audits`は0755で、検査用のユーザーが読める。`claude`は一覧を読めるが、中のファイルは0600である。
- Windmillが`/tmp/windmill`の権限を戻す契機は確かめていない。戻ると、その間だけ上の保護が外れる。検査の前には、毎回0700へ直す。
- 共有の一時ディレクトリの下にある、rootが所有する誰でも書き込めるファイルは数えない。検査用のユーザーは、その中身を書き換えられる。
- workerのジョブは`HOME`が`/root`で、`TMPDIR`が無い。
  共有の`/tmp`に作られる一時ファイルは、まだ無い名前なら検査用のユーザーが先に作れ、その後でrootのジョブがそれを使いうる。
  そのため、ジョブごとに`/run/factory-tmp/fj-<ジョブID>`を0700で作り、一時ファイルをそこへ向ける。
  親は、Windmillが管理する`/tmp/windmill`ではなく、rootが所有して他のユーザーが書けない`/run`の下に置く。
  `/tmp/windmill`の権限はWindmillがジョブの途中で戻しうるので、それに頼らない。
  - ここを使うのは、git、gh、`wmill`の子プロセスの`TMPDIR`、Claudeの`TMPDIR`と`CLAUDE_CODE_TMPDIR`、gitleaksの設定のディレクトリである。
  - Claudeの設定の置き場(`CLAUDE_CONFIG_DIR`)も、ここの下の`claude-config`にする。
  - Claudeの設定の置き場をジョブごとにするのは、`--setting-sources user`が読むユーザー層に、永続のボリュームの設定や、人が手で動かしたClaudeの変更を混ぜないためである。
  - Claude Codeが`TMPDIR`に従うかは確かめていないので、`CLAUDE_CODE_TMPDIR`にも同じ場所を渡す。
  - `/run/factory-tmp`はジョブが作る。rootの所有なら、0700でなくても0700に直して使う。他のユーザーの所有かsymlinkなら、ジョブを失敗させる。
  - 既にあるジョブ用のディレクトリが、他のユーザーの所有か、他のユーザーに開いているときも、ジョブを失敗させる。
  - ジョブのIDが読めないときは、共有の`/tmp`を使うことを警告に残し、ジョブは止めない。
  - ジョブの終了時に、プロセスの終了処理でディレクトリの削除を試みる。
  - 消えなかったものは、毎日の作業領域の掃除が、3日を過ぎてから消す。取り消しやworkerの強制終了で終了処理が走らなかったものも、ここで消える。
    掃除も、消す前に`/run/factory-tmp`を同じ基準で確かめ、満たさなければ何も消さない。
    ジョブ用のディレクトリが他のユーザーの所有か、他のユーザーに開いているときも、rootでは消さずに失敗として残す。
    3日は、`claude_timeout_sec`と`implement_timeout_sec`の既定値より十分長い。設定がこの3日を超える値は、設定の検証が拒否する。
  - `TMPDIR`を渡さないworkerのプロセス自身(Windmillとbunの依存の取得など)は、共有の`/tmp`を使う。
  - ClaudeのBashツールが固定の名前で`/tmp`の下に書く場合は、`TMPDIR`では塞げない。
  - 検査の準備が`lockDownRuntimeDir`で閉じるのは`/tmp/windmill`だけで、`/run/factory-tmp`には触れない。
  - 検査用のユーザーが共有の`/tmp`に作ったものは、枠を取るときと手放すときに消える。
- 取り消されたジョブが残した、枠のuidの孤児プロセスは、同じ枠が次に使われるか、そのworktreeが次に使われるまで残る。その間は、記録したworktreeと`HOME`を書き換え、共有の一時ディレクトリにファイルを作りうる。取り消されたジョブでは手放すときの片付けが走らないので、共有の一時ディレクトリのものは、同じ枠が次に使われて消されるまで残る。片付けでプロセスを止めてから取り戻すので、次にそのworktreeを使う実行と、その枠の次の利用者には引き継がれない。
- 所有権の受け渡しと取り戻しは、ディレクトリの数に比例して時間がかかる。
  取り戻しは常に一括で、受け渡しもハードリンクが無ければ一括なので、約9,300個のディレクトリで`chown -R`は約0.1秒、約9万3千個で約2秒である。
  残りは`find`と`getfacl`がたどる時間で、1回に、約9,300個なら約0.1秒、約9万3千個なら1〜2秒かかる。
  取り戻しでは`find`を5回、`getfacl -R`を1回たどり、合わせて約9,300個で約0.6秒、約9万3千個で約8秒である。
  この時間で済むのは、条件に当たるエントリが少なく、ACLも無いときだけである。
  当たるエントリを含むディレクトリが多いと、その数だけ`chown`を起動し、1個あたり約0.5ミリ秒かかる。
  ACLが残っていれば、ディレクトリごとの`getfacl`と`setfacl -b -k`を追加し、約9,300個で約9秒、約9万3千個で約100秒かかる。
  `setfacl`の時間は、ACLの無い木での実測で、ACLのあるエントリの書き換えは含まない。
  ハードリンクのあるファイルがあるworktreeでは、受け渡しがディレクトリごとになり、9,000個で約5秒、9万個で約1分かかる。
  1回の上限は300秒なので、超えると打ち切られて検査が失敗する。
  ディレクトリごとの受け渡しでは、1個あたり約0.6ミリ秒なので、約50万個で上限に達する。
  この数は余裕を含まない切れる点なので、負荷のあるworkerでは手前で切れうる。
  測り方は[検査枠の走査時間を測る](operations.md#検査枠の走査時間を測る)にある。
  打ち切られると記録が残り、次にその枠を取る実行と、そのworktreeを次に使うステップの片付けも、同じ上限で失敗し続ける。
- 一括の受け渡しと戻しは、worktreeの下にマウントが無いことを前提とする。
  `chown -R`には`-xdev`に当たるものが無く、別のファイルシステムのマウントがあれば、そこへ入るためである。
- コンテナで共有するカーネルの脆弱性による脱出は防げない。

これらは、検査コマンドを別のコンテナで、networkなしに動かすまで残る。
`scripts/verify-check-sandbox.sh`(`mise run test:check-sandbox`)が、上の表の項目を確かめる。
成功、失敗、タイムアウトする検査も確かめる。
`git status`、`git diff`、`bun test`を使う検査も確かめる。
枠の取得と待ちと解放、取り消された実行の後の片付け、共有の一時ディレクトリとIPCの片付け、別の枠が書き足したものの取り戻しも確かめる。
検査が付けたACLの削除、子を作り続けるプロセスの停止、読めない記録の退避、worktreeのロックを持ったまま残ったプロセスの片付けも確かめる。
プロセス数の上限、終わった検査が共有の一時ディレクトリに残したものの削除、イメージの前提も確かめる。
走らせている側が殺されても、別のセッションに抜けた検査のプロセスが枠のロックを持ち続けないことも確かめる。
workerと同じ制限の使い捨てのコンテナで、実際のsetpriv、flock、chown、`/proc`を使う。

### 対象リポジトリの設定を信頼しない

対象リポジトリの`mise.toml`や`package.json`のscriptsは、信頼できない入力として扱う。workerのmiseは対象リポジトリの`mise.toml`を信頼しない。信頼が無いと動かない検査コマンドは実行せず、止めて報告する。

### 保護パスの変更を止める

保護パスを変更したら、修正を止める。保護パスは`.claude/`、`.agents/`、`mise.toml`、`lefthook.yml`、`package.json`のscripts、新しい`*.sh`などである。
CIのワークフローとcomposite action(`.github/workflows/`と`.github/actions/`)も含む。
これらはFactoryやCIが実行する設定で、書き換えられるとコードを実行されるためである。
markdownlint-cli2とtextlintの設定(`.markdownlint-cli2.jsonc`、`.textlintrc.json`など)も止める。どちらも設定から任意のモジュールを読み込め、pre-commitと`mise run check`が読むためである。
Consoleでバンドルを通らずに配信される`console/public/`と`console/index.html`も止める。
配信するdraw.ioのビューアを固定する`console/drawio-viewer.json`も止める。
固定を書き換えるPRを作る側も止める。
対象は、`f/factory/drawio_viewer_bump`のscript、スケジュール、script定義(`.script.yaml`)である。
`f/factory/lib/`では、次の3つが対象である。

- `drawio_viewer_bump.ts`
- `drawio_viewer_bump_github.ts`
- `drawio_viewer_observations.ts`

この3つのscript定義(`.script.yaml`)も対象である。
lockは保護しない。理由は、残るリスクと「libのlockを保護しない理由」に書いた。

dependabotのセキュリティ更新PRを自動で処理するフローも止める。
対象は、次のscriptと定義である。

- マージの判定、影響調査のプロンプト、npm registryの取得、ゲート入力の組み立て、フローの支援関数
- PRの取得、スケジュール、3つのステップ
- 上のscriptそれぞれの定義(`.script.yaml`)
- フローのディレクトリ(`f/factory/dependabot__flow/`)の全体。フローに埋め込むモジュールも含む

書き換えられると、許可していない更新を人の確認なしにマージできるためである。
まだ存在しないファイルも、名前を先に止める。後から置かれたファイルが、保護から漏れないようにするためである。
PRの取得とステップのlockは止めない。`windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
共有のGitHub取得(`f/factory/lib/github.ts`)は、ほかのフローも使うので止めない。

固定を強制し、配信物を作って検査するスクリプトも止める。
図を隔離して描くiframeの検査(`tests/lib/drawio_frame_isolation.test.ts`)も止める。一覧は`f/factory/lib/protected_paths.ts`の`FORBIDDEN_EXACT_PATHS`にある。
scriptの定義の`lock`が自分の`.script.lock`を指す契約テストも止める。
対象は`tests/lib/script_yaml_lock_contract.test.ts`である。
`wmill sync push`は、`lock: '!inline <パス>'`のパスを読み、中身をlockとして保存する。
パスに制限はなく、絶対パスや`..`も書ける。
保護の外の定義を書き換えて参照先を変えると、workerやホストの任意のファイルがlockとしてワークスペースに載りうる。
このテストは、全定義の参照先を固定する。
あわせて、追跡するツリーにsymlinkとsubmoduleがないこと、`f/`の下にモジュールフォルダ(`__mod`など)がないことを確かめる。
script定義以外のYAMLとJSONには、`!inline`を許さない。
YAMLでは、エスケープや行の継続で作る`!inline`、`%TAG`の指示子、タグ(`!in%6Cine`など)も拒む。
JSONは、解釈した後の値を調べる。
flow、resource、appも同じ`!inline`を読むため、これらの経路を塞ぐ。
`f/`の下では、`node_modules`という名前のフォルダも検査から外さない。
`wmill.yaml`も止める。
`codebases`の`customBundler`は、`wmill sync push`が反映時に、設定の文字列をシェルで実行する。
`assets`の`from`は、`wmill sync push`が任意のパスのファイルを読み、ワークスペースに載せる。
どちらも、保護の外から書き換えられると、反映するworkerやホストで任意のコマンドが走り、任意のファイルが載る。
そのため、`wmill.yaml`は`FORBIDDEN_EXACT_PATHS`に入れて、`codebases`に限らず丸ごと止める。
`wmill-lock.yaml`は、依存の変更のたびに書き換わるので止めない。
テストは保護パスで止まるが、テストの実行環境は止めない。
`tests/preload.ts`と、保護していないほかのテストは、テストを緑のまま通すために書き換えられる。
これは残るリスクで、マージ前の人のレビューで防ぐ。
YAMLの解釈は、テストが使うBunとwmillで違いうる。
そのため、script定義では`lock`の行を完全に一致させ、解釈の違いに頼らない。
CIがどのジョブを動かすかを決める`scripts/ci-scope.ts`も止める。書き換えられると、検査のジョブを飛ばされるためである。
CIが出すメタデータのパッチを取得して検査する`f/factory/lib/metadata_patch_*.ts`の6つも止める。
6つは、manifest、zip、yaml、verify、imports、downloadである。
それぞれの`.script.yaml`も止める。
lockは、`metadata_patch_manifest.script.lock`だけを止める。新しいscriptのlockを照合するときの空のlockの参照(`EMPTY_LOCK_REFERENCE`)で、壊されると新しいscriptの自動適用が断られ続けるためである。
書き換えられると、パッチの受け取り側の検査が緩むためである。

`wmill-lock.yaml`のhashを再計算する`f/factory/lib/`の`metadata_hash`、`metadata_precheck`、`metadata_signature`も止める。
それぞれの`.script.yaml`も止める。
書き換えられると、依存が変わるPRや、入力のスキーマが変わるPRのlockを、人の確認なしに書き換えさせられるためである。

配信のCSPを持つ`infra/Caddyfile`と、配信物を検証する`infra/console_fetcher/`も止める。
一覧は`f/factory/lib/protected_paths.ts`にある。

#### libのlockを保護しない理由

上のlibのうち、依存の無い17個の`.script.lock`は保護しない。
中身は`"dependencies": {}`と`<empty>`だけである。
`metadata_patch_manifest.script.lock`は、空のlockの参照なので保護する。

- libは`main`を持たず、単独のjobとして動かない。importする側のscriptは、自分の`.ts`と`.script.lock`で動くので、libのlockは実行の入力にならない。
- libの`.ts`と、`lock`の参照先をlib自身のlockに固定する`.script.yaml`は、保護する。`.script.yaml`の`lock: '!inline <パス>'`は、反映のときに`wmill sync push`が読む。書き換えられると、任意のファイルがlockとして保存されうる。
- CI回と競合回は、`*.script.lock`を全scriptについて拒否する(`ci_fix_paths.ts`)。この拒否は変わらない。
- メタデータのパッチを適用する経路は、対応する`.ts`が保護されたscriptのlockを`protected_source`で拒否する。拒否の理由は`protected_path`から変わりうるが、拒否は続く。
- 保護しない前提は「libが入口を持たない」ことである。`tests/lib/protected_paths.test.ts`が、保護するlibの`.ts`に次が無いことを固定する。
  `main`、`preprocessor`、行頭の`export default`、再exportである。
  崩れたら、lockを保護に戻す。
- 実機のWindmillで、libのlockが使われないことは確かめていない。根拠は、Windmillの文書とリポジトリの実物である。前提が外れていても、importする側のlock(`steps/*.script.lock`など)がすでに保護の外にあるので、新しい種類の穴は増えない。

#### 修正と実装で範囲が違う理由

保護パスの一覧は、3つの場面で範囲が違う。

| 場面 | 一覧 | 当たったときの動き |
| --- | --- | --- |
| PRの修正(通常の回) | `FORBIDDEN_*` | pushせず、人の対応待ちにする |
| CIの修正と競合の修正 | 実装の一覧に、`ci_fix_paths.ts`の拒否を足したもの | 変更を拒否し、人の対応待ちにする |
| 実装 | `IMPLEMENT_PROTECTED_*` | 止めずに、PR本文と通知に載せ、そのラウンドの検査コマンドを実行しない |

実装が止めないのは、新しいブランチにpushしてPRを作る工程で、マージの前に人が差分を見るためである。
検査コマンドを省くのは、Claudeが書き換えた設定をworkerで実行すると、Issueの本文からコードを実行する経路になるためである。
PRの修正は、すでにあるPRのheadにpushするので、当たったらpushを止める。
一覧に入れるのは、FactoryやCIが実行する設定である。
書き換えられるとコードを実行されるためである。

実装の一覧が広い項目と、その理由は次のとおりである。

| 項目 | 理由 |
| --- | --- |
| `.github/`の全体 | workflowに加え、dependabotの更新元とレビューの担当(CODEOWNERS)を決めるため。PRの修正の一覧は、workflowsとactionsだけを止める |
| `infra/`の全体 | workerのイメージとcomposeの定義で、変更はホスト側で`mise run up`するまで反映されない。レビューする人が反映の要否を知る必要があるため |
| gitフックと`.yarn/`と`.devcontainer/` | 検査コマンドや開発環境が何を実行するかを決めるため |
| lockfile、`package.json`の全体、ツールの設定、`.env`系、バージョン指定 | 検査コマンドがインストールや設定の読み込みで実行し、信頼するものを決めるため。PRの修正の一覧は、`package.json`の`scripts`だけを止める |

PRの修正の一覧が、実装の一覧より狭い理由は、設計として説明できていない。
`infra/`、lockfile、ツールの設定などを通常の回で止めない根拠は、一覧のコメントと記録のどちらにも無い。
CIの修正と競合の修正は、実装の一覧を使うので、この差を持たない。
通常の回の一覧を実装の一覧にそろえるかは、集計の結果を見て決める。
集計の手順は[保護パスで止まった回数を数える](operations.md#保護パスで止まった回数を数える)にある。

### symlinkと特殊なファイルを止める

symlinkの作成・変更・削除、入れ子のリポジトリ、`.git`という要素を含むパス、通常のファイルでないものがあれば止める。symlinkを通すと、作業ディレクトリの外のファイルを読み書きされるためである。変更の一覧は、引用符付きのパスや未追跡のディレクトリでも判定を素通りしない形で取得する。

### HEADとブランチの確認

変更を調べる前に、worktreeのHEADとブランチが、準備のときに見たPRのものと同じかを確かめる。検査コマンドがcommitやブランチの切り替えをすると、その変更が差分から消えて検査を素通りするためである。

### worktreeの.gitファイルの書き換えを止める

worktreeの`.git`ファイルは、準備のときに検証して中身を記録する。以降、Claudeを起動する前とgitを実行する前に、記録と一致することを確かめる。参照先を別のディレクトリに向けられると、そこのconfigの設定を次のgitがrootで実行するためである。この安全策は実装のフローでも同じように働く。

### gitが読む設定を限る

`f/factory/lib/workspace.ts`と`f/factory/steps/pr_workflow_support.ts`が実行するgitは、読む設定を同じ方法で限る。
どちらも`workspace.ts`の`buildGitArgv`と`localGitEnv`を使う。

システムとグローバルの設定は、環境変数`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_SYSTEM`、`GIT_CONFIG_GLOBAL`、`GIT_ATTR_NOSYSTEM`で読ませない。
workerのホストの設定が、検証の前提を変えないためである。
コミットのauthorは環境変数で、認証は`GH_TOKEN`で渡すので、これらの設定は要らない。
workerのイメージは、グローバルのgit設定もgtrのグローバル設定も持たない。
HOMEは、ghなどの子プロセスと、gitの`~`の展開(`.git/config`のパスの`~`、httpsの`$HOME/.netrc`)のために渡す。
workerのHOMEには`.netrc`を置かない。イメージにも置いていない。
`safe.directory`は設定しない。
workerとcloneはどちらもrootで動き、`/workspaces`のボリュームの所有者が同じになるためである。
Dockerfileとworkerの`docker-compose.yml`に、`USER`と`user:`の指定は無い。

転送はhttpsだけを許す。環境変数`GIT_ALLOW_PROTOCOL`を`https`にする。
`.git/config`に`protocol.ext.allow=always`と`ext::`のremoteを書かれると、`GH_TOKEN`を持つ環境でコマンドを実行されうる。
この環境変数は`protocol.*`の設定より優先されるので、設定ファイルでは許可を広げられない。
対象のremoteはhttpsだけなので、fileやsshは使えなくてよい。

main cloneの`.git/config`は、gitがremoteやブランチの設定を読むので、読ませないことはできない。
`extensions.worktreeConfig`が有効なときは、worktreeごとの`config.worktree`も読まれる。
どちらも書き換えられると、`-c`では`config.worktree`の読み込みを止められない。
検査コマンドは別のuidで動き、書き込めない。書き込める経路が増えたときに備えて固定する。
そこで、プログラムの実行と検証の前提に関わる設定を、コマンドラインの`-c`で固定する。
`-c`はどの設定ファイルよりも優先されるので、設定ファイルに別の値を書かれても効かない。
`git gtr`の子のgitにも、環境変数`GIT_CONFIG_PARAMETERS`を通して渡る。

| 設定 | 固定する値 | 防ぐこと |
| --- | --- | --- |
| `core.hooksPath` | `/dev/null` | 設定のフックの実行 |
| `core.fsmonitor` | `false` | 設定のfsmonitorのヘルパーの実行 |
| `core.askPass` | 空 | 設定のaskpassのプログラムの実行 |
| `commit.gpgsign` | `false` | commitの署名で`gpg.program`を実行させること |
| `push.gpgSign` | `false` | pushの署名で`gpg.program`を実行させること |
| `gpg.program` | 空 | 署名の作成と検証で、設定のプログラムを実行させること |
| `core.commitGraph` | `false` | commit-graphによる、コミットの親の読み替え |
| `core.symlinks` | `false` | symlinkの検出が前提にする値の巻き戻し |
| `core.excludesFile` | `/dev/null` | `$HOME/.config/git/ignore`の読み込み |
| `core.attributesFile` | `/dev/null` | `$HOME/.config/git/attributes`の読み込み |
| `credential.helper` | 空 | 設定のcredential helperの実行。`credential.<URL>.helper`も一覧ごと消える |

`ignore`と`attributes`は設定ファイルではないので、`GIT_CONFIG_GLOBAL`では止まらない。
ネットワーク操作では、この後にghのcredential helperを加える。

`core.symlinks=false`はFactory自身のself cloneにも効く。
Factoryのリポジトリにsymlinkを足すと、self cloneでは普通のファイルになる。

固定していない設定は、そのまま読まれる。
`url.*.insteadOf`、`remote.*.pushurl`、`http.*`、`filter.*`、`diff.*`、`merge.*.driver`などは、キーが対象ごとに変わり、名前で固定できない。
名前が決まっていて、プログラムを実行できたり作業ツリーを変えたりする設定にも、固定していないものがある。
`core.alternateRefsCommand`は、`objects/info/alternates`があるcloneのfetchで、シェルから実行される。
`core.worktree`は、`config.worktree`に書くと、`status`、`clean`、`add -A`が見る作業ツリーを別のディレクトリに変える。
どちらも実際のgitで確かめた。
これらは残るリスクである。
`git gtr new`のcheckoutは`GH_TOKEN`を持つ環境で動く。
そのため、`.git/config`の`filter.<名前>.smudge`や`process`を、PRの内容の`.gitattributes`が指名すると、`GH_TOKEN`を読めるプログラムが動く。
根本の対処は、ネットワーク操作とcheckoutを分け、checkoutを`localGitEnv`で行うことである。
検査コマンドは検査用のユーザーで動き、main cloneの`.git`に書き込めない([検査コマンドの権限](#検査コマンドの権限))。
そのため、検査コマンドが`.git/config`を書き換えて、`GH_TOKEN`を持つgitにプログラムを実行させる経路は無い。
検査コマンドが書き換えられるworktreeの`.git`ファイルは、記録との照合で止める。

### コミットの直前の再検査

完了のステップは検証とは別のジョブなので、commitの前にもう一度確かめる。worktreeを使うプロセスが残っていないこと、ブランチとHEADが記録どおりであること、ステージした内容に保護パスやsymlinkが無いことを見る。1つでも通らなければ、commitとpushをしない。

commitの前には、実装フローと同じgitleaksの検査もする。
commitするツリーは、gitleaksが検査したツリーと同じことを確かめ、pushは作ったcommitのshaだけを送る。
検査していない変更と履歴をpushしないためである。
手順は[PRワークフローの仕様](internals/pr-workflow.md)の「コミットの前の再確認」にある。

### 差し替えとサブモジュールに惑わされない

gitの実行には`GIT_NO_REPLACE_OBJECTS=1`を付け、`refs/replace/`で差し替えたオブジェクトを読まない。変更の一覧には`--ignore-submodules=none`を付け、サブモジュールの変更を隠させない。差し替えのrefとサブモジュールの設定は、検査コマンドが作れるためである。

同じ理由で、ローカルの`origin/HEAD`と追跡ref(`refs/remotes/origin/*`)も、送る内容を決めるときには信じない。
検査コマンドはメインのcloneの`.git`を書き換えられ、`--prune`なしのfetchは書き換えられた`origin/HEAD`を直さない。
実装フローが空のブランチをpushするときは、リモートに`git ls-remote`で問い合わせた既定のブランチの先頭を送る。
リモートの`HEAD`が既定のブランチと違うとき、リモートに既定のブランチが無いとき、ローカルの追跡refがリモートと違うときは、何もpushしない。

### 差分の大きさの上限

変更したファイルの数が`max_fix_changed_files`を超えるか、差分の行数が`max_fix_diff_lines`を超えたら止める。マージの衝突やファイルの削除による大きな変更を、レビューなしにpushしないためである。

### PRの状態とheadの確認

準備のステップで、PRについて次の8点を確かめる。

- openである。
- forkからでない。
- draftでない。
- auto-mergeが有効でない。
- headのブランチの状態を読める。
- headのブランチがリポジトリのデフォルトブランチでない。
- headのブランチが保護ブランチでない。
- headのブランチにrulesetのruleが適用されていない。

状態を読めない場合を除き、通らなければ、worktreeを作らずにブロック(`blocked`)で止める。
forkのブランチ、保護ブランチ、デフォルトブランチにはFactoryがpushしてはならず、draftのPRは作者がまだ作業しているためである。
auto-mergeが有効だと、Factoryの修正pushがレビューを経ずにマージされうるので、有効なPRは止める。
修正でpushするのはheadのブランチで、baseではない。
そのため、baseが保護されていても、headが普通のブランチなら通る。
保護の有無は、GitHubのbranches APIの`protected`で読む。
`main`を保護するruleset(対象は既定のブランチ)は、`protected: true`として返ることを確かめた。
globで対象を指定するrulesetなどが`protected`に反映されるかは確かめていない。
そのため、`GET repos/{owner}/{repo}/rules/branches/{branch}`でheadのブランチに効くrulesetの規則も読み、1件でもあれば止める。
ruleの種類は問わずに止める。
止めすぎは安全側で、`protected`に反映されないrulesetを見落とさないためである。
headのブランチの状態を読めなかったときは、例外になって作業項目が失敗(`failed`)になり、`job_failed`で通知する。
どの場合も、worktreeを作る前に止まる。

残るリスクとして、準備からpushまでの間に、PRのauto-mergeを有効にされたり、headのブランチを保護されたりする窓が残る。
pushの直前に確かめ直すのはheadのshaだけで、auto-mergeと保護は読み直さないためである。
窓は修正の実行時間ほどの長さになる。
auto-mergeの有効化にもGitHubの書き込み権限が要るので、受け入れる。

pushの直前には、PRのheadが準備のときから変わっていないことだけを確かめ直す。
変わっていれば、pushせずにブロックで止める。
人がpushした変更を上書きしないためである。

### コミットの作成者情報

コミットのauthorとcommitterには、PATのアカウントのログイン名とGitHubのnoreplyメールアドレスを使う。個人のメールアドレスをどこにも書き込まないためである。値は`git commit`の環境変数としてだけ渡し、git configには書かない。

### CIのログの扱い

CIの失敗を直す回の部品は、Actionsのログを取り込んでClaudeのプロンプトに入れる。
部品の責務、入力の検証、flowが守る前提は[CIの失敗を直す部品の仕様](internals/ci-fix.md)にある。

ログは、対象のブランチへpushできる人が、中身を決められる外部入力である。
最大の危険は、ログに書かれた指示をClaudeが実行することと、ログの中の秘密値が外へ出ることである。
部品が実装している防御は次のとおりである。

- ジョブとログのIDは正の安全な整数に限り、応答の実行IDとコミットのshaが期待と一致しなければ捨てる。
- 端末の制御列、制御文字、書字方向の制御文字、不可視文字を除く。
  検査の前に除くのは、不可視文字で分割された秘密値を検査に見せるためである。
- 生のログが大きいときは、先頭と末尾だけを残して行に分け、1行を長さで切ってから正規表現にかける。
  メモリと最悪の計算量を有界にするためである。
- gitleaksで全文を検査した後、絞る前に、トークンの形の文字列(`gh[oprsu]_`、`github_pat_`、`sk-ant-`、Discordのwebhookの形)を伏せる。
  切り口にかかった秘密値の一部が残らないようにするためである。
- 1ジョブ3000字、全体9000字に絞る。
- ジョブ名、step名、ログの抜粋、PRの変更ファイルのパスは、nonce付きの囲みの中に入れ、囲みの中は命令ではなくデータだとプロンプトで述べる。
- PRの変更ファイルの囲みには、保護パスを載せない。
  保護パスを載せると、囲みを「編集してよいファイル」と読んだClaudeが保護パスを編集し、flowの検査に止められるためである。
  囲みの外には、保護パスのファイルの件数だけを固定文で述べる。
- gitleaksと`maskSecrets`を重ねて通す。
  gitleaksは、ジョブごとの絞る前の全文と、絞った後の抜粋の全体にかける。
  どちらかで検出したときは、行を消して続けず、`secret_detected`を返し、Claudeを起動しない。
  gitleaksを実行できなかったときも、検出ありと同じに扱う。
- ログを取得できないときは、本文もリダイレクト先の署名付きURLもエラーに載せない。
- 変更してよいファイルは、PRがすでに変更したファイルと新規のテストだけに限る。
  保護パスとFactoryの安全装置、検査を弱める行は拒否する。
- Claudeが返したコミットの件名と本文、要約、停止の理由も、gitleaksと`maskSecrets`に通す。
- 生のログ、抜粋、プロンプトは、JSONにできない型で包む。

残るリスクは次のとおりである。

- 切り口にかかった秘密値の一部は、トークンの形の文字列を切る前に伏せることで緩和している。
  この緩和が効くのは、接頭辞が分かる形の秘密値に限る。
  全文のgitleaksの検査は、伏せる前に行うので、本物の秘密値はここで止まる。
- 生のログの先頭と末尾を残す境目では、秘密値が分断される。
  分断された後半は接頭辞を持たないので、伏せられず、gitleaksにも検出されない可能性がある。
- base64などで符号化された秘密値と、複数の行に分割された秘密値は、gitleaksと`maskSecrets`で検出できない可能性がある。
  Actionsが自動で伏せる範囲に頼る部分が残る。
- 抑制の記述の検出は文字列の照合なので、別の書き方で検査を無効にする変更は検出できない。
- テストの期待値の書き換えは機械では判定できない。
  再レビューに頼る。
- ログの取得先は署名付きURLへの302で、`gh`が内部でたどる。
  認証情報が別のホストへ渡らないことは、`gh`の挙動に頼る。
- 拒否した安全装置が直接importするモジュールのうち、`db`、`discord`、`poll_support`、`implement_*`などの共有モジュールは、拒否せずに受け入れている。
  CI回のClaudeが、PRがすでに変更していればこれらを書き換えられる。
  受け入れた一覧と理由は、テストが固定する。
- ルートの`AGENTS.md`、`CLAUDE.md`、`AGENTS.wmill.md`、`.gitignore`と、安全装置以外の`*.script.yaml`は、拒否の一覧に無い。
  PRがすでに変更していれば、CI回のClaudeが書き換えられる。
  影響は、マージの後か、人の対話セッションで読まれたときに現れる。
- `github.ts`は、CI回のClaudeが変更できない。
  Factory自身の修正PRのCIが`github.ts`の不具合で落ちても、CI回は直せずに人へ渡す。

### マージの競合を解く回

マージの競合を解く回(競合回)の部品は、リポジトリの既定のブランチ(base)の先頭をPRのブランチにmergeし、競合をClaudeに解かせ、mergeコミットをpushする。
git操作は`lib/workspace.ts`の`mergeBaseIntoWorktree`と`pushMergeCommit`に、検査は`lib/conflict_fix_round.ts`にある。
手順と検査の規則は[CIの失敗を直す部品の仕様](internals/ci-fix.md#競合回のgit操作と検査)にある。

#### baseの決め方

mergeするのは、PRのbaseがリモートの既定のブランチのときだけである。
`git ls-remote --symref`でリモートの`HEAD`が指すブランチを、完全なref名で照合し、そのブランチの先頭のshaを読む。
ローカルの追跡ref(`refs/remotes/origin/*`)は読まない。検査コマンドが書き換えられるためである。

読んだshaを明示してfetchし、mergeもそのshaで行う。
fetchはサブモジュールに降りない。
fetchからmergeまでの間にbaseが進んでも、検査する内容と記録がずれない。

#### workflowスコープを付けない

PATにWorkflowsの権限は付けない([GitHubのPAT](#githubのpat))。
`.github/workflows/`を含むpushをGitHubに拒否させるためである。

baseの側が`.github/workflows/`を変えていると、mergeコミットのpushは拒否される。
そのため、mergeした結果のツリーで、PRのheadからの差に`.github/workflows/`が含まれれば、Claudeを起動せずに止める。
それでもpushが`.github/workflows/`を理由に拒否されたときは、他の拒否と区別して返す。
区別は、拒否の行の括弧の中の理由だけで行う。ブランチ名に`.github/workflows/`を含む別の拒否を、取り違えないためである。

#### mergeコミットのpush

pushするのは、検査したツリーを持ち、親が[PRのhead, base]のmergeコミット1つだけである。
rebaseとforce pushはしない。

基準コミットは送らない。基準コミットは衝突マーカーを残したままローカルにだけ作り、pushするコミットは`commit-tree`で新しく作る。
競合ファイルだけをステージして作ったツリーが、検査したツリーと一致することは、コミットを作る前に確かめる。

第2親(base)の履歴は、すでにリモートにある。
pushが新しく送るのは、mergeコミットと解消したファイルの内容だけである。
pushの直前に、記録したbaseが既定のブランチの先頭か、その祖先であることを`ls-remote`で確かめる。
違えば、何も送らずに止める。

PRのブランチは、ブランチと追跡refを明示したrefspecでfetchする。
短いブランチ名のfetchは、リモートの同名のタグが先に解決され、追跡refが作られないためである。

fast-forwardでない拒否は、PRのheadが動いたものとして扱う。
人がpushした変更を上書きしないためである。

#### baseの側の変更

baseの側の変更は、すでにレビューとマージを経ている。
そのため、保護パスの検査の対象は、競合ファイルと、結果がPRのheadともbaseとも違うパスに限る。
baseだけが変えたパスは、結果がbaseと同じなので、保護パスでも止めない。
止めると、既定のブランチが保護パスを変えるたびに、競合を解けなくなる。

名前の変更は削除と追加の2件として比べるので、新しい名前でも漏れない。

#### 衝突ブロックの照合

Claudeの解消の検査は、衝突ブロックを3つの版から作り直した形で決める。
作り直した形が、gitがworktreeに書いたブロックと食い違うと、Claudeが見た境目と検査の境目がずれる。
ずれた検査は、ブロックの外の変更を見逃すことがある。

そのため、Claudeを起動する前に、作り直した本文と`add`した本文を、マーカー行のラベルを除いて比べる。
違えば、mergeを取り消して人に渡す。

#### git操作の守り

`commitAndPush`と同じ前段を通ってから、最初のgitを実行する。
リポジトリのロックを取り、worktreeの`.git`ファイルが準備のときの記録と一致することを確かめ、HEADが想定のブランチにあることを確かめる。
`.git`ファイルが差し替えられていれば、worktreeでgitを1回も実行せずに止まる。

すべてのgitに`--literal-pathspecs`を付け、ファイル名をpathspecの記法として読ませない。
親の照合を偽らせないため、親を読み替える2つの仕組みを塞ぐ。
環境変数`GIT_GRAFT_FILE`を`/dev/null`にして、`.git/info/grafts`で親を書き換えさせない。
`GIT_NO_REPLACE_OBJECTS`ではgraftsを止められないためである。
gitの2.54で、graftsが効くことと、この指定で無効になることを確かめた。
`core.commitGraph=false`で、commit-graphファイルの親を読ませない。
どちらも、main cloneの`.git`に書き込めない前提の上で、書き込める経路が増えたときの備えである。
`merge`には`--no-verify-signatures`を付け、署名の検証でプログラムを動かさない。
`GH_TOKEN`を渡すのは`ls-remote`、fetch、pushだけで、merge、add、commitは持たない環境で動く。
ローカルのgitには、authorとcommitterを環境変数で渡す。
`merge`はコミットを作らない呼び出しでも、利用者名が決まらないと失敗するためである。
実行する環境の利用者設定には頼らず、設定ファイルには書き込まない。
基準コミットには、競合ファイルだけを`add`する。`add -A`は使わない。

#### 残るリスク

- 意味的に誤った解消(片側を丸ごと採るなど)は、検査では検出しきれない。
  後続の自動レビューと人のレビューが止める。
- ローカルのブランチは、基準コミットを作ってから、pushが済んだ後も、衝突マーカー入りのコミットを指す。
  通常の回の`commitAndPush`は、`requireLocalHeadAtExpected`でローカルのHEADを確かめて止める。
  呼び出し側は、次にworktreeを使うときの`reset --hard`に任せる。
- mergeが始まった後に例外が出ると、`merge --abort`をベストエフォートで行う。
  取り消しが失敗したworktreeは、mergeの途中のまま残りうる。
  呼び出し側は、次にworktreeを使うときの`reset --hard`と`clean -fd`で戻す。
- 署名の変更や、自動でmergeされた箇所に足した呼び出しの食い違いは、検査では見つからない。
  検査コマンドの失敗として現れる。
- 新しく足した行の検査は、JavaScriptとTypeScriptの記法だけを見る。
  ほかの言語の読み込みや抑制の記述は、検査を通る。
- この回は、`git merge`を呼ぶ経路を新しく足す。
  `merge.<名前>.driver`は、`.gitattributes`が名前を指名し、`.git/config`の定義がプログラムを動かす。
  名前が対象ごとに変わるので、名前で固定して潰せない。
  定義を置けるのはmain cloneの`.git/config`で、検査コマンドは書き込めない([検査コマンドの権限](#検査コマンドの権限))。
  この前提で抑え、書き込める経路が増えたときは残るリスクになる。
- mergeコミットのpushの直前の照合とpushの間に、人がブランチを祖先へ巻き戻す窓が残る。
  巻き戻されたブランチへも、pushは通る。
  `commitAndPush`と同じ窓として受け入れる。
- 属性の検査は、競合ファイルだけにかける。
  両側が変えたが競合しなかったパスの属性は調べない。
  そのパスの自動のmergeでも、属性の指名したドライバが動きうる。
  上のドライバの項と同じ前提で抑える。
- 差分の大きさの上限(`max_fix_changed_files`と`max_fix_diff_lines`)は、基準コミットから解消後の作業ツリーまでの編集にかける。
  baseがPRに持ち込む差には、かけない。
  baseの側の変更は、すでにレビューとマージを経ているためである。
- 競合回の完了ステップは、失敗をDiscordとnoticeに通知しない。
  通知を競合の行の側に集めるためである。
  失敗は、作業項目の状態と注記としてConsoleに残る。
  運用者の対応が要る2件は例外で、通知を残す。
  リポジトリのオーナーの数値IDの照合に失敗したときと、workerのイメージが古いときである。
  ただし、イメージの古さは準備と検証のステップが残し、完了のステップで検出したときは残さない。
  その場合は、行の起動の回数の上限に達して`rounds_exhausted`になるまで、通知が無い。
  上限に達するまでの時間は、上限の回数に巡回間隔の5分を掛けた程度である。
  詳細は[完了の結果](internals/pr-workflow.md#完了の結果)にある。

## 実装の安全策

実装のフロー(`implement`)も、Claudeに書き込みのツールを与える。PRを作るところで止まり、マージは常に人が行う。実装のフローはmerge APIを呼ばない。仕組みの詳細は[実装フローの仕様](internals/implement.md)にある。

### ツールの制限と検査の分担

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。検査コマンドはフローが実行する。

### 取り込み後のIssueの書き換え

Claudeに渡すIssueの題名と本文は、作業項目に取り込んだものである。承認の後にIssueを書き換えても、プロンプトには入らない。現在のIssueは、openかどうかの確認と、PR本文の注記にだけ使う。

取り込んだ内容が変わる経路は、却下や再実行による作り直しだけである。
作り直しの前に、取り込んだ題名と本文を現在のIssueの内容へ更新する([作業項目の状態とリース](internals/work-items.md)の「却下と再生成」)。
却下の理由がIssueの書き換えのとき、作り直した要件定義を承認できるようにするためである。

承認者が見ていない内容が渡らないよう、次の策を重ねる。

- Consoleの要件定義の承認画面に、取り込んだ題名と本文を出す。更新後の内容は更新後の値で出し、更新したことを警告で示す。
- 同じ画面に、承認する試行の要件定義書を並べる。取り込んだ内容と要件定義書の両方を見られるまで、承認を押せない。承認の試行が分からないときは、最新の試行で代えず、承認を止める。
- 要件定義の承認では、決定を記録する前に現在のIssueを取り込んだ内容と比べる。違うときと、比べられなかったときは、承認を断る。比べる処理は`approval_decide`の中で、`github_token`を使ってGitHubのREST APIを`fetch`で読む。Console用のworkerの`github_token`の扱いは[Console用workerの境界](#console用workerの境界)に書く。
- 取り込んだ内容を更新したときは、`work_item_events`に文字数とハッシュを残し、noticeとDiscordで承認者に知らせる(再実行ではnoticeだけ)。更新後の内容は信頼できない入力なので、履歴にはそのまま入れない。
- 更新したことのある作業項目のPR本文には、「確認して欲しい点」に注記を必ず出す。更新後の内容と現在のIssueを比べる注記では、更新のときの書き換えを拾えないためである。

次のことは、この策では守れない。

- 確認から決定の記録までの間のIssueの書き換えは防げない。承認者が見た内容のハッシュに結び付ける案は、`approval_decide`がそのハッシュを受け取らないので、今は採れない。
- 承認者は、Consoleの要件定義の承認画面で、取り込んだ内容と更新の警告を確かめて承認する。Consoleは、取り込んだ内容を表示できないあいだ、承認を押せないようにする。確かめずに承認しても、承認の前の確認が働くので、承認の時点で書き換わっているIssueは通らない。ただし、却下を挟むと、書き換え後の内容が取り込み直されて承認画面に出るので、確かめずに承認すると書き換え後の内容が実装に渡る。通知とPR本文の注記が緩和する。
- Claudeに渡す題名と本文から、不可視の文字(tag文字、ゼロ幅の文字、双方向の制御文字など)を除いていない。Consoleは置き換えて警告を出すが、Claudeには置き換える前の内容が届く。除く処理は別に扱う。
- 本文が長いとき、Consoleは先頭だけを表示する。表示していない後ろの部分は、Consoleでも、MarkdownとしてHTMLのコメントや不可視の文字を描かないGitHubの画面でも、確かめられない。後ろの部分にある`<!--`と不可視の文字の数を数えて警告するが、内容そのものは確かめられない。

### 同じ作業項目を同時に実装しない

同じ作業項目の実装フローは、同時に1つしか作業しない。フローのジョブIDをリースとして扱い、worktreeとClaudeのプロセスにはロックファイルを持たせる。Windmillでジョブを取り消しても、Claudeや検査コマンドのプロセスは止まらないためである。

### 承認済みの要件定義を書き換えさせない

Claudeには、要件定義のディレクトリを一時ディレクトリに複製して渡す。Consoleが表示する承認済みの文書は渡さない。複製にはsymlinkを写さないので、Claudeが文書の外のファイルに書き込む経路は残らない。

### 検査コマンドを明示したリポジトリだけで実行する

検査コマンドは、Claudeが書いたコードをworkerの中で、非特権のユーザーとして、コンテナの分離なしに実行する([検査コマンドの権限](#検査コマンドの権限))。
そのため、`check_commands_by_repo`にそのリポジトリのコマンドを明示したときだけ実行し、`allowed_check_commands`は使わない。
networkとworkerの資源を共有するので、Issueを信頼できる人だけが起票するリポジトリにだけ設定する。

### 対象リポジトリのCIが動く

実装ブランチのpushとPRの作成で、対象リポジトリの`push`と`pull_request`のCIが動く。atelier-worksのCIはPRの作成から動く。Claudeの書いたコードは、人のレビューより前に、そのリポジトリのsecretsを使える状態で実行されうる。対象リポジトリのCIの権限とsecretsの範囲は、この前提で設定する。

### 保護パスは止めずに明示する

保護パスの変更は止めずに、PR本文とDiscordの通知に列挙する。保護パスは、PR修正の一覧より広い`IMPLEMENT_PROTECTED_PATH_PREFIXES`などで定める。そのラウンドは検査コマンドを実行せず、検査はGitHubのCIに任せる。書き換えられた設定をworkerで実行すると、Issueの本文からコードを実行する経路になるためである。

### symlinkの変更を止める

symlinkの作成・変更・削除があれば、人の対応待ちにする。ファイルシステムではなくgitのモードで判定するので、worktreeに残っていないsymlinkも捕まえる。

### 差分の大きさの上限

変更したファイルの数と差分の行数が、`implement_max_changed_files`と`implement_max_diff_lines`を超えたら、人の対応待ちにする。

### 保護ブランチのガードは使わない

headが保護ブランチなら止めるガードは、実装フローには適用しない。実装フローはPRごとに新しいブランチを作ってpushし、保護されたbaseやデフォルトブランチには直接pushしないためである。

### gitleaksで毎ラウンド検査する

毎ラウンド、デフォルトブランチから分かれた点と、そのラウンドで記録したツリーの間の差分全体を、gitleaksの既定のルールで検査する。対象リポジトリの`.gitleaks.toml`、`.gitleaksignore`、行内の`gitleaks:allow`などでは検出を無効にできない。検出結果はルール名とファイル名だけをClaudeとDBに渡し、一致した文字列は渡さない。

検査したツリーが、そのラウンドで変更を判定したツリーと違えば、そのラウンドで止める。
判定と検査の両方を経たツリーだけを、検証済みとして記録するためである。

### 検証したツリーだけをコミットする

検査に通ったラウンドのツリーを記録し、コミットの直前に一致を確かめる。検査コマンドがファイルを書き換えた場合など、検証の後にworktreeが変わっていればpushしない。

commitの直前には、ステージし直した索引のツリーも同じツリーと比べる。
commitの後には、作ったcommitのツリーを確かめ、違えばcommitを取り消す。
検査していない内容をcommitしないためである。

### pushする履歴を記録した先頭と新しい1つのcommitに限る

commitの前に、ローカルのHEADが、準備のステップの記録した実装ブランチの先頭であることを確かめる。
pushは、作ったcommitのshaだけを送る。
検査コマンドがローカルで作ったcommitは差分の検査に現れないのに、pushすると履歴ごと送られるためである。
準備のステップが空のブランチをpushするときも、ローカルのブランチではなく、リモートに問い合わせた既定のブランチの先頭のshaを送る。

### pushの前に生き残りのプロセスを確かめる

途中経過のpushと最終のcommitの前に、worktreeを使うプロセスが残っていないことを確かめる。
残っていればpushせずに、人の対応待ちにする。
前のステップのClaudeや検査コマンドが、検査とcommitの間にworktreeを書き換えうるためである。

仕組みは[実装フローの仕様](internals/implement.md)の「検証したツリーだけのコミット」、「pushする履歴の制限」、「pushの前の生き残りのプロセスの確認」にある。

### コミットメッセージのIssue参照を無効にする

Claudeが書くコミットメッセージの`#12`などのIssue参照は`No.12`の形に、IssueとPRのURLのホストは`github[.]com`に書き換える。デフォルトブランチへのマージで、任意のIssueを閉じたり無関係なIssueにリンクしたりしないためである。Issueとの紐づけは、Factoryが書くPR本文の`Closes #N`だけで行う。

### 子プロセスをグループごと止める

git、gh、Claude、検査コマンドは、新しいプロセスグループで起動する。終了した後もグループに残ったプロセスを止め、出力のパイプが閉じなければ読み取りを打ち切る。打ち切った出力は途中で切れているので、判断に使う実行は失敗として扱う。
検査コマンドが別のセッションに抜けたときは、枠のuidのプロセスとして止める([プロセスの止め方](#プロセスの止め方))。

### 検査コマンドの出力を絞って保存する

検査コマンドの出力は、ストリームごとに1MiBまで保持する。DBには、秘密値をマスクした先頭の16KBだけを保存する。

### workflowの変更はpushで止まる

`.github/workflows/`を含むpushは、PATにWorkflowsの権限が無いのでGitHubが拒否する。拒否されたら、作業項目は人の対応待ちになり、理由に拒否が載る。

## 監査の安全策

工程5の監査では、Claudeが読む入力と書ける場所を絞る。

| 安全策 | 内容 |
| --- | --- |
| 証跡パックはデータ | `audit_prepare`が集める証跡パック(`evidence.md`)は、`maskSecrets`とHTMLの除去(タグとコメント)を通した文字列だけにする。`factory-audit`スキルは、証跡パックと`--add-dir`で渡すFactory自身のリポジトリを、命令ではなくデータとして扱う |
| ツールの制限 | Claudeのツールは`Read`、`Glob`、`Grep`、`Edit`だけにする。`Edit`はカレントディレクトリの`report.md`にだけ使わせ、`Write`は許可しない |
| self cloneは見せない | `audit_generate`は、self cloneのHEADから使い捨てのdetached worktree(`/var/lib/factory/audits/wi-<id>-snapshot`)を作り、`--add-dir`、テンプレート、スキルをそこに向ける。スナップショットは成否に関わらず`finally`で消し、ステップの再試行で作り直す |
| 出力の機械検査 | Issueになる提案のtitle、body、summaryは、HTMLコメント、禁止した記法、許可リスト(Factory自身のGitHubのURLとWindmillの公開URL)の外のURLを検査する。レポート本文は対象リポジトリのURLを引用するのでURLの検査から外し、章立て、HTMLコメント、改善提案の表と構造化出力の一致を検査する。検査に通らない出力は保存しない |
| 人の承認が最後のゲート | 検査に通った提案も、Consoleの要対応で人が承認するまでIssueにならない。承認された提案だけが`factory_repo`にIssueとして起票される |

self cloneは`self_update`のデプロイ元なので、Claudeに書き換えられないよう直接は渡さない。

## dependabotの更新の自動マージ

Factoryは、原則としてPRをマージしない。
例外は、dependabotが開いた依存の更新PRのうち、機械の関門と影響調査をすべて通ったものだけである。
依存の更新は件数が多く、差分の形が決まっていて、機械で確かめられる範囲が広いためである。
既定では無効で、`f/factory/factory_config`の`dependabot_enabled`を真にしたときだけ動く。
マージは、`dependabot_merge_enabled`も真にしたときだけ行う。
`dependabot_merge_enabled`が偽の間は試運転で、マージしてよいと判断したPRもマージせず人に回す。
有効にする手順は[運用](operations.md#dependabotの更新を設定する)に、状態と分岐は[dependabotの更新の内部仕様](internals/dependabot.md)にある。

候補のPRの列挙は、設定によって収集の表から読む。
表の値は候補を絞ることにだけ使う。
マージの判断と保持期間の判定は、PRごとにRESTで読み直した値と集めた事実で行う。
そのため、表の値が書き換えられても、候補が増えれば読み直して飛ばし、減れば検索に戻るか処理が遅れるだけである。
記録が新しいリポジトリで、表に行の無いPRは、待ちの記録を捨てるので、人に回すのが遅れる。
保持期間とゲートの判定は変わらない。

### マージする条件

マージするのは、次の条件をすべて満たすPRだけである。
1つでも満たさなければ、待つか人に回す。

| 関門 | 内容 |
| --- | --- |
| 対象のリポジトリ | `factory_repo`と、`repo_allowlist`に明示したリポジトリだけである。オーナーの全リポジトリは対象にしない |
| リポジトリの照合 | オーナーの数値IDと`factory_repo_id`が、設定と一致する。PRレビューの準備と同じ関門で、作業項目を作る前に確かめる |
| 作者 | PRの作者が`dependabot[bot]`で、種別がBotである。headが同じリポジトリにある |
| commit | 通常のcommitは、作者が`dependabot[bot]`、コミッターが`dependabot[bot]`か`web-flow`で、署名が検証済みである。mergeのcommitは、コミッターが`web-flow`で、署名が検証済みである |
| 更新の幅 | patchかminorである。majorの版と、更新の幅を判別できない版は人に回す |
| 変わるファイル | `package.json`、`bun.lock`、`console/package.json`、`console/bun.lock`だけである。保護パスに触れない |
| 対象 | ロックファイルの差分から導いた、ちょうど1つのパッケージの更新である。グループ更新は人に回す |
| ロックファイル | 対象のほかのエントリが変わらない。整合性ハッシュがnpm registryの`dist.integrity`と一致する |
| マニフェスト | 対象の依存の版指定のほかは変わらない。scriptsなどの変更は止める |
| install時のスクリプト | 更新先の版が、前の版に無いスクリプトか、中身の違うスクリプトを持たない。`binding.gyp`による暗黙のinstallも含む |
| 必須チェック | `main`の必須チェック7件が、そのheadで成功かスキップである。同じ名前の実行はすべて合格を求め、GitHub Actionsから来た実行が1件以上要る |
| マージできる | GitHubがマージできると判定している。判定の途中と競合のときは待ち、待ちの上限を超えたら人に回す |
| 公開の日数 | 更新先の版の公開から`dependabot_min_published_days`日(既定7日)以上たっている |
| マージの設定 | `dependabot_merge_enabled`が真である。偽なら、マージの直前の確認までを行い、マージせずに人に回す |

必須チェックの名前は、このリポジトリの`main`のrulesetの7件に固定している。
対象のリポジトリを足すときは、そのリポジトリのrulesetと必須チェックの名前が、この7件と同じかを確かめる。
食い違うと、関門が見ていないチェックが落ちていても、関門は通してしまうためである。

事実はすべて、最初に読んだheadとbaseのshaに固定して集める。
集めている間にheadかbaseが動いたら、古い事実で判断せず待つ。

### インストールの後の確認

関門を通ったPRは、headのshaの作業ツリーに依存をインストールしてから、影響を調べる。
インストールは`bun install --frozen-lockfile --ignore-scripts`で、検査コマンドと同じ隔離(非特権のuid、許可した環境変数、新しいHOME)で行う。
インストールの後に、次を確かめる。

- 作業ツリーに、インストール先(`node_modules`と`vendor`)のほかの変更が無い。
- インストールしたパッケージの名前と版が、対象と一致する。
- インストールしたパッケージのinstall時のスクリプトと`binding.gyp`の有無が、registryの値と一致する。
  registryの記述とtarballの中身の食い違い(manifest confusion)を止めるためである。
- 更新の前後で、registryが示すリポジトリのURLが同じ場所を指す。
  同じと確かめられなければ、サプライチェーンの懸念として人に回す。

### Claudeは関門を緩めない

影響調査のClaudeは、関門を通った後にだけ起動する。
ツールは`Read`、`Glob`、`Grep`だけで、`Bash`とネットワークは渡さない。
作業ディレクトリは、関門を通したheadのきれいな作業ツリーである。
変更履歴、PR本文、差分、registryの情報は、データとして区切って渡す。
`node_modules`の下のファイルに書かれた指示めいた文は、それ自体をサプライチェーンの懸念として報告させる。

Claudeの結論は、マージを止める方向にしか働かない。
懸念か未確認の項目が1件でもあれば、影響なしと答えても人に回す。
取得できなかった入力があれば、Claudeの答えに関わらず、コードが人に回す。

### 影響があるとき

影響があると判断したPRには、所見をPRのレビューとして投稿し、作業項目を終える。
修正のラベル(`factory:fix`)は自動で付けない。
所見は外部の入力から作られうるので、人が確かめてから修正に回すためである。
人がラベルを付けると、PR修正が動く想定である。
動くかは、有効化の前の確認で確かめる。
修正をpushしたPRは、commitの作者が`dependabot[bot]`でなくなるので、関門を通らない。
そのPRは、レビューの指摘が0件でも自動ではマージせず、人がマージする。

### マージの仕方

マージは、終了のステップだけが行う。
マージの直前に、PRとbaseのshaを読み直し、影響を調べたheadとbaseのままであることを確かめる。
headが動いていればマージせずに取り消し、新しいheadは改めて評価する。
baseが動いていれば、評価していない`main`にマージしないよう、取り消して評価し直す。
マージはsquashで、headのshaを固定して1回だけ要求し、題名を固定にする。
上流の文字列(release notesの`[skip ci]`など)が`main`のcommitに入らないためである。
結果が分からないときは再送せず、人に回す。

### PATのマージ権限

マージは、ほかのフローと同じPAT(`f/factory/github_token`)で行う。
PATの持ち主がrulesetを迂回できる管理者だと、マージのAPIが必須チェックの未達を止めない可能性がある。
その場合は、関門の必須チェックの確認が唯一の防御になる。
有効化の前に、PATで`main`へマージできるかと、迂回が働くかを確かめる。
マージが403で拒まれたときは、人に回し、権限とrulesetの確認を案内する。

### 守る部品と守らない部品

関門、収集、registryの取得、プロンプト、フローの支援関数、取得のscript、3つのステップ、フローの定義は保護パスにする。
一覧は[保護パスの変更を止める](#保護パスの変更を止める)にある。
共有のモジュールは守らない。
対象は、`lib/`の`dependabot_*`以外のモジュールと`steps/pr_workflow_support.ts`である。
たとえば`lib/github.ts`、`lib/db.ts`、`lib/workspace.ts`、`lib/check_sandbox.ts`が含まれる。
ほかのフローも使い、守るとそれらの変更をすべて止めてしまうためである。
これらを書き換えてdependabotの判断を変える変更は、PRのレビューで差分を確かめて止める。

### 有効化の前の確認

次の点は、実機でしか確かめられない。
確かめる順は3段階である。
最初に、フローを使わない単独の実験で、Claudeが`node_modules`の下の指示のファイルを読み込まないことを確かめる。
次に試運転(`dependabot_enabled`を真、`dependabot_merge_enabled`を偽)で、フローを実際のPRに通して確かめる。
試運転ではマージしないので、フローの不具合や想定外の入力があっても`main`は変わらない。
結果を確かめてから、`dependabot_merge_enabled`を真にする。
確かめた結果は、この節の残るリスクに反映する。

試運転の前に、単独の実験で確かめることは次のとおりである。

| 確かめること | 確かめ方 | 満たさないとき |
| --- | --- | --- |
| `node_modules`の下の`CLAUDE.md`と`AGENTS.md`を、Claudeが読み込まないこと | 置いたファイルを含む作業ツリーで、`--setting-sources user`のClaudeに読ませ、記憶として載らないかを見る | 試運転を始めない。影響調査の前に、そのようなファイルがあれば人に回す検査を足す |

単独の実験の結果は、`node_modules`の下の`CLAUDE.md`と`AGENTS.md`が読み込まれなかった。
起動時の記憶にも、そのディレクトリのファイルを読んだ直後の追加の文にも、置いた合図の語は現れなかった。
実験の設定は、本番と同じ`--tools Read,Glob,Grep`、`--setting-sources user`、`--strict-mcp-config`、`--restricted`である。
Claudeのバージョンが変わったときは、同じ実験をやり直す。

試運転で確かめることは次のとおりである。

| 確かめること | 確かめ方 | 満たさないとき |
| --- | --- | --- |
| 隔離したユーザーで、npm registryに届き、`--frozen-lockfile`のインストールが時間内に終わること | 試運転で起動したフローの、準備のステップの結果を見る | インストールの設定とステップのtimeoutを見直す |
| フローの式がWindmillで評価され、3つのステップが順に動くこと | 試運転で起動したフローの、各ステップの結果を見る | フローの定義を直す |
| `auto-merge`やdependabot用のrulesetの有無 | rulesetの一覧を読む | 修正のフローは、auto-mergeが有効なPRで止まる |
| dependabotが`bun.lock`を更新するか | 実際のPRの差分を見る | 更新しないなら、ロックファイルの無いPRは常に人に回る。運用で受け入れるか決める |
| Claudeの構造化出力の上限の指定が受け付けられること | 影響調査のステップの結果を見る | 出力の形を直す |
| 修正のラベルを付けたdependabotのPRを、PR修正が受けること | 所見の出たPRに人がラベルを付ける | 修正は人が行う。ラベルを自動で付ける判断は、確かめた後で行う |

マージの前に確かめることは次のとおりである。

| 確かめること | 確かめ方 | 満たさないとき |
| --- | --- | --- |
| 試運転で、マージ可と判定したPRの判断が妥当であること | 試運転で人に回ったPRの理由と所見を読む | マージを有効にしない |
| PATのマージ権限と、rulesetの迂回の有無 | PATの権限とrulesetの迂回の設定を読む | マージを有効にしない。迂回が働くなら、必須チェックの防御が関門だけになることを受け入れるか決める |
| 対象のリポジトリごとの、rulesetと必須チェックの名前 | 各リポジトリのrulesetを読む | 名前を合わせるか、そのリポジトリを`repo_allowlist`から外す |
| squashの空のcommit本文の扱い | 最初のマージのcommitを見る | commitの本文を直す |

### 残るリスク

- 上流が侵害された版でも、公開の日数、関門、影響調査をすべて通ればマージされる。
  公開の日数の待ち、registryとの整合性の照合、影響調査が、その機会を減らす。
- 影響調査の判断は誤りうる。
  マージの後の動作を最後に確かめるのは、必須チェックである。
- セキュリティ更新と版の更新を区別しない。どちらも同じ関門を通る。
- `node_modules`の下の`CLAUDE.md`と`AGENTS.md`は、単独の実験では読み込まれなかった。
  ただし、Claudeのバージョンが変わると結果が変わりうるので、更新のたびに同じ実験をやり直す。
  依存が同梱する指示のファイルが読み込まれれば、影響調査の判断に指示を注入される窓が開く。
- `main`が頻繁に動くと、マージの直前の確認で取り消しが続き、3回で人に回る。
- 共有のモジュールは保護していないので、書き換える変更はレビューで止める。
- 作ってから保持期間に近い日数がたったPRは、処理済みの記録が消えうる。
  そのため、評価せず人へ回し、自動では処理しない。

## 承認と権限

承認できるのは、`f/factory/**`のスクリプトを実行できるアカウントである。実行の権限はフォルダ`f/factory`の権限で決まり、このフォルダには所有者も追加の権限も付けていないので、ワークスペースの管理者だけが該当する。

承認は必ずConsoleの要対応(`approval_decide`を実行する)から行う。Windmillのapproval pageのURLは署名付きのcapability URLなので、PRのコメントやDiscordの通知に載せない。approval pageのURLから直接resumeすると承認の状態が記録されず、作業項目は人の対応待ちになる。

承認者は`f/factory/lib/approver.ts`の`deriveApprover`が導出する。記録先は`approval_requests.decided_by`と`issue_proposals.decided_by`である。Windmillのログインユーザー名(`WM_USERNAME`)を優先し、無ければ`WM_EMAIL`を使い、どちらも無ければ例外で処理を止める。呼び出し元が渡す引数は承認者として信頼しない。承認者が不明なまま既定値で記録することは無い。

## ラベル付与の制限

publicのリポジトリで第三者がラベルを付けてパイプラインを起動するのを防ぐため、トリガーラベルを付けた人を確かめる。
対象は、Issueの`factory`ラベルと、PRの`factory:review`、`factory:fix`ラベルである。

GitHubでは、ラベルを付けるのにtriage以上の権限が要る。
一方、Issueフォームが自動で付けるラベルは、起票者の権限によらず付く。
そのため、Issueフォームにはトリガーラベルを設定せず、ラベルを付けた人をFactoryが確かめて、許可された人でなければ反応しない。

### 付与者の確認

`poll_issues`と`poll_prs`は、IssueとPRのラベルのイベントから、トリガーラベルの最後の`labeled`か`unlabeled`を探す。
イベントはGraphQLで、直近100件のラベルのイベントだけを読む。
コメントや参照のイベントは含まれない。
ラベルのイベントを増やせるのは、ラベルを付け外しできる権限を持つ人と、その権限で動く自動化だけである。
自動化は、第三者の入力に応じてラベルを付け外しするActionsやAppを指す。
最後のイベントは、並び順ではなく、作成時刻の最大で決める。
作成時刻は秒単位なので、同じ秒のイベントが複数あれば、順序を判定できないものとして拒否する。
同じ秒のイベントは時刻が変わらないので、時間が経っても判定できない。
許可された人がラベルを外して付け直すと、新しいイベントが最後になり、判定できる。
最後のイベントが`labeled`なら、その`actor`のログイン名を確かめる。
他のラベルのイベントは見ない。
ラベルが一度外されて付け直されていれば、最後のイベントが対象になる。
ラベル名は、GitHubと同じく大文字小文字を区別せずに比べる。

`labeled`イベントは`author_association`を持たない。
そのため、付与者はGitHubの関係(OWNERなど)ではなく、ログイン名で判定する。

許可するのは、次のアカウントである。
大文字小文字は区別しない。

- FactoryのPATのアカウント。
- `factory_config`の`allowed_labeler_logins`に挙げたアカウント。
  既定値は空である。
  `allowed_labeler_ids`にIDを入れたアカウントは、`actor`の数値IDも一致するときだけ許可する。

次のどれかのときは、判定できないものとして拒否する。
許可されたものだけが通るので、判定の失敗が拒否に倒れる。

- トリガーラベルの`labeled`イベントが無い。
- ラベルが付いているのに、最後のイベントが`unlabeled`である。
  イベントの反映が遅れていて、今の付与者を特定できない。
- 作成時刻が最大のイベントが、同じ秒に2件以上ある。
- イベントに`actor`が無い(削除されたユーザーなど)。
- `allowed_labeler_ids`にIDを入れたアカウントの名前で、`actor`の数値IDが一致しない、または応答に無い。
  改名の後に、別の人が古い名前を取得した場合を含む。
- `actor`が人のアカウント(`User`)でない。
  GitHub Appなどのログイン名は`[bot]`を伴わないため、人のログイン名と取り違えないようにする。
- イベントを取得できなかった。
  そのポーリングでは対象にせず、次のポーリングで取得し直す。
- FactoryのPATのアカウントを取得できなかった。
  ポーリングのジョブが失敗し、何も始めない。
- 直近100件のラベルのイベントにトリガーラベルのイベントが無く、それより古いイベントが残っている。
  読んだ範囲では付与者が分からない。

拒否したときは、ラベルを外さずに、noticeの`labeler_denied`を記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
イベントの取得に失敗したときは、noticeを増やさず、失敗の記録を残す。Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
記録されるステップ名は、Issueが`fetch_labeler:<owner>/<repo>#<番号>`、PRが`fetch_pr:<owner>/<repo>#<番号>`である。

付与者を判定できないときは、失敗ではなく、noticeの`labeler_check_limit`を1回だけ記録する。
本文は対象とラベルだけで決まり、同じ本文の未解決のnoticeがあるあいだは追加しない。
次の操作として、ラベルを外し、許可された人が付け直すことを示す。
付け直すと、トリガーラベルの新しい`labeled`イベントが直近100件に入り、判定できるようになる。
人がラベルを外して付け直すまで、ポーリングのたびに同じ取得を繰り返す。
noticeは、対応した後にConsoleで解決する。

判定から取得までには時間差があるので、取得の直前に同じ確認をもう一度行う。
拒否されたときは、取得せずに`labeler_denied`を記録する。
取得できなかったときは、取得せず、失敗の記録に`confirm_labeler:<owner>/<repo>#<番号>`として残す。Consoleの**システム**の「作業項目に紐づかない失敗」に出る。
このときラベルは外れていないので、操作は要らない。
次のポーリングが、自動で拾い直す。
ラベルを付け直すと、付与者がその人に変わる。
そのため、この失敗を理由にラベルを付け直さない。

許可するアカウントに、他人の入力に応じてラベルを付ける自動化のアカウントを入れない。
FactoryのPATを使う自動化も、入れない。
GitHub Appがオーナーの代理でラベルを付けると、`actor`はオーナーになる。
そのため、第三者の入力に応じてオーナーの権限でラベルを付けるAppやワークフローを、設定しない。
自動化が第三者の入力でラベルを付けると、付与者の確認が素通りになるためである。
`[bot]`で終わるログイン名は、設定の検証で拒否する。

許可は、名前を基本に判定する。
アカウント名を変更すると、他人が古い名前を取得できる場合がある。
`allowed_labeler_ids`に名前とIDを対で入れたアカウントは、名前に加えてIDでも照合する。
IDは、ラベルのイベントの`actor`の`databaseId`と、PRの応答の`user.id`である。
どちらも追加の呼び出しなしで取れるので、IDを入れたアカウントの古い名前を別の人が取得しても、通らない。
IDを入れないアカウントは名前だけで照合するので、名前を変えたアカウントは、`allowed_labeler_logins`から外す。
設定の手順は[運用](operations.md#ラベルの付与者の数値idを固定する)にある。

`factory`ラベルを付け直すと新しいサイクルが始まり、同じIssueの承認済みの作業項目は取り消される。
そのため、ラベルを付けられる人は、承認の取り消しも起こせる。
許可するアカウントを増やすときは、この影響も含めて決める。

許可されていない人の操作を運用者に見せるnotice(`labeler_denied`)は、運用者が確かめないまま解決済みになることがある。
このnoticeは重要度が「情報」なので、要対応の一覧には出ず、Consoleのシステム画面に7日だけ出る。
その間に、許可された人がラベルを付け直してIssueかPRを取得すると、同じ対象の未解決のnoticeが解決済みになる。
対象の範囲は[通知とrate limit](internals/notifications.md)にある。
解決しなかったnoticeも、作成から`retention_logs_days`(既定30日)を過ぎると、DBの掃除が解決済みにする。
どちらの場合も行は残り、解決の時刻から同じ期間の掃除までは、解決済みの履歴として読める。
許可されていない人は、取得の条件である最後のラベル付与者が許可された人であることを満たせない。
そのため、この解決を起こせない。
Consoleからは解決できない種類だが、人の介在を減らすため、この自動の解決を受け入れる。

### 確認しない経路

ラベルを介さずに始まるレビューは、付与者ではなくPRの作成者で確かめる。
対象は、次の2つである。

- PRのレビュー依頼かassigneeにFactoryのアカウントが入っているときのレビュー。
- 追跡中のPRに新しいcommitが入ったときの再レビュー。

どちらも、PRの作成者が許可されたアカウントのときに限る。
許可されるのは、FactoryのPATのアカウントと`allowed_labeler_logins`のアカウントである。
`allowed_labeler_ids`にIDを入れたアカウントは、作成者の数値IDも一致するときだけである。
作成者を取得できないときは始めない。
Factoryが作ったPRの作成者はFactoryのPATのアカウントである。
そのため、Factory以外が追加したcommitで再レビューされる。

`factory:review`か`factory:fix`が、許可されていない人に付けられた状態で付いているPRでも、ラベルを介さないレビューは始めない。
ラベル名の大文字小文字がconfigと違っていても、同じラベルとして扱う。

同じリポジトリのブランチから出した第三者のPRは、許可されたアカウントがトリガーラベルを付けたときだけレビューされる。
新しいcommitが入るたびに、ラベルを付け直す必要がある。
自動の再レビューは起きない。
CODEOWNERSなどによるレビュー依頼も、作成者が許可されていなければ起動しない。

PRのheadが対象のリポジトリにないとき(forkのPRと、headのリポジトリを取得できないPR)は、許可されたアカウントがラベルを付けても、レビューを始めない。
forkの内容は第三者が書いたもので、信頼してレビューに渡せないためである。
見送ったときは、ラベルを外さず、noticeの`fork_head_denied`を記録する。

### 残るリスク

次のリスクは、受け入れている。

- 作成者が許可されたアカウントのPRに、書き込み権限のある共同作業者がpushすると、ラベル無しの再レビューが起動する。
  書き込み権限を持つ人は、信頼された共同作業者とみなす。
  Factory自身のpushは`setHeadSha`で記録されるので、起動しない。
- ラベルを付けた後から、いずれかの却下までの間に、起票者がIssueの本文を編集できる。
  取得の時点の本文が`work_items.body`に保存されるので、取得までの編集は要件定義の入力になる。
  却下や再実行による作り直しでは、その時点のIssueの内容が取り込み直されるので、窓は取得までから、却下までに広がる。
  起票者を信頼せず、ラベルを付ける人が内容を確かめる前提は、却下を挟むと弱まる。
  更新を承認者に知らせる通知(Discordとnotice)、Consoleの承認画面の警告、PR本文の注記で緩和している。
- 却下の理由が`intake refreshed from the current issue`で始まると、更新していなくても、取り込み直しの印として数えられ、警告とPR本文の注記が出る。
  警告が増える方向だけの誤りなので、許容する。
- 起票者がIssueを書き換え続けると、承認を止め続けられる。
  書き換えのたびに承認が断られ、却下で作り直すとClaudeの実行と試行が1回ずつ減り、`max_attempts`に達すると人の対応待ちになる。
  起票者を信頼できないリポジトリ、特に公開リポジトリを対象とする前には、ラベルを付けた後のIssueをロックし、編集を止める運用を決める。
  Issueの「Lock conversation」が起票者の本文の編集を止めるかは未確認である。採用の前に確かめる。
- 確認からラベルを外すまでの窓は数百ミリ秒である。
  付け直しを成功させるには、狙ったタイミングが要る。
- 書き込み権限のある人がラベルを改名すると、過去の付与が現在のトリガーラベルの付与として数えられる。
  書き込み権限を持つ人は、元から信頼する前提である。
- ラベルを付け外しできる権限で動く自動化が、第三者の入力に応じてイベントを積むと、判定不能が続く。
  判定不能は拒否に倒れるので、作業は始まらない。
- 拒否したトリガーラベルはPRに残る。
  人がラベルを外すまで、そのPRはラベルを介さないレビューの自動検出も止まる。
- Factory自身のPRで拒否したラベルのせいでサイクルが止まっても、気づく手段は「情報」のnoticeだけである。
  人がラベルを外すと、サイクルが再開する。

### 投稿者の関係の確認

PRのレビューとコメントは、投稿者で絞る。
許可する関係は`allowed_labeler_associations`で、既定値は`["OWNER", "MEMBER", "COLLABORATOR"]`である。
コメントとレビューの応答は`author_association`を持つので、この関係で判定できる。
これに当たらない投稿者のレビューコメントと新しいコメントは、`pr_review`と`pr_fix`の起動に使わない。

## 閉じた人の確認

`poll_issues`は、対象のIssueやPRが閉じられた作業項目を取り消し、Consoleの要対応の一覧から外す。
対象は、失敗、人の対応待ち、期限切れの作業項目である。
このとき、IssueまたはPRの取得の応答から、閉じた人を確かめる。
使うのは、`GET /repos/{owner}/{repo}/issues/{番号}`の次の項目である。

- `pull_request.merged_at`
- `closed_by`
- 作者(`user`)
- 作者の`author_association`

タイムラインの`closed`と`merged`のイベントには`author_association`が無いので、使わない。
判定は次の順に行う。ログイン名は大文字と小文字を区別せずに比べる。

| 順 | 状況 | 判定 |
| --- | --- | --- |
| 1 | PRで`merged_at`がある | 取り消す。マージにもmerge queueへの投入にも、write権限が要るため |
| 2 | `closed_by`が無い、またはログイン名が空 | 取り消さない |
| 3 | `closed_by`がBot(`type`が`Bot`、またはログイン名が`[bot]`で終わる) | 取り消さない。BotやActionsは、第三者のイベントを受けて閉じることがあるため |
| 4 | 作者が分からない | 取り消さない |
| 5 | 作者以外の人が閉じた | 取り消す。他人のIssueやPRを閉じるには、triage以上の権限が要るため |
| 6 | 作者が閉じ、作者の`author_association`が`allowed_labeler_associations`に含まれる | 取り消す |
| 7 | 作者が閉じ、作者の関係が含まれないか分からない | 取り消さない |

取り消さなかった対象は、一覧に残る。理由と対象は`poll_issues`のログにinfoで残す。

第三者が自分のIssueやPRを閉じて、安全策で止まった作業項目を一覧から消せないようにするためである。
publicのリポジトリでは、誰でもIssueを作れ、作者は自分のIssueやPRを閉じられる。
確認が無いと、安全策で止まった作業項目を、人が気づかないうちに一覧から外されてしまう。

この確認は、要対応の一覧から外す取り消しにだけかける。
取り消した作業項目は`retry_work_item`で再開できるので、権限のある人が元に戻せる。

残るリスクは次のとおり。

- PRのheadブランチやforkを消してPRが閉じたときの`closed_by`は、実機で確かめる。作者と別のアカウントが消すと、作者以外の人が閉じた扱いで取り消されうる。
- 人のアカウント(`type`が`User`)のPATで閉じる自動化は、Botとして扱われない。作者と別のアカウントなら、作者以外の人が閉じた扱いになり、取り消される。第三者のイベントで閉じる自動化は、`GITHUB_TOKEN`かGitHub Appのinstallation tokenで動かす。
- 判定は、要対応の一覧の取り消しにだけかかる。承認待ちなど終端でない作業項目は、既存のreconcileが閉じた人を確かめずに取り消す。
