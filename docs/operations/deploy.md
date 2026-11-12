# 更新の反映の運用

マージした変更をWindmillとホストへ反映し、反映を承認して確かめる手順である。
Factoryを運用する人が読む。
[運用](../operations.md)の手順のうち、更新の反映にかかわるものをこの文書に置く。

## 更新を反映する

### 自動で反映されるもの

`f/`、`migrations/`、`.claude/skills/`の変更は、自己更新のスケジュール(`self_update`、2分ごと)が自動で反映する。
ホスト側の操作は要らない。

自己更新は、`infra/`か`mise.toml`の`[tools]`・`[env]`の変更を検知すると、デプロイの記録(`deployments.needs_host_action`)に残す。
続けて、要対応の通知`host_action_required`とDiscordで知らせる。
これらは、ホスト側で`mise run up`するまで反映されない。
人が気づかないと、古い構成で動き続けるためである。

`mise.toml`の`[tasks.*]`だけの変更、`scripts/`の変更、`mise.local.toml.example`の変更は記録しない。
workerの動作に影響しないためである。

`f/factory/lib/workspace.ts`のgitの実行(`buildGitArgv`と`localGitEnv`)を変えたときは、反映の後に、sandboxの実装フローで確かめる。
clone、fetch、push、`git gtr new`が1回ずつ成功することを見る。
テストのoriginはローカルのパスで、`GIT_ALLOW_PROTOCOL`を上書きしているので、httpsでの動作はテストでは確かめられない。

### ホスト側で反映するもの

`infra/`と`mise.toml`の`[tools]`・`[env]`の変更は、次の手順で反映する。
ビルドはホスト側のcheckoutから行うので、先にmainを取り込む。

1. ホスト側のcheckoutで`git pull`する。
2. `mise install`で、`mise.toml`の`[tools]`のツールを入れる。
3. `mise run up`で起動し直す。
   workerのイメージの再ビルドとコンテナの再作成、Caddyの再起動まで行う。
   実行中の仕事があると、作り直す前に止まる([workerを作り直す前の確認](stages.md#workerを作り直す前の確認))。

`mise install`は、すでに入っているツールには何もしない。
miseの自動インストールが`mise run`の前に不足分を入れるかは、確かめていない。
そのため、通知の手順に`mise install`を含める。

`mise.toml`の`windmill-cli`の版を上げる変更では、反映の前に`mise run push:dry`を実行し、`deployed_sha`と凍結中のスケジュールが変更に出ないことを確かめる。
凍結の除外は、CLIの`--excludes`の挙動に依存するためである([凍結とdeployの保留の内部仕様の「凍結とdeployの保留」](../internals/freezes.md#凍結とdeployの保留))。

workerのメモリの上限のような`infra/docker-compose.yml`の変更も、`git pull`だけでは反映されず、`mise run up`で反映される。
マウントの変更では、該当するコンテナが作り直される。
Console用のworkerが作り直される間は、Consoleの問い合わせが待たされる。

tagを付けたscriptを反映する前に、そのtagを受けるworkerを起動し、カスタムtagを許可する。
受けるworkerが無いと、そのscriptのジョブは動かないためである。
tagごとのworkerは、`console`が`windmill_worker_console`、`periodic`が`windmill_worker_periodic`である。
workerを足すcomposeの変更は、次の順に反映する。

1. workerを足すcomposeの変更を、mainにマージする。
2. ホスト側のcheckoutで`git pull`し、`mise run up`でworkerを起動する。
   続けて`mise run instance:tags`を実行し、カスタムtagを許可する。
3. 次のコマンドで、コンテナが動いていることを確かめる。
   `mise exec -- docker compose -f infra/docker-compose.yml ps <サービス名>`
   Windmillの画面の「Workers」で、worker groupのworkerのtagが、そのtagだけであることも確かめる。
4. 確かめてから、scriptにtagを付ける変更をマージする。

tag`periodic`を付けるscriptの選び方は、[セキュリティ](../security.md#tagを付けるscriptの選び方)にある。

`mise run up`と`mise run deploy`は、`up -d`の前に、一時コンテナで`caddy validate`を実行し、Caddyfileを確かめる。
不正なら、そこで止まり、何も起動し直さない。
不正なCaddyfileのまま、Caddyの作り直しや再起動をすると、Caddyが落ちて再起動を繰り返し、公開の入口が止まるためである。
続けて、`up -d`の後に、Caddyを再起動する。
再起動の後に、動いているCaddyでも`caddy validate`を実行し、失敗したら止まる。
`restart`はコンテナを起動できれば成功を返し、直後に落ちても気づけないためである。
止まったときは、HEADを書かないので、通知は解決されない。
`infra/Caddyfile`は単一ファイルのbind mountで、`up -d`はcomposeの設定が変わらない限りCaddyを作り直さず、再読み込みもしないためである。
再起動しないと、古いCaddyfileのまま、次に書くHEADが反映済みを表してしまう。
`mise run up`を使わずにcomposeを直接実行したときは、Caddyの再起動もHEADの記録も行われない。

続けて、`scripts/record-host-applied.sh`を呼ぶ。
このスクリプトは、ホストのcheckoutのHEADを、workerの共有ボリュームの`/var/lib/factory/host_applied_sha`に書く。
書くのは作業ツリーではなくHEADなので、`infra/`か`mise.toml`に未コミットの変更を残したまま`mise run up`しても、HEADの版を反映済みとして書く。
そのときは、ホストの構成とHEADの食い違いを残したまま通知が解決されうるので、変更をコミットするか戻してから`mise run up`を実行する。
自己更新は2分ごとにこの値を読む。
通知`host_action_required`の版が、この値と同じか祖先であれば、通知を自動で解決する。
ホストのcheckoutがその版を含んで起動し直されたことを、確かめられるためである。
祖先でなくても、`infra/`と`mise.toml`の内容がこの値の版と同じなら、同じく解決する。
PRのブランチで先に`mise run up`した場合、マージの版はPRのブランチのHEADの祖先にならないが、反映した内容は同じだからである。

自己更新が反映した時点で、ホストがその版か、`infra/`と`mise.toml`の内容が同じ版を反映済みなら、通知とDiscordのどちらも出さない。
運用者が先に`mise run deploy`やPRのブランチでの`mise run up`で反映した場合に、操作の要らない通知を送らないためである。
通知を出すときと解決するときの両方で、その回の変更のパスだけでなく、`infra/`と`mise.toml`のすべてを比べる。
並行する2つのPRを両方とも先に`mise run up`してからマージしたとき、もう一方のPRの`infra/`の違いを見落とさないためである。
比べ方の詳細は[通知の仕様](../internals/notifications.md)にある。

値を書けなかったときは警告が出るが、起動は成功のまま終わる。
値のファイルが無いとき、通常のファイルでない(symlinkなど)か128バイトを超えるとき、版として読めないとき、self cloneに無い版のときは、通知を解決しない。
1回の実行で調べる未解決の通知は、版を読めたものの古い順に3件までである。
残りは次の回に調べる。
自動で解決されない通知は、`mise run up`が済んでいることを確かめたうえで、人がConsoleの**要対応**で解決してよい。
このスクリプトを持たない版から取り込む最初の1回は、先に`git pull`を済ませてから`mise run up`を実行する。
`mise run deploy`はpullの前のタスク定義で動くので、HEADを書かないためである。

まとめて反映したいときは、`mise run deploy`を手で実行する。
必須の手順ではない。
`mise run deploy`は次を順に行う。

1. 凍結とdeployの保留の確認。
   deployの保留が有効なら止まる。
   壊れていれば失敗し、読めなければ警告だけで進む([凍結とdeployの保留の内部仕様](../internals/freezes.md)の「失敗の回復」)
2. ホスト側のcheckoutで`git pull --ff-only`
3. Dockerの版の検査。
   Engineが26.0以上、Composeが2.26.0以上でなければ止まる
4. イメージの取得と、ビルドの対象のイメージ(`windmill_worker`と`console_fetcher`)のビルド
5. 一時コンテナでの`caddy validate`。
   不正なら止まる
6. 実行中の仕事の確認。
   workerが作り直されるときに、実行中の仕事があれば止まる
7. 取得とビルドを省いた`docker compose up -d`
8. Caddyの再起動と、動いているCaddyでの`caddy validate`
9. `wmill sync push`(凍結中のスケジュールを除く)に続けて、migrationの実行。
   1回の読み取りで続け、deployの保留が有効か、凍結を読めなければ止まる
10. 反映したHEADの記録
11. 自前でビルドした旧イメージの掃除([旧イメージの掃除](#旧イメージの掃除))

版の検査は`git pull --ff-only`の後に行う。
取り込んだ新しい版の検査を使うためである。
この検査と、実行中の仕事の確認を持たない版から取り込む最初の1回は、`mise run deploy`を使わない。
miseは起動の時点のタスク定義で動くので、取り込んだ検査が走らないためである。
`git pull --ff-only`を実行してから`mise run up`を実行する。
`wmill sync push`とmigrationも要るときは、その後に`mise run deploy`を実行する。
`mise.toml`の`[env]`に必須のキーが増える版を取り込む最初の1回は、`mise run deploy`が途中で止まる。
deployタスクの`git pull`の後の最初の`docker compose`が、新しい必須変数を読めないためである。
composeはファイル全体を補間するので、未設定の必須変数が1つあるだけで失敗する。
コンテナを変える前に止まり、反映は何も進まない。
pullは済んでいて、次の起動でmiseが新しい`[env]`を読むので、`mise run up`か`mise run deploy`をもう一度実行すれば通る。

`mise run push`と`mise run deploy`は、凍結中のスケジュールを除くラッパー(`scripts/freeze.ts`)を通る。
`mise run migrate`も同じラッパーを通り、deployの保留が有効か、凍結を読めなければ止まる。
`mise run up`は、Dockerの版の検査の後、コンテナを変える前に保留を確かめ、有効なら止まる。
凍結の変数が壊れていると、`mise run up`と`mise run deploy`の確認は失敗して止まる。
壊れた状態のまま反映すると、凍結を無視して上書きするおそれがあるためである。
人が`mise run freeze:reset`で変数を空に戻してから、実行し直す。
ラッパーは`wmill sync push`を`NPM_CONFIG_IGNORE_SCRIPTS=true`で動かす。
`wmill`がnpmを走らせることがあっても、依存のinstall scriptを動かさないためである。
理由は[セキュリティ](../security.md)の「サブプロセスのnpmのinstall script」にある。

#### 旧イメージの掃除

`mise run up`と`mise run deploy`は、HEADを記録した後に、自前でビルドしたイメージの旧版を消す。
再ビルドするたびに、置き換わった旧版がタグを失って残り、ディスクを使い続けるためである。
`windmill_worker`と`console_fetcher`のビルドにラベルを付け、そのラベルが付いて、タグの無いイメージだけを消す。
他のプロジェクトのイメージ、ボリューム、コンテナ、ネットワーク、ビルドキャッシュには触れない。
タグの付いたイメージも消さない。
ビルドするサービスを足すときは、同じラベルを`build`に付ける。
付け忘れると、そのサービスの旧版は残り続ける。

掃除に失敗しても、`mise run up`と`mise run deploy`は成功で終わる。
掃除は付随の処理で、HEADの記録の後に実行するので、反映の記録にも影響しない。
失敗したときは、標準エラーに警告が出る。

掃除が消すのは、使われていない旧版である。
次に掃除が成功した時点で消える。
コンテナ(停止中を含む)が参照する旧版は消えない。
`mise run up`が途中で止まると、掃除まで進まない。
`mise run build`は掃除をしないので、旧版は次の`mise run up`か`mise run deploy`まで残る。
消えた旧版には戻せないので、ロールバックは、チェックアウトを戻して再ビルドする。

次のイメージは、ラベルが無いので対象外で、ディスクを使い続ける。

- 取得した浮動タグのイメージ(`postgres:18`など)の旧版
- ラベルを足す前にビルドした旧イメージ
- ラベルを足した最初のビルドで置き換わる1つ前の版

すでに溜まったタグの無いイメージは、掃除が走っても消えないので、人が一度だけ手で消す。
`docker image prune`はホスト全体が対象で、他のプロジェクトのタグの無いイメージも消す。
`docker images -f dangling=true`で消える対象を確かめてから実行する。

ビルドのラベルを足すと、イメージの設定が変わる。
ラベルを足した版を最初に反映する`mise run up`か`mise run deploy`は、`windmill_worker`だけでなく`console_fetcher`も作り直す。
作り直しの前に、実行中の仕事の確認が走る([workerを作り直す前の確認](stages.md#workerを作り直す前の確認))。
この確認が見るのはworkerとDBだけで、`console_fetcher`の作り直しは確認の対象に入らない。

#### workerの同時実行数の設定を変えたときの反映

workerのコンテナが作り直されるので、実装中(`implementing`)の作業項目が無いときに`mise run up`を行う。
反映の前後に、`worker_ping`の行が1つであることを確かめる([枠の使用数の数え方を確かめる](monitoring.md#枠の使用数の数え方を確かめる))。
行が2つ以上なら、`NUM_WORKERS`か`I_ACK_NUM_WORKERS_IS_UNSAFE`が残っている。
作り直しの直後は、停止したコンテナの行が`ping_at`の絞りに5分残るので、5分待ってから数える。
反映の後に、古い本文で残った`console_worker_missing`と`worker_load_high`の未解決の通知を解決する。
本文が変わると、同じ原因の通知が2件目として記録されうるためである。

### migrationの前にdeployを保留する

migrationのように、反映を待たせたい作業の間は、deployの保留を置く。
保留が有効なあいだ、`self_update`は反映全体を見送り、`mise run push`、`push:prune`、`migrate`、`deploy`、`up`は、反映の前に止まる。
仕様と残るリスクは、[凍結とdeployの保留の内部仕様](../internals/freezes.md)にある。

1. `f/factory/deployed_sha`が、保留の仕組みを含むコミットに進んでいることを確かめる。
   進んでいないと、古い`self_update`は保留を無視する。
2. 保留を置く。
   上限は120分である。

   ```bash
   mise run freeze:place -- --scope deploy --minutes <n> --reason <text>
   ```

3. `mise run freeze:list`で、自分の行が残っていることを確かめる。
   この仕組みを知らない版の書き手が、保留を落とすことがあるためである。
4. `place`が表示する時刻(13分後)まで待つ。
   置く前に始まった`self_update`の回が、pushとmigrationを終えるまでの目安である。
5. 作業する。
   作業の直前と終わりにも`freeze:list`で、保留が残っていたことを確かめる。
   作業の途中で保留が落ちていたら、その間に反映が進んだかを`deployments`と`deployed_sha`で確かめる。
6. 保留を解除する。
   解除を忘れても、期限で無効になる。

   ```bash
   mise run freeze:release -- <id>
   ```

7. 次の`self_update`の回(2分以内)が、見送った範囲を反映する。
   `deployed_sha`がHEADに進み、`deployments`に成功の行が1件入ることを確かめる。

保留中に`deployed_sha`がHEADに追いつかないのは正常である。
版の食い違いの通知(`deployed_sha_mismatch`)は出ない。
見送りは通知せず、ログに`a deploy freeze is active, deferring the deployment`が出る。

`mise run deploy`は、先頭の確認を通った後に別の主体が保留を置くと、workerを作り直した後の反映で止まる。
保留を解除してから、`mise run deploy`をやり直す。
この仕組みを取り込む最初の`mise run deploy`は、`git pull`の前のタスク定義で動くので、古い`migrate up`が走る。
先に`git pull --ff-only`を実行してから、`mise run deploy`を実行する。

### 保護パスの変更の反映を承認する

自己更新は前回の反映からの変更に、Windmillへ反映する保護パスのファイルかmigrationがあると、人が承認するまで反映しない。
要対応の通知`deploy_approval_required`とDiscordで知らせる。
仕様は[反映の承認の内部仕様](../internals/deploy-approvals.md)にある。

止めるのは、自己更新が本番へ反映するファイルだけである。

- `migrations/`の下のファイルはすべて止める。
  自己更新が自動で適用し、表を消すような操作も書けるためである。
- `f/`の下と`wmill.yaml`は、保護パスに当たるファイルと、新しい`*.sh`だけを止める。
- `wmill-lock.yaml`と`*.script.lock`は止めない。
  依存の版を上げるたびに書き換わるためである。
- `infra/`、`.github/`、`.claude/`、`scripts/`、lockfile、設定のファイルは保護パスでも止めない。
  `infra/`はホストで人が`mise run up`するまで効かず、`.github/`はCIにしか効かない。
  `.claude/`のスキルと`scripts/`は自己更新が反映しないためである。
  これらの変更はPRのレビューで確かめる。

1. Consoleのシステムの画面を開き、「保留と凍結」の節の「反映の承認待ち」を見る。
2. 版と保護パスの一覧を、GitHubのmainの履歴と差分で確かめる。
3. 受け入れるなら「承認」を押し、確認のダイアログで承認する。
   次の自己更新(2分以内)がその版までの変更をまとめて反映する。
4. 受け入れないなら「却下」を押す。
   却下しても反映は止まったままなので、mainへ戻すPRを作ってマージする。
   戻した版では保護パスの差分が消えるので、次の自己更新が反映する。

承認は版ごとである。
承認する前にmainが進むと、新しい版の承認待ちに替わり、古い版の承認待ちは消える。
新しい版で承認し直す。
止めた状態は期限で解けない。

却下しても、要対応の通知は残る。
戻すPRの反映が成功するか、新しい版の依頼ができると、自動で解決される。
Consoleでは解決できない。

初めて反映する回(`f/factory/deployed_sha`が空)は止まらない。

通知を残せなかった回は通知を再送しない。
「反映の承認待ち」の一覧に依頼は出るので、通知が無くても承認できる。

### 反映の承認で自己更新が失敗し続けるとき

判定を読めない回は、自己更新のジョブが失敗し、反映しない。
2分ごとに失敗するときは、ジョブのログのエラーで原因を見分ける。

承認の表が無いときは、エラーに`run mise run migrate`が出る。
承認の仕組みを足した変更の反映で、`wmill sync push`だけが成功し、`wmill datatable migrate up`が失敗すると起きる。
ホスト側のcheckoutで`git pull --ff-only`を実行し、`mise run migrate`を実行する。
表ができると、次の回が依頼を作って止まるので、Consoleで承認すると反映が進む。

`f/factory/deployed_sha`の版が、self cloneに無いときは、差分を取れない。
履歴を書き換えた後などに起きる。
この回も反映せずに失敗する。
人が`f/factory/deployed_sha`を、self cloneのHEADへ手で書き換える。
書き換えた範囲は、承認を経ずに反映済みの扱いになる。
前回の反映の版からHEADまでの差分を、GitHubで先に確かめてから書き換える。

### 反映の計画を確かめる

ホストの実行役の`plan`で、あるコミットを反映したときの判定を、何も変えずに確かめる。
`mise run up`の前に、承認が要る変更の有無を知りたいときは、これを使う。
gitのオブジェクトを読むだけで、作業ツリー、ネットワーク、dockerには触れない。

```bash
bun --no-env-file ./scripts/host-apply.ts plan --repo <リポジトリのパス> --applied <適用済みのsha> --target <目標のsha>
```

shaは40桁の小文字の16進で指定する。
ブランチ名やタグ名は受け付けない。
`./`で始めるのは、`bun run`が同名の`package.json`のscriptを先に実行するのを避けるためである。
`--no-env-file`は、カレントディレクトリの`.env`をBunが読まないようにする。
承認の記録を使うときは、`--state-dir <記録のディレクトリ>`を足す。
記録は、その`applied`が`--applied`と一致するときだけ使われる。
手元で承認済みのコミットを仮定して確かめるときは、`--approved <sha>`を使う。
`--state-dir`とは同時に指定できない。

標準出力にJSONを1行で出力する。
`decision`の値は次の4つである。

| `decision` | 意味 | 次の操作 |
| --- | --- | --- |
| `noop` | 目標が適用済みと同じか、その祖先 | なし |
| `would_converge` | 承認が要る変更も静的検査の違反も無い。CIの結果は確認していない | mainのCIの結果を確かめてから反映する |
| `pending_approval` | 承認が要るファイルに触れる。`files`に一覧が載る | 一覧のファイルの差分を人が読み、問題が無ければ反映する |
| `rejected` | 静的検査に通らない。`kind`が理由で、`detail`に内容が載る | 変更を直す。実行役の許可リストが古いときは、許可リストを更新する |

終了コードは、判定が出れば0、コミットが無いなどの実行の失敗なら1、引数の誤りなら2である。
承認が要る変更の範囲と、静的検査の内容は、[ホストの実行役の境界](../internals/host-apply.md#ホストの実行役の境界)にある。

### 変更を承認する

`plan`が`pending_approval`を返す変更は、人が`approve`で承認する。
承認の記録は、`plan --state-dir`が読む。
`approve`は、端末で確認の文言を入力した人だけが記録を書ける道具で、Claudeの作業の中では動かない。
門の内容と残るリスクは、[承認の門](../internals/host-apply.md#承認の門)にある。

手順は次のとおりである。

1. ホストのメインのチェックアウトで、`git fetch origin`を実行して`origin/main`を更新する。
   リンクされたworktreeでは動かない。
   `HEAD`が`origin/main`に含まれ、実行するファイルが`HEAD`と同じでなければ、`approve`は止まる。
2. 適用済みのshaを、ホストのcheckoutの履歴で確かめる。
   `git reflog`で、最後に`mise run up`か`mise run deploy`を実行したときの`HEAD`を探す。
   実行の直前に`git pull`していれば、その`git pull`で`HEAD`が動いた行が手がかりになる。
   reflogは`HEAD`の動きだけを記録し、`mise run up`の実行は記録しない。
   実行した時点は、端末のシェルの履歴などで特定する。
   `scripts/record-host-applied.sh`が共有ボリュームに書く印は、`--applied`の値には使わない。
   workerのジョブが書き換えられるためである。
   印は照合にだけ使う。
   次のコマンドで読み、reflogで確かめた値と食い違えば、承認を始めずに原因を調べる。

   ```bash
   mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker cat /var/lib/factory/host_applied_sha | LC_ALL=C grep -xE '[0-9a-f]{40}'
   ```

   `mise exec --`を付けるのは、composeの定義が`DB_PASSWORD`を読むためである。
   付けないと失敗する。
   `grep`は、40桁の小文字の16進の行だけを通す。
   印に端末の制御文字が入っていても、端末に出さないためである。
   `grep`が何も出さないときは、印が不正という意味で、reflogと食い違うときと同じに扱う。
3. リポジトリのトップで、承認するコミットを指定して実行する。
   `<sha>`は7〜40桁の小文字の16進で、ブランチ名は受け付けない。
   `./`で始めるのは、`bun run`が同名の`package.json`のscriptを先に実行するのを避けるためである。
   `--no-env-file`は、カレントディレクトリの`.env`を読ませないために付ける。
4. 表示を読む。
   承認するコミット、差の始点、人が示した適用済みのsha、`origin/main`の先端、ファイルの一覧と差分が出る。
   `origin/main`の先端は、GitHubのmainの先端と照合する。
   refは同じユーザーが書き換えられるためである。
5. 差分は40行ずつ表示される。
   Enterで次へ進み、やめるときは`q`を入力する。
6. 最後のページの後に求められる文言を、そのまま入力する。
   一致しなければ、記録は書かれない。
7. `plan --state-dir`で、判定が`would_converge`になることを確かめる。
   `plan`の`--target`には、`approve`が表示した40桁のshaを渡す。

```bash
bun --no-env-file ./scripts/host-apply.ts approve <承認するコミットのsha> --applied <適用済みのsha>
bun --no-env-file ./scripts/host-apply.ts plan --repo . --applied <適用済みのsha> --target <承認したコミットのsha> --state-dir "$HOME/Library/Application Support/atelier-works-host"
```

記録の置き場は、`--state-dir`を省くと`~/Library/Application Support/atelier-works-host/`になる。
`--applied`の値が実際の適用済みと違うと、記録は`plan`に使われず、承認をやり直すことになる。

終了コードは、0が承認の記録、1が実行の失敗、2が使い方の誤り、3が承認しないである。
3のときは、標準エラー出力に、止まった門の理由が出る。

#### 差分が上限を超えたとき

差分が512KiBを超えると、終了コード3で止まる。
この道具では承認できないので、次のとおりにする。

- マージの前なら、PRを分ける。
- マージの後なら、mainのコミットを順に承認する。
  前の記録の`applied`が`--applied`と一致していれば、次の承認の差の始点が前の記録の`sha`に進むので、連鎖できる。
- 1つのコミットで上限を超えるときは、人が差分を読み、手で`mise run up`を実行する。

#### 承認できない文字を含むとき

承認するファイルの追加行に、許可した文字の外の文字があると、終了コード3で止まり、該当の行が見える表記で出る。
そのPRで、文字をASCIIか許可した文字に書き換える。
許可する文字は、[表示と文字](../internals/host-apply.md#表示と文字)にある。
追跡しているファイルの違反は、CIの`check`ジョブで止まるので、mainには入らない。

### f/とworkerのイメージを両方変えたとき

`f/`の変更が、新しいworkerのイメージを前提にすることがある。
例えば、検査コマンドを枠のユーザー(`factory-check-N`)で動かす`f/`は、イメージの`acl`、`procps`、`prlimit`と枠のユーザーを前提にする。
検査コマンドの設定が使う`bunx`(`/usr/bin/bunx`)も前提で、無いイメージは古いイメージとして止まる。
ベースのイメージが誰でも書き込めるようにしている`/usr/src/app`と`/tmp/.cache`を、イメージが閉じていることも前提にする。
マージすると、自己更新が2分以内に`f/`を反映するが、イメージは人が`mise run up`するまで古いままである。

この種の変更は、イメージを先に作り直す。

1. PRのブランチに、先にmainを取り込んでおく。
   `mise run up`はcheckoutの`infra/`でイメージを作るので、PRのブランチがmainより遅れていると、mainで入った`infra/`の変更が戻るためである。
2. 稼働中のworkerの状態を確かめる([稼働中のworkerの状態の確かめ方](#稼働中のworkerの状態の確かめ方))。
   1つ目の走査が何も出さず、2つ目の走査が`/usr/src/app`と`/tmp/.cache`のディレクトリそのものだけを出すことを確かめる。
   この2つは、次の`mise run up`で閉じる。
   ほかに出たものは、先に閉じる。
3. マージの前に、ホストのcheckoutでPRのブランチを取り込み、`mise run up`を実行する。
   新しいイメージは前の版の`f/`でも動く。
   前の版の`f/`は検査コマンドをrootのまま実行し、枠のユーザーとACLを使わないためである。
4. PRをマージする。
5. マージの後に、次のホスト側の反映に備えて、ホストのcheckoutをmainに戻して`git pull`する。
   マージの版の`infra/`と`mise.toml`が3で反映したPRのブランチと同じなら、自己更新は通知`host_action_required`を出さず、出ていても自動で解決する。
   1の後にmainへ`infra/`か`mise.toml`の変更が入っていると、内容が違うので通知が出る。
   そのときは、mainで`mise run up`を実行する。
6. 稼働中のworkerの状態を、2と同じ走査で確かめる。
   2つの走査が何も出さないことを確かめ、出たものは閉じる。

`f/`だけが先に反映された間は、検査コマンドのある実装とPR修正が、Claudeを動かす前に止まる。
実装とPR修正の準備のステップは、検査コマンドを設定したリポジトリでは、最初にイメージの前提を確かめるためである。
検査の準備も、所有権と枠の記録へ触れる前に同じことを確かめ直す。
準備から検証までの間に、イメージは変わりうるためである。

止まった作業項目の状態は次のとおりである。
理由はどちらも`worker image is stale: run mise run up`で始まる。

| フロー | 作業項目の状態 | 修正のラウンドの記録 |
| --- | --- | --- |
| 実装 | 人の対応待ち(`needs_human`) | 記録しない |
| PR修正 | `blocked` | 記録しない(`fix_rounds`の行を作らない) |

ラウンドを記録しないので、モデルの失敗にも数えず、`heavy_model`への切り替えを早めない。
要対応の通知`host_action_required`が1件残り、本文にイメージの満たさない前提が載る。
稼働中のworkerの問題も一緒に見つかれば、その問題は別の通知`check_runtime_unsafe`に載る([稼働中のworkerが検査の前提を満たさないとき](#稼働中のworkerが検査の前提を満たさないとき))。
CIの失敗を直す回は、止まった作業項目ではなく保留になり、監視(`watch_pr_ci`)が同じ通知を残す。
環境を直すと、保留は次の巡回で自動的に外れる。
`host_action_required`は`mise run up`の後に自動で解決されるが、ボリュームのマウントポイントは作り直しでは閉じないので、人が閉じるまで残すためである。
PR修正の`blocked`はConsoleの**要対応**の失敗に出ないので、この通知とDiscordの通知で気づく。

対処は、ホストのcheckoutで`git pull`し、`mise install`と`mise run up`を実行する。
通知の本文に反映した版が載っていれば、ホストがその版以降で`mise run up`したときに、自己更新が自動で解決する。
通知が自動で解決されると、止まった実装とPR修正を、自己更新が自動で再開する([実装フローの仕様](../internals/implement.md#イメージが古くて止まったとき))。
CIの失敗を直す回は除く([PRワークフロー](../internals/pr-workflow.md#ciの失敗を直す回))。
人の再実行は要らない。
同じ作業項目の自動の再開は3回までで、上限に達したときは、止まった作業項目をWindmillの`f/factory/retry_work_item`で再実行する。
版が載らない通知は自動では解決されず、自動の再開も起きないので、`mise run up`の後に人が解決し、止まった作業項目を`retry_work_item`で再実行する。
自動の再開の対象は、イメージが古い理由で止まった作業項目と、PRに終端でない回があって止まった実装だけである。
後者は通知を待たず、回が終わった後に再開する([実装フローの仕様](../internals/implement.md#回が終わるのを待って止まったとき))。
検査コマンドの実行ファイルを起動できずに止まった作業項目(理由は`check command could not run:`で始まる)は、イメージが前提を満たしていても止まるので、自動では再開しない。
実行ファイルを足すか検査コマンドを直した後に、人が`retry_work_item`で再実行する。

`/usr/src/app`か`/tmp/.cache`の下に誰でも書けるものがあれば、ベースのイメージが置いたものでも`check_runtime_unsafe`に載る。
この通知は`mise run up`の後も自動では解決されない。
[稼働中のworkerの状態の確かめ方](#稼働中のworkerの状態の確かめ方)の2つ目の走査で何も出ないことを確かめてから、通知を人が解決する。

#### 稼働中のworkerの状態の確かめ方

ホストのcheckoutで、次の2つの走査をする。

1つ目の走査は、ボリュームの中から、誰でも書けるもの(symlinkを除く)を探す。
検査の準備の走査は、ボリュームのマウントポイントそのものしか見ないためである。
検査を枠のユーザーで動かす前の版では、rootが検査コマンドを実行するので、誰でも書けるworktreeやファイルが`/workspaces`に残りうる。
残ったままだと、検査用のユーザーがそこへ書き込める。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker /usr/bin/find /workspaces /var/lib/factory -xdev '!' -type l -perm -0002 -print
```

2つ目の走査は、検査の準備と同じ走査である([検査コマンドの実行と権限の内部仕様](../internals/check-sandbox.md#誰でも書き込めるものの探し方))。
引数は`f/factory/lib/check_sandbox.ts`の`worldWritablePathsArgv`と同じである。
食い違わないことは`tests/lib/check_sandbox.test.ts`が確かめる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker \
  /usr/bin/find -P / /dev/shm -xdev -path /tmp/windmill -prune -o '!' -type l -perm -0002 \
  '!' '(' -path /tmp -o -path /var/tmp -o -path /run/lock -o -path /dev/shm ')' \
  '(' -path /usr/src/app -o -path '/usr/src/app/*' -o -path /tmp/.cache -o -path '/tmp/.cache/*' \
  -o '!' '(' -path '/tmp/*' -o -path '/var/tmp/*' -o -path '/run/lock/*' -o -path '/dev/shm/*' ')' \
  -o '(' -uid 0 -type d '!' -perm -1000 ')' ')' -print
```

出たものは、次のコマンドで、中のものも含めて閉じる。
`<パス>`には、走査が出したパスを1つずつ指定する。
ボリュームのマウントポイント(`/workspaces`と`/var/lib/factory`)そのものが出たときは、`-R`を付けずに`chmod o-w`で閉じる。
`-R`を付けると、ボリュームの中のすべてに及ぶためである。
閉じたら、同じ走査をもう一度実行し、何も出ないことを確かめる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod -R o-w <パス>
```

### 稼働中のworkerが検査の前提を満たさないとき

検査の準備は、イメージの前提のほかに、稼働中のworkerに誰でも書き込めるパスが無いことを確かめる。
イメージのビルドが同じことを確かめるので、見つかったパスは稼働中にできたものである。
共有の一時ディレクトリの下で数えるのは、rootが所有し、stickyでない、誰でも書き込めるディレクトリだけである。
ただし、`/tmp/.cache`とその下では、ファイルも数える。
探し方は[検査コマンドの実行と権限の内部仕様](../internals/check-sandbox.md#誰でも書き込めるものの探し方)にある。
走査がタイムアウトしたときと、走査が失敗したときも、同じ扱いにする。

止まった作業項目の状態とラウンドの記録は、[f/とworkerのイメージを両方変えたとき](#fとworkerのイメージを両方変えたとき)の表と同じである。
理由は`worker runtime is unsafe for checks:`で始まる。
要対応の通知`check_runtime_unsafe`が1件残り、本文にパスか、確かめられなかった理由が載る。
イメージの問題ではないので、`mise run up`は要らない。
CIの失敗を直す回は、止まった作業項目ではなく保留になる。
環境を直すと、保留は次の巡回で自動的に外れる。
監視は、問題が稼働中のworkerのパスの列挙の失敗だけで、実在するパスが1件も無い回には、通知を残さず警告のログだけにする。
イメージが古い回は、列挙に失敗していても、`host_action_required`と`check_runtime_unsafe`の両方を残す。
ログで理由を確かめるときは、`watch_pr_ci`のジョブのログを見る。

対処は、ホストのcheckoutで次のどちらかを行う。

- 本文のパスを閉じる。

  ```bash
  mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker chmod o-w <パス>
  ```

- workerのコンテナを作り直す。
  ボリュームの外はイメージの状態に戻るので、稼働中にできたパスも消える。
  ボリュームのマウントポイント(`/workspaces`と`/var/lib/factory`)は直らないので、上のコマンドで閉じる。
  マウントポイントの権限は、コンテナではなくボリュームが持つためである。
  作り直すと、そのとき動いているジョブも止まる。

  ```bash
  mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker
  ```

続けて、止まった作業項目をWindmillの`f/factory/retry_work_item`で再実行し、通知を人が解決する。
走査のタイムアウトで止まったときは、workerの負荷を確かめてから再実行する。
同じパスが繰り返しできるときは、そのパスを作るジョブを確かめる。

### mise run upで反映されないもの

| 変更 | 反映のしかた |
| --- | --- |
| `infra/Caddyfile`(composeを直接実行したとき) | bind mountしたファイルなので、`up -d`はコンテナを作り直さない。`mise run up`と`mise run deploy`は起動の後にCaddyを再起動するが、composeを直接実行したときは、`mise exec -- docker compose -f infra/docker-compose.yml restart caddy`で再起動する |
| `mise.toml`の`[tools]`のうちホスト側のCLI | `mise install`か`mise run setup`で反映する |

`mise run up`が反映するのは、`[env]`に書いたworkerのイメージのツールのバージョンである。

### workerのツールのバージョン

workerのイメージに入れるツールのバージョンは、`mise.toml`の`[env]`で固定し、`infra/worker/Dockerfile`のbuild argとして渡す。

| ツール | 変数 |
| --- | --- |
| `claude` | `CLAUDE_VERSION` |
| `gh` | `GH_VERSION` |
| `gitleaks` | `GITLEAKS_VERSION` |
| `gtr` | `GTR_REF` |
| `wmill` | `WMILL_VERSION` |

`CLAUDE_VERSION`には、`2.1.282`の形の版番号だけを書く。
記録する版を、インストールした`claude --version`の値と一致させるため、ビルド時の検査は版番号だけを通す。
`stable`や`latest`などの名前は、検査で落ちる。

`WM_VERSION`を上げるときは、新しいベースのイメージのPATHを`docker image inspect`で調べる。
それを`infra/worker/Dockerfile`の`ENV PATH`と突き合わせる。
ベースのPATHに必要なディレクトリが増えていれば、`ENV PATH`に足す。

ツールの追加やバージョンの変更には、workerのイメージの再ビルドが要る。
`gitleaks`は、実装フローが毎ラウンドの固定の検査として`--redact`付きで実行するために入れている。
版はホスト側のpre-commitのフックと同じである。

### 同期されない変数とリソース

`wmill sync push`に`--include-secrets`を付けてはいけない。
付けると、値を空のままコミットしている`f/factory/*.variable.yaml`で、4つの秘密の変数が空に上書きされる。
対象は`claude_oauth_token`、`github_token`、`wmill_token`、`discord_webhook_url`である。
`mise run push`は`--include-secrets`を付けない設定になっている。

秘密の変数とインスタンス固有の`factory_config`のリソースは、同期の対象外である。
説明文(description)を変えても、`mise run push`では既存のインスタンスに反映されない。
既存のインスタンスでは、WindmillのVariablesとResourcesの編集画面で説明文だけを直す。
新しいインスタンスは、bootstrapがリポジトリの説明文で作る。

`f/factory/deployed_sha`変数も同期の対象外である。
自己更新が書き込む実行時の状態だからである。
`bootstrap`は初回だけ空の値で作り、既にあれば値を変えない。
値を戻したいときは、Windmillの画面で直接編集する。

`f/factory/stop_all`、`f/factory/stop_all_record`、`f/factory/credential_expiry`も同期の対象外である。
`stop_all`は全停止の状態で、Consoleと`mise run stop`が書く。
`stop_all_record`は全停止が止めた`*_enabled`の名前の記録で、全停止が書き、`mise run stop:restore`が空にする。
`credential_expiry`は資格情報の期限の記録で、`mise run bootstrap`が書く。
同期すると、無関係なpushで全停止が外れたり、記録が消えたりする。

### リポジトリから消したものをWindmillから消す

リポジトリから消したscriptやappは、`mise run push`ではWindmillに残る。
`mise run push`と自己更新は`--keep-deleted`を付けるので、削除を反映しない。
消すのは、人が`mise run push:prune`で行う。
端末で`yes`を入力して確かめる。
先に`mise run push:dry`で、消える対象を確かめる。
消したものは、Windmillのゴミ箱に3日残る。

廃止した旧Consoleのapp(`f/factory/factory_console`)が残っているときも、この手順で消す。
マージ後に`mise run push:dry`を実行し、`f/factory/factory_console`が消える対象に出ることを確かめる。
確かめたら、人が`mise run push:prune`を実行する。
消えても、過去のリンクは新しいConsoleに着く。

### Console(console/)を反映する・戻す

`console/`の変更は、`main`にマージされて`console-dist.yml`が成功すれば、数分で`console_fetcher`が取り込んで反映する。
`self_update`は関与しない。
`console-dist.yml`は、draw.ioのビューアを外部から取得する。
取得に失敗したときの対応は、[Consoleの配信の仕様](../internals/console.md)の「ビューアの取得」にある。
`infra/console_fetcher/`の変更は、ほかの`infra/`と同じく次の`mise run up`で反映される。
取得元や検証を変える変更は、マージ後に`mise run up`でfetcherのイメージを作り直すまで反映されない。
それまでは、古いイメージが新しい取得元の成果物を見つけられず、`artifact_missing`になる。
配信中の版は変わらない。
急ぎではないが、マージしたらすぐ`mise run up`を実行する。
`infra/Caddyfile`は、`mise run up`と`mise run deploy`が起動の後にCaddyを再起動して反映する。
composeを直接実行したときは、次のコマンドでCaddyを再起動する。
Caddyを再起動するまで、`/console/drawio.html`には`frame-ancestors 'none'`のヘッダーが付き、図のページを埋め込めない。

```bash
mise exec -- docker compose -f infra/docker-compose.yml restart caddy
```

`console_fetcher`は5分ごとに、`main`へのpushで成功した`console-dist.yml`の最新の実行を探す。
同じcommitの`ci.yml`も成功していることを確かめ、実行中か失敗していれば、その前の候補を選ぶ。
その成果物`console-dist`を検証して`factory_console`の`releases/<sha>/`に置き、`current`を付け替える。
状態は`status.json`に書き、ログにも出す。
`status.json`には、`state`(`ok`、`failed`、`pinned`)、`sha`、`checked_at`、`error`が入る。

```bash
mise exec -- docker compose -f infra/docker-compose.yml logs --tail 50 console_fetcher
```

版は、配信するファイルの中身(`manifest.json`の`files`)が違うものを3つまで残す。
版は`main`へのpushのたびに作られ、`console/`に触れないpushでできた版は中身が同じなので、1つと数える。
無関係なマージが続いても、戻せる版を押し出さないためである。
数える対象は、直近20回のpushの範囲である(`history.json`が覚えている回数)。
共有の`assets/`は、残した版から参照されず14日を超えたファイルを消す。

新しい版に問題があれば、直前の版に戻す。

1. `mise run console:rollback`を実行する。
   取り込みの最中なら`console_fetcher is updating the console right now.`と出て止まるので、少し待ってやり直す。
2. 戻すと`pin`が置かれ、自動の付け替えが止まる。
   もう一度実行すると、さらに1つ前に戻る。
3. `main`に修正を入れてCIが成功したら、`mise run console:unpin`で`pin`を外す。
   5分以内に最新の版へ戻る。

戻し先は、中身が今の版と違い、マニフェストと`assets/`のファイルが揃っている最も新しい版である。
中身が同じ版へ戻しても、何も変わらないためである。
揃っていない版は、配信するとページが壊れるので選ばない。
そのような版が残っていないと、`No previous release with different content to roll back to.`と出て止まる。
この場合と、残っている版より前に戻したい場合は、`main`で該当のcommitをrevertし、CIを動かす。

戻すと、戻した元の版と、それと中身が同じ版を消す。
その版だけが参照する共有の`assets/`のファイルも、更新日時にかかわらず消す。
`pin`の間も、問題の版のscriptを`/console/assets/`から読めるままにしないためである。
消す版のshaは`pin`の`rolled_back_from`に、戻した元の版の中身(`files`のsha256)は`rolled_back_content`に記録する。
消し終わらなかったときは、`console:rollback`が`The rollback succeeded, but removing ...`で始まる文を出す。
続きは`console_fetcher`が次の取り込みで消す。
戻した元の版のshaと中身は、`pin`とは別に、ボリュームの`revoked.json`にも記録する。
この記録は`pin`を外しても残り、記録にある版は、`console:rollback`の戻し先に選ばれない。
取り込みの整理は、保持の数え方にかかわらず、記録にある版を先に消す(配信中の版は消さない)。
消えた版のshaも記録に残り、その版は取り込みの候補から外れる。
戻した元のcommitは、`pin`を外した後も再び配信されない。
shaと中身の記録は、それぞれ100件まで残し、超えると古いものから捨てる。
`rolled_back_from`を持たない`pin`では、戻した元の版は消えない。
消した版のページを開いたままのブラウザは、assetsを読み込めなくなる。
開いたままのタブは、配信中の版の`/console/manifest.json`と`/console/status.json`を読んで、自分の版を確かめる。
確かめるのは、表示した直後と、その後60秒ごと、タブが見える状態に戻ったとき、画面の部品の読み込みに失敗したときである。
タブが見えないあいだは周期の確認をしない。
見える状態に戻ったときは、前の確認から5秒以上空いていれば確認する。
1回の確認は10秒で打ち切る。
確認が失敗し続けるあいだは、間隔を10分まで倍々に延ばし、成功したら60秒に戻す。
画面が読み込んだファイルのどれかが配信中の版に無ければ、再読み込みを促す帯を画面の上端に出す。
配信中の版に無いファイルを読み込んでいて、版を戻して`pin`で固定している間や、そのファイルがもう取れないときは、目立つ色の帯で再読み込みを求める。
一度目立つ色の帯を出したタブは、帯を下げない。
確かめに失敗したときは、表示を変えない。
Caddyfileを更新してCaddyを再起動するまでは、`/console/status.json`が`index.html`に落ちて状態を読めない。
その間は、`pin`による目立つ色の帯は出ない。
無かったファイルが404のときの目立つ色の帯と、控えめな帯は出る。

`revoked.json`の扱いは次のとおり。

- 中身が壊れているか形が違うときは、`revoked_state_unreadable`をログに出す。
  壊れたファイルは`revoked.json.corrupt-<epochミリ秒>`(同じ時刻なら`-<番号>`付き)へ移し、新しい方から5個まで残す。
  空の記録で続けるので、戻す操作と整理は止まらない。
- 権限やディレクトリになっているなど、読む操作が失敗したときは、`revoked_state_read_failed`をログに出す。
  中身の破損ではないので、ファイルは移さない。
  空の記録で続けるので、戻す操作と整理は止まらない。
  その回は、記録による除外と削除が効かない。
  `console:unpin`は、記録し直す段階で同じ読む失敗に当たり、`--force`を付けても失敗して`pin`を残す。
  先に権限などの原因を直す。
- `console:rollback`が記録を書けなかったときも、戻す操作は成功する。
  `revoked_record_failed`をログに出す。
  同じ内容を`pin`が持ち、`console:unpin`が記録し直すためである。
- `console:unpin`が記録を書けなかったときは、失敗を出して`pin`を外さない。
  原因を直してやり直す。
- 戻した元の版と同じ中身が、別のcommitの最新の成功した実行として配信し直されると、その中身は記録から外れる。
  `console:unpin --force`で外して`console_fetcher`が取り込んだ場合も同じである。
  外れたときは`revoked_digest_cleared`をログに出す。
  ワークフローを通った中身を意図して配信し直したものとして扱うためで、記録を手で編集する必要は無い。
- 外す処理が失敗したときは、`revoked_digest_clear_failed`をログに出す。
  記録は残るので、その中身の版は戻し先に選ばれず、配信中の版でなくなると整理が消す。
  原因を直すと、次にその中身が配信されるときに外れる。

戻した元の版のマニフェストを読めないと、その版の中身を`pin`に記録できない。
このとき`console:rollback`は、`The files of the release rolled back from could not be recorded`で始まる文を出す。
この`pin`は、`console:unpin`がshaだけを照らすので、外す前に最新の`console-dist.yml`の結果を確かめる。

`pin`を外すと、`console_fetcher`は最新の成功した実行を取り込む。
その実行が戻した元の版と同じ中身だと、問題の版が再び配信される。
`console/`に触れないマージでも、同じ中身の版が新しいcommitで作られるので、commitのshaだけでは見分けられない。
`console:unpin`は、最新の成功した実行のshaと、その実行の`files`のsha256を、`pin`の記録と`revoked.json`の記録を合わせたものと照らす。
`console:rollback`を重ねて`pin`が書き直されても、前に戻した版を落とさないためである。
`revoked.json`の記録は、その中身が配信し直されるまで残る。
shaと中身(sha256)の記録は、整理で外れない。
以前に戻した中身を、別のcommitで意図して配信し直すときの出口は、`--force`である。
戻した元のcommit自体は、`--force`で外しても再び配信されない。
同じ中身の修正は、新しいcommitで`main`に入れる。
次の場合は`pin`を外さず、理由を出して止まる。

| 状況 | 人がすること |
| --- | --- |
| `pin`を読めない(JSONでない、`rolled_back_from`や`rolled_back_content`の要素がshaやsha256の形でない) | 最新の`console-dist.yml`の結果を確かめ、`--force`で外す |
| 最新の成功した実行のshaが、戻した元の版のshaである | 修正を`main`に入れ、その`console-dist.yml`が成功してからやり直す |
| 最新の成功した実行の`files`が、戻した元の版と同じである | `console/`を変える修正を`main`に入れ、その`console-dist.yml`が成功してからやり直す |
| 最新の実行を調べられない(トークンや`CONSOLE_GITHUB_REPO`の不備、ネットワークの失敗) | 原因を直してやり直す |
| 最新の実行の`files`を調べられない(成果物の取得か検証に失敗) | 原因を直してやり直す |
| 戻した元の版を消せていない | このコマンドの出力か`console_fetcher`のログの`revoked_cleanup_skipped`、`revoked_cleanup_failed`を確かめ、原因を直してやり直す |

`pin`と`revoked.json`のどちらにも中身の記録が無いときは、shaだけを照らす。
戻した元の版の記録がどちらにも無いときは、照らす版が無いので、問い合わせずに外す。
`pin`の`sha`と配信中の版が違うときは、取り込みが`pin_mismatch`をログに出す。
これは検出だけで、状態は変えない。
違いが続く間は、取り込みのたびに出る。
`pin`を読めないときは、`pin_read_failed`をログに出し、状態は`pinned`のままにする。

確認を飛ばすオプションは2つある。
`mise run console:unpin -- --force`は、`pin`と最新の実行についての確認(上の表の前の5行)を飛ばす。
問題の中身が別のcommitで再び配信されるのを承知の上で使う。
`mise run console:unpin -- --ignore-cleanup`は、戻した元の版を消せていない確認を飛ばす。
`--force`だけでは、この確認は飛ばない。
`--ignore-cleanup`で外しても、消せていない版は`revoked.json`に記録が残る。
`console_fetcher`は、次の取り込みの整理でその版を消し、`console:rollback`もその版を戻し先にしない。
手で消す必要は無い。
消せない原因は、上の表の最後の行と同じ見方で確かめる。
ログに`revoked_cleanup_skipped`が続くときは、原因を直す。

主な`error`と対処は次のとおり。

| `error` | 意味 | 人がすること |
| --- | --- | --- |
| `config_missing` | `CONSOLE_GITHUB_TOKEN`が無いか、`mise.toml`の`CONSOLE_GITHUB_REPO`の形が違う | 直して`mise run up`する |
| `auth_failed` | トークンが失効した | 再発行して投入し、`mise run up`する |
| `forbidden`、`not_found` | トークンの対象リポジトリか権限(Actions: Read)が違う | トークンと`mise.toml`の`CONSOLE_GITHUB_REPO`を確かめる |
| `rate_limited` | GitHub APIの呼び出し回数の上限に達した | 何もしなくてよい。5分ごとの次の確認で再試行し、その間も今の版を配信し続ける |
| `no_successful_run`、`artifact_missing`、`artifact_expired` | 取り込める成果物が無い | `console-dist.yml`の実行の結果を確かめ、必要なら`main`にpushして動かす |
| `digest_mismatch`、`manifest_mismatch`、`zip_unsafe_entry`、`unexpected_redirect` | 検証に失敗した | 今の版を配信し続けるので急ぎではないが、原因を調べる |
| `asset_conflict` | 新しい版の`assets/`のファイルが、既にある同じ名前のファイルと中身が違う(`console/public/assets/`の名前の付け替え忘れなど) | 置き換えると配信中の版が壊れるので取り込まない。名前を直したcommitを`main`に入れる |

取り込みの失敗は、10分ごとの見張り(`console_fetch_watch`)が通知とDiscordに知らせる。
知らせる原因は、取り込みの失敗、結果が30分以上更新されていないこと、状態を読めないことである。
同じ原因の未解決の通知がある間は、通知を重ねず、Discordにも送らない。
運用者が通知を解決した後に原因が続いていれば、次の確認で通知が1件でき、Discordにも届く。
`rate_limited`と`github_unavailable`は自然に直ることが多いので、どちらかが60分以上続いたときだけ知らせる。
2つの間で入れ替わっても、60分の数え始めは戻さない。
取り込みの側が新しくなって未知の分類が来たときは、通知の本文と原因を`unknown_code`にそろえる。

通知の種類は、失敗が`console_fetch_failed`、停止と読めないことが`console_fetch_stale`である。
どちらも「要対応」で、正常に戻っても自動では解決しない。
原因を確かめて取り除いたら、Consoleで通知を解決する。
固定(`pin`)した状態は、更新が新しければ異常としない。

Discordの通知とConsoleの通知には、上の表の次の操作が載る。
詳しい原因は、取り込みのコンテナのログで確かめる。

### タグのrulesetを確かめる

`main`という名前のタグの実行は、`main`のブランチの実行と見分けがつかない。
そのため、rulesetの`protect-tags`で、すべてのタグの作成、更新、削除を禁止している。
迂回できるのは、リポジトリの管理者のロールだけである。

設定は、次のコマンドで確かめる。

```bash
gh api repos/<owner>/<repo>/rulesets
```

一覧に、名前が`protect-tags`で対象が`tag`のrulesetがあり、有効(`enforcement`が`active`)なことを確かめる。
詳しい中身は、一覧の`id`を使って`gh api repos/<owner>/<repo>/rulesets/<id>`で読む。
中身では、作成、更新、削除の規則があり、迂回できる者が管理者のロールだけなことを確かめる。
無いときは、rulesetを作り直すまで`console_fetcher`の取り込みを信頼しない。

### Console用workerを確かめる

Console用のworker(`windmill_worker_console`)は、`mise run up`で作られる。
ワーカーグループ`console`に属し、tag`console`のジョブだけを受ける。
どのscriptをこのworkerで動かすかは、scriptの`tag`で決める。
このworkerには、`factory_state`のボリューム全体をマウントしない。
ボリューム全体とは、`factory_state`の最上位を指す。
`claude`、`gh`、`audits`、`requirements`などが並ぶ層である。
まず`mise run doctor`を実行する。
Dockerの版と、起動中のworkerのマウントを判定する。
`sh -c`を渡す`exec`(下のマウントの判定のコマンド)は、フックが拒否する。
そのため、Claudeのセッションでは人が実行するか、`mise run doctor`を使う。
動いていることは、コンテナの状態とログで確かめる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml ps windmill_worker_console
mise exec -- docker compose -f infra/docker-compose.yml logs --tail 20 windmill_worker_console
```

DBにワーカーグループの設定があると、composeの環境変数`WORKER_TAGS`ではなくそちらの値が使われる。
そのため、Windmillの画面の「Workers」で、グループ`console`のworkerのtagが`console`だけであることを確かめる。
詳しくは[セキュリティ](../security.md)の「Console用workerの境界」にある。

メモリとプロセス数は、最初のジョブを動かしている間に確かめる。
`docker stats`は`windmill_worker_console`の行を見て、`MEM USAGE / LIMIT`の使用量が上限の1GiBに収まっていることを確かめる。
プロセス数の上限は256なので、`pids.current`にも余裕があることを確かめる。

```bash
mise exec -- docker stats --no-stream
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker_console cat /sys/fs/cgroup/pids.current
```

このworkerがボリュームに書くのは、ログと専用の依存キャッシュ(`worker_console_dependency_cache`)だけである。
再起動しても、キャッシュのボリュームは残る。
ボリュームを消したときは、次のジョブで依存をレジストリから取り直すので、外向きの通信が要る。

このworkerは、要件定義書のディレクトリ(`factory_state`のサブパス`requirements`)を読み取り専用でマウントする。
サブパスのディレクトリが無いと起動しないので、1回限りのサービス`factory_state_init`が先に作る。
このサービスは、`requirements`がsymlinkなら失敗で終わり、そうでなければ`mkdir -p -m 0755`を実行して正常に終了する。
停止したコンテナが残る。
`mise run up`のたびに実行し直すが、ディレクトリがあれば何も変えない。
既存の環境でも、`mise run up`を1回実行すれば、このworkerが作り直されて新しいマウントになる。
`windmill_worker_console`が起動しないときは、このサービスのログを確かめる。
`requirements is a symlink`と出たときは、`requirements`を通常のディレクトリに直してから、`mise run up`を実行し直す。

```bash
mise exec -- docker compose -f infra/docker-compose.yml ps -a factory_state_init
mise exec -- docker compose -f infra/docker-compose.yml logs factory_state_init
```

symlinkを消す手順は次のとおりである。
defaultのworkerで動いたコードがsymlinkを置いた可能性がある。
`ls -la`に出るリンク先を控え、置いた経緯を調べてから消す。

1. `factory_state_init`の一時コンテナで`ls -la`を実行し、`requirements`が`->`でリンク先を示すsymlinkであることを確かめる。
   ボリューム名は、Composeが解決するので指定しない。
2. 同じ形の一時コンテナで`rm`を実行する。
3. `mise run up`を実行する。
   `factory_state_init`が成功し、`requirements`が通常のディレクトリとして作られる。
4. Console用のworkerを作り直す。

```bash
mise exec -- docker compose -f infra/docker-compose.yml run --rm --no-deps --pull never --entrypoint ls factory_state_init -la /var/lib/factory
mise exec -- docker compose -f infra/docker-compose.yml run --rm --no-deps --pull never --entrypoint rm factory_state_init /var/lib/factory/requirements
mise run up
mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker_console
```

> [!WARNING]
> `rm`の対象は、`ls -la`で確かめたsymlinkだけにする。
> パスの末尾に`/`を付けない。
> 付けるとリンク先のディレクトリを指す。
> `-r`と`-f`は付けない。
> `requirements`が通常のディレクトリなら、`rm`は何も消さずに失敗する。

作り直す段が要る理由は、Composeが、設定の変わらない、動いているworkerを作り直さないことである。
作り直さないと、symlinkの先をマウントしたworkerが残る。

> [!NOTE]
> `factory_state_init`は`read_only`で、権限もすべて落としている。
> この条件でも`rm`は通る見込みである。
> `factory_state_init`が新しいボリュームで`mkdir`できたのと同じ条件(所有者がrootでモードが0755の`_data`)だからである。
> 実機では確かめていない。
> `--pull never`は、外向きの通信が無いときでも使え、余計なpullをしないために付ける。
> `rm`が権限のエラーで失敗したときは、出力を控えて、運用者が対処を決める。

マウントが想定どおりかは、起動中のworkerの中から、`factory_state`のボリューム全体がマウントされている証拠が見えるかで判定する。
正しい設定では、`/var/lib/factory`はコンテナのrootfsにあり、その下にはマウント先の`requirements`しか無い。
証拠は次の2つである。

- `/var/lib/factory`の直下の`claude`、`gh`、`audits`。
  ボリューム全体を`/var/lib/factory`にマウントする設定で作られたworkerが残っていると見える。
  直下の名前なので、owner名とはぶつからない。
- `/var/lib/factory/requirements/requirements`。
  `volume.subpath`が無視されて、ボリューム全体が`/var/lib/factory/requirements`にマウントされると見える。
  ボリューム全体には`factory_state_init`が必ず`requirements`を作るためである。
  ただし、対象リポジトリのowner名が`requirements`だと、サブパスだけが正しく付いていても見える。

`docker inspect`のSourceは、サブパスを反映しないので、判定に使わない。

判定は1回の`exec`で行い、`sh -c`の終了コードで結果を返す。
composeの失敗(1、126、127など)とぶつからないよう、専用の値を使う。

- 11なら、ボリューム全体がマウントされている証拠は見えない。
- 10なら、ボリューム全体がマウントされている証拠が見える。
- 3なら、マウント先が見えない。
  マウントが設定どおりに付いていないので、`mise run up`を実行してから、Console用のworkerを作り直す。
- ほかの終了コードか、コンテナが動いていないときは、確かめられない。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker_console sh -c 'test -e /var/lib/factory/claude || test -e /var/lib/factory/gh || test -e /var/lib/factory/audits && exit 10; test -d /var/lib/factory/requirements || exit 3; test -e /var/lib/factory/requirements/requirements && exit 10; exit 11'; echo "exit=$?"
```

`mise run doctor`は同じ判定をし、画面には終了コードではなく`console worker mount`の行を出す。

- 11は、OKと「`factory_state`のボリューム全体はマウントされていません」を出す。
- 10は、NGを出す。
  メッセージは「/var/lib/factory/requirements/requirements」か「/var/lib/factoryの直下のclaude、gh、audits」で始まる。
- 3は、NGと終了コードを出す。
- workerが起動していないときは、確かめられない旨をOKで出す。
  このとき、マウントは判定されていない。

NGの行が10を表すときは、次の2つの`ls`でどちらの証拠が見えたかを確かめる。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker_console ls -la /var/lib/factory
mise exec -- docker compose -f infra/docker-compose.yml exec -T windmill_worker_console ls -la /var/lib/factory/requirements
```

- 1つめの`ls`に`claude`、`gh`、`audits`のどれかが並べば、ボリューム全体が`/var/lib/factory`にマウントされている。
  Dockerの版を下限以上にし、Console用のworkerを作り直す。
- 2つめの`ls`に`requirements`が並ぶのは、次のどちらかのときである。
  ボリューム全体が`/var/lib/factory/requirements`にマウントされているか、owner名が`requirements`でサブパスだけがマウントされている。
  この判定では見分けられないので、`requirements/requirements`だけが見えても、正常とは断定しない。
  見分けられない分は、Dockerの版の下限と、workerの作り直しで補う。
- `audits`は、監査を1回実行するまで作られない。
  `gh`は、作られないことがある。
  4つの名前が揃わなくても、ボリューム全体がマウントされていることがある。
  名前が揃うことを、ボリューム全体がマウントされている条件にしない。

この判定が見分けるのは、ボリューム全体がマウントされたかどうかだけである。
symlinkの先がマウントされた場合は見分けられないので、その疑いは、上の`ls -la`で確かめる。

Dockerの版は`mise run doctor`で確かめる。
`doctor`はworkerが作り直されたかを確かめないので、作り直しは別に行う。
次のコマンドで作り直す。

```bash
mise exec -- docker compose -f infra/docker-compose.yml up -d --force-recreate windmill_worker_console
```

`mise run up`は、設定の変わらないworkerを作り直さない。
ボリューム全体がマウントされる原因として考えられるのは、次の2つである。

- ボリューム全体をマウントする設定で作られたworkerが残っている。
- DockerのEngineかComposeが下限に届いていない。

### adminsワークスペースの組み込み項目

Windmillは起動時に、`admins`ワークスペースへ組み込みのscriptとscheduleを作る。
「Synchronize Hub Resource types with instance」などである。
これらはWindmill本体の一部で、このリポジトリの管理対象ではない。
`mise run push`と自己更新の同期にも含まれない。
summaryが英語のままなのはそのためで、日本語化と削除はしない。

Factoryの資産は、すべて`factory`ワークスペースの`f/factory/**`にある。

### workerがプロセスを作れなくなったとき

workerのコンテナは、`init: true`でdocker-initをPID 1にし、終了した子プロセスを回収する。
ジョブが起こすgit、gh、esbuildの子プロセスは、親より長く残ることがある。
initが無いと、回収されないプロセスが上限を使い切り、すべてのジョブが`errno=11`(EAGAIN)で失敗する。
上限は、defaultのworker(`windmill_worker`)が`pids: 1024`、nativeのworker(`windmill_worker_native`)が`pids: 512`である。
defaultのworkerは検査コマンドを動かすので、その分を足している([プロセス数の上限の決め方](../internals/check-sandbox.md#プロセス数の上限の決め方))。
Console用のworker(`windmill_worker_console`)と定期ジョブ用のworker(`windmill_worker_periodic`)は、どちらも`pids: 256`である。

同じ症状が出たら、使用量を確かめてからworkerを再起動する。

```bash
mise exec -- docker compose -f infra/docker-compose.yml exec windmill_worker cat /sys/fs/cgroup/pids.current
mise exec -- docker compose -f infra/docker-compose.yml restart windmill_worker
```
