# PRワークフローの安全策の内部仕様

PRのレビューと修正のフローが持つ安全策の実装と、PR修正の安全策の理由を書く。
安全策を変更する人と、その変更をレビューする人が読む。
フローの全体、検査コマンドの実行、準備での確認と、ほかの節の置き場は、[PRワークフローの仕様](../pr-workflow.md)にある。

## 安全策の実装

PR修正はClaudeに書き込みのツールを渡すので、次の安全策を持つ。
実装フローと共通の仕組みは[実装フロー](../implement.md)にも書く。
安全策を変えたときのE2Eの検証は、本番のIssueやブランチではなく、捨てるブランチとPRで行う。

### Claudeに渡すツールの制限

PR修正のClaudeに渡すツールは`Read,Glob,Grep,Edit,Write`だけで、`Bash`は渡さない。
起動のオプションは次のとおりである。

| オプション | 目的 |
| --- | --- |
| `--permission-mode dontAsk` | 確認なしで実行する。`Edit`と`Write`を拒否する既定の動作を上書きするため |
| `--allowedTools Edit Write` | `Read`、`Glob`、`Grep`に加えて、`Edit`と`Write`だけを許可する |
| `--restricted` | `Bash`などのコードを実行するツールと`WebFetch`を外し、ファイルのツールを作業ディレクトリ(`--add-dir`を含む)に閉じる |

`--restricted`はネットワークを遮断しない。
PRレビューのClaudeには、読み取り専用のツールだけを渡す。

### stepの間で渡す引数

PRレビューとPR修正のflowは、Claudeの出力やPRの本文とパスを含む値を、前のstepの結果のまま次のstepの引数にしない。
Windmillが、引数の文字列が参照の形で始まると、実行者の権限で値に置き換えるためである。
値は1つのJSONの文字列(`untrusted`)に封じて渡す。
flow.yamlの式が`JSON.stringify(...)`で作り、受け取るstepが`parseUntrustedArg`で戻す。

次の4つのstepの境目が、この形で渡す。

| 受け取るstep | `untrusted`に入れる値 |
| --- | --- |
| `pr_review_post` | 総評、判定、指摘、スレッドへの答え、変更ファイルのパス、変更の範囲、バイナリのパス |
| `pr_fix_apply` | 指摘、コメント、競合したファイルのパス |
| `pr_fix_verify` | 修正の理由、要約、返信、コミットの件名と本文、指摘、コメント、競合したファイルのパスと3つのblobのsha、PRのheadのブランチ名 |
| `pr_fix_finish` | 理由、要約、返信、コミットの件名と本文、指摘、コメント、競合したファイルのパスと3つのblobのsha、PRのheadのブランチ名 |

数、sha、GitHubの名前、作業用の置き場など、参照の形を取れない値は、包まずに渡す。
封じ方、包まない値の基準、検査するテストは、[stepの間で渡す引数](../../security.md#stepの間で渡す引数)にある。

### 禁止パスによる停止

修正の差分に次のどれかが含まれると、検証のステップが止める結果を返す。
作業項目は人の対応待ちになる。

- `.claude/`、`.agents/`、`.github/workflows/`、`.github/actions/`、`.mise/`、`.config/mise/`、`.lefthook/`の下のファイル
- `console/public/`、`infra/console_fetcher/`の下のファイル
- `scripts/host_apply/`、`infra/worker/`、`mise/`の下のファイル
- `scripts/claude-hooks/`、`tests/scripts/claude-hooks/`、`mise-tasks/`、`.mise-tasks/`の下のファイル
- 個別のファイル(一覧は下の説明を参照)
- `mise.toml`、`mise.*.toml`、`.mise.toml`
- `.tool-versions`、`.env`、`.env.*`、`.node-version`、`.bun-version`
- `lefthook.yml`、`lefthook-local.yml`、`lefthook.toml`、`lefthook.json`
- `bunfig.toml`、`.npmrc`、`.gitattributes`、`.gitmodules`、`wmill.yaml`、`wmill.yml`
- markdownlintとmarkdownlint-cli2の設定(`.markdownlint.*`と`.markdownlint-cli2.*`。拡張子は`jsonc?`、`ya?ml`、`[cm]?js`)
- textlintの設定(`.textlintrc`と`.textlintrc.*`)
- Biomeの設定(`biome.json`、`biome.jsonc`)と`.gitignore`
- `package.json`の`scripts`の変更
- 新しく追加した`*.sh`

一覧の本体は、`f/factory/lib/protected_paths.ts`の次の3つの定数である。

- `FORBIDDEN_PATH_PREFIXES`
- `FORBIDDEN_EXACT_PATHS`
- `FORBIDDEN_BASENAME_PATTERNS`

`steps/pr_workflow_support.ts`が判定の関数を再exportして使う。
実装フローが記録だけに使う一覧(`IMPLEMENT_PROTECTED_PATH_PREFIXES`など)は別の定数で、PR修正の判定には使わない。

ディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する。
個別のファイルは、ルートからの相対パスの完全一致で判定する。
ファイル名の一覧は、ディレクトリを問わずファイル名で判定する。

`console/public/`と`console/index.html`は、Consoleでバンドルを通らずにそのまま配信され、ページの中で動く。
`console/index.html`はファイル名だけではほかの`index.html`と区別できないので、パスで判定する。
個別のファイルの一覧は、`FORBIDDEN_EXACT_PATHS`にある。
一覧には、次の種類が入る。

- 反映の設定: `wmill.yaml`。
  `codebases`の`customBundler`は反映時にシェルで実行され、`assets`の`from`は任意のパスのファイルを読むため。
  別名の`wmill.yml`と、サブディレクトリの`wmill.yaml`は、ファイル名で止める
- Consoleのページの入口: `console/index.html`
- draw.ioのビューアの固定: `console/drawio-viewer.json`
- 固定を書き換えるPRを作る側: `f/factory/drawio_viewer_bump*`と、それが使う`f/factory/lib/`の3ファイル
- 固定を強制し、配信物を作って検査する側: `console/scripts/`の一部、`console/vite.config.ts`、`scripts/check-console-lockfile.ts`
- 配信の設定: `infra/Caddyfile`
- 図を隔離して描くiframeの検査: `tests/lib/drawio_frame_isolation.test.ts`
- scriptの定義の`lock`の参照先を固定する契約テスト: `tests/lib/script_yaml_lock_contract.test.ts`
- テストの実行環境: `tests/preload.ts`。
  `bunfig.toml`の`preload`が全テストの前に読み込み、書き換えられるとテストの前にコードが走るため
- CIの実行の範囲を決める側: `scripts/ci-scope.ts`
- カバレッジの下限の検査と、そのテスト: `scripts/check-coverage.ts`、`tests/scripts/check_coverage.test.ts`。
  下限の定数、層の下限の表、除外の一覧、対象の定義を、自動の修正が書き換えて検査を緩めるのを防ぐため
- CIが出すメタデータのパッチを取得して検査する側: `f/factory/lib/metadata_patch_*.ts`の6つと、それぞれの`.script.yaml`。
  lockは`metadata_patch_manifest.script.lock`だけ(空のlockの参照)
- hashの再計算の側
  - 部品: `lib/metadata_{hash,precheck,signature,git_ports}`の`.ts`と`.script.yaml`
  - 配線: `lib/ci_metadata_rehash`の`.ts`と`.script.yaml`
- ホストの実行役が実行するファイル
  - 入口と導入: `scripts/host-apply.*`、`scripts/host-install.sh`
  - 版の確認と記録: `scripts/check-docker-version.sh`、`scripts/record-host-applied.sh`
  - 実行中の仕事の確認: `scripts/check-idle.ts`と`tests/scripts/check-idle.test.ts`
  - 診断と初期化: `scripts/doctor.sh`、`scripts/bootstrap.sh`、`scripts/custom-tags.ts`
  - composeの定義: `infra/docker-compose.yml`、`tests/infra/docker_compose.test.ts`
  - 実行役のテストと補助: `tests/scripts/host_apply_*.test.ts`と`tests/fixtures/host_apply_repo.ts`をファイル名で列挙する

実行役が実行するファイルは、ホストのユーザーの権限で、秘密値を渡して動く。
`infra/docker-compose.yml`は、実行役が静的に検査して反映する定義である。
実行役のテストは、実行役の判定を固定する。
テストをグロブでなくファイル名で列挙する理由は、足したテストの列挙し忘れを、保護パスの契約テスト(`tests/lib/protected_paths.test.ts`)が見つけるためである。
詳しい理由と限界は、[ホストの実行役の境界](../host-apply.md#ホストの実行役の境界)にある。

`console/drawio-viewer.json`は、CIが取得して配信するビューアの取得元とsha256を固定する。
書き換えられると、別のスクリプトが固定の値として配信される。
固定を書き換えるPRを作る側は、書き換えられると、人の確認なしに別の版や取得元を固定するPRを作れる。
固定を強制する側のスクリプトは、書き換えられると、検査をすり抜けた内容が配信物に混ざる。
`scripts/ci-scope.ts`は、書き換えられると、検査のジョブを黙って飛ばせる。
`f/factory/lib/metadata_patch_*.ts`は、パッチの取得先とトークンの渡し先、zipの読み方、パッチに載せてよい内容を決める。
書き換えられると、パッチの受け取り側の検査が緩む。
hashを再計算する4つの部品は、hashの算法、再計算してよい条件、`main`の引数の比べ方、検査が読むオブジェクトの取り方を決める。
書き換えられると、依存が変わるPRや、入力のスキーマが変わるPRのlockを、人の確認なしに書き換えさせられる。
`lib/ci_metadata_rehash`は、`wmill-lock.yaml`だけの変更を許す条件と、書き込み先を決める。
書き換えられると、再計算と一致しないlockを、検査を通してpushさせられる。
例外を開くコールバックの本体(`steps/pr_fix_verify.ts`と`steps/pr_fix_finish.ts`)と`lib/ci_fix_round.ts`は、一覧に入れない。
日常的に直すファイルで、入れるとその正当な変更を止めるためである。
これらを書き換えて例外の条件を緩める変更は、マージ前の人のレビューで止める。
`infra/Caddyfile`には、Consoleのscriptの許可と、draw.ioの図を隔離するCSPがある。
`infra/console_fetcher/`は、配信物を検証して配信する。
どちらも書き換えられると、検証や隔離をすり抜けた内容が運用者のブラウザで動く。
図を隔離して描くiframeの検査は、書き換えられると役目を果たさなくなる。
sandboxを外したり、別のページをiframeに読ませたりしても、検査を通るためである。

markdownlint-cli2の設定は、`customRules`、`markdownItPlugins`、`modulePaths`で任意のモジュールを`import()`できる。
textlintの設定は、`rules`の名前からモジュールを解決して読み込む。
どちらもpre-commitの文書の検査と`mise run lint:docs`が読むので、書き換えられると、人の手元とCIでコードを実行される。

### 変更パスの取得

変更パスは、次の2つの和集合で取る。

```bash
git status --porcelain -z --untracked-files=all --ignore-submodules=none
git diff --name-only -z
```

symlinkのモード(`git ls-files -s -z`)と差分の行数(`git diff --numstat -z`)も、NUL区切りで読む。
引用符付きのパス(非ASCII文字や制御文字を含むもの)でも、禁止パス、symlink、差分の大きさの判定を素通りしない。

未追跡のディレクトリは`dir/`の1件にまとめず、中のファイルを1件ずつ判定する。
そのため、まだ無い`.github/`の下に作ったworkflowも止める。
renameは新しいパスと元のパスの両方を判定するので、禁止パスへの移動も、禁止パスから外への移動も止める。

symlinkのモードを引くときは`--literal-pathspecs`でパスを文字どおりに渡す。
`*`や`[`を含む名前を、別のファイルに一致させないためである。

### symlinkと特殊なファイルの検出

main cloneのconfigには`core.symlinks=false`を書いておく。
このモジュールが実行するgitには、`-c core.symlinks=false`も付ける。
`-c`は`.git/config`や`config.worktree`より優先されるので、検査コマンドがそこで`true`に戻しても、このモジュールのgitには効かない([この文書の「gitが読む設定を限る」](#gitが読む設定を限る))。
configに書いた値は、このモジュールを通さずにClaudeや検査コマンドが実行するgit向けの既定である。
PR修正の検証は、symlinkの新規作成(未追跡のものを含む)、変更、削除、typechangeで止める結果を返す。
symlinkは次の3つで探し、どれかで見つかれば止める。

| 探し方 | 見つけるもの |
| --- | --- |
| 索引のモード(`git ls-files -s -z`) | 追跡しているsymlink |
| 削除以外の変更パスの`lstat` | 検査コマンドが作ったものなど、未追跡の新しいsymlink |
| `git diff --raw --no-renames -z --ignore-submodules=none HEAD`のモード | 通常のファイルとして置かれた追跡済みのsymlink |

`core.symlinks=false`のworktreeでは、追跡済みのsymlinkが通常のファイルとして置かれる。
その中身を書き換えると指す先が変わるのに、`readlink`と`lstat`はsymlinkと報告しない。
そのため、HEADと作業ツリーのモードも比べる。
変更、削除、typechangeを含む。

検証のステップは、次の変更パスでも止める結果を返す。

- 末尾が`/`のパス(`git status`が未追跡の入れ子のリポジトリを`dir/`の1件にまとめたもの)
- 要素が`.git`のパス(大文字と小文字を区別しない)
- HEADと作業ツリーの`git diff --raw`で、古いか新しいモードがgitlink(`160000`)のパス。
  サブモジュールのディレクトリを消したgitlinkの削除も止める。
- 削除以外の変更パスのうち、`lstat`が通常のファイルとsymlinkのどちらでもないもの(ディレクトリ、FIFO、デバイスなど)

パスが無い以外の理由で`lstat`が失敗したときは、検証を失敗させる。
これらとsymlinkのどれかで止めるときは、`package.json`の中身と差分の行数を読まない。
symlinkの先やFIFOを読まないためである。

### 変更を調べる時点

検証のステップは、変更の一覧と上の判定を次の時点で行う。

- Claudeの実行の後
- Claudeの再実行の後
- 検査コマンドが通った後(1回目の検査が通ったときと、再実行の後の2回目の検査の後)

判定するのは、禁止パス、symlink、入れ子のリポジトリ、通常のファイルでないもの、`package.json`のscripts、差分の大きさである。
`allowed_check_commands`は対象リポジトリのコードなので、保護パスのファイルやsymlinkを作りうる。
そのため、検査コマンドの後にも調べる。

### HEADとブランチの確認

検証のステップは、変更を調べる前に毎回、次の2点を確かめる(`checkHead`)。
違えば止める結果を返す。

- worktreeのHEADが、準備のステップが見たPRのhead(`head_sha`)である。
- `git symbolic-ref HEAD`が`refs/heads/<PRのheadブランチ>`である。

検査コマンドがローカルでcommitやブランチの切り替えをすると、HEADを基準にした変更の一覧から、そのcommitの変更が消えるためである。
準備のステップの結果に`head_sha`か`branch`が無いときも止める結果を返す。

### worktreeの.gitの検証

worktreeの`.git`の書き換えを止める。
参照先を別のディレクトリに向けると、そこに置いた`config`のfilterやfsmonitorなどを、次のgitがrootで実行するためである。
Claudeが起動するときに実行するgitも含む。
検証の仕組みは[実装フロー](../implement.md)の[worktreeの.gitの検証](../implement.md#worktreeのgitの検証)と同じである。

PR修正の各ステップは、次のように確かめる。

| ステップ | 確かめる時点 | 違うとき |
| --- | --- | --- |
| 準備 | worktreeを用意した直後に`.git`を1回だけ読み、検証して記録する | 例外 |
| 修正 | Claudeを起動する前 | Claudeを起動せずに止める結果を返す |
| 修正と検証 | Claudeの不正な出力への再試行の前 | 再試行しない |
| 検証 | 変更を調べる前と、検査コマンドの後にClaudeを再実行する前 | gitとClaudeのどちらも実行せずに止める結果を返す |
| 完了 | commitの前 | commitせずに人の対応待ちにする |

準備のステップは、記録した中身(`worktree_git_pointer`)を修正、検証、完了のステップに渡す。
前回の実行が書き換えたまま残した`.git`を信頼しないよう、検証した1回の読み取りをそのまま記録する。

修正のステップが、違うときに例外を投げず止める結果を返す理由は、例外だとフローの再試行がClaudeを起動し直すからである。
再試行の前の確かめが失敗したときも、再試行しない。
最初の試行の記録(費用)はそのまま残す。
確かめが例外を投げたときは、秘密を伏せたメッセージを最初の失敗の詳細に足し、原因を追えるようにする。

Claudeの実行が失敗で終わったときは、修正と検証のステップが`.git`を確かめ直す。
書き換えられていれば、Claudeの失敗ではなく`.git`の書き換えを理由として止める結果を返す。

準備のステップの結果に`worktree_git_pointer`が無いときは、どのステップもgitとClaudeを実行せず、止める結果を返す。

### コミットの前の再確認

完了のステップは、検証のステップの最後の検査とは別のジョブである。
そのため、commitの前に次を確かめる。
どれかに通らなければ、commitとpushをせずに人の対応待ちにし、理由を`status_reason`に記録する。

1. worktreeのロックを持つプロセスがいない。
   何も止めずに確かめる。
   前のステップのClaudeや検査コマンドが残っていると、検証の後もworktreeを書き換えうるためである。
2. `.git`が準備のステップの記録と一致し、準備のステップの結果に`branch`がある。
3. `commitAndPush`の前に、実装フローと同じgitleaksの検査をする。
4. fetchの前に、`git symbolic-ref -q HEAD`が`refs/heads/<準備のステップの記録したPRのブランチ>`である。
   detachedの`HEAD`も止める(`commitAndPush`の`expectedBranch`)。
5. `git add -A`の前に、ローカルのHEADがPRのhead(`head_sha`)である(`commitAndPush`の`requireLocalHeadAtExpected`)。
6. `git add -A`の後、commitの前に、ステージした内容を`head_sha`と比べ、索引のツリーをgitleaksが検査したツリーと比べる。
7. commitの後、pushの前に、作ったcommitのツリーが検査したツリーであることを確かめる。

手順3のgitleaksは、[実装フロー](../implement.md)の[gitleaksによる秘密情報の検査](../implement.md#gitleaksによる秘密情報の検査)と同じ検査である。

- 比較の基準は`head_sha`で、この修正が足す行だけを検査する。
- 検査は長くかかりうるので、リポジトリのロックの外で行う。
- 秘密情報らしき文字列が見つかれば、`secrets detected, changes not pushed`を理由に止める。
  検出したルール名とファイル名はジョブのログに残し、一致した文字列は残さない。
- 検査そのものが失敗したときは、commitとpushのどちらもせずに失敗させる。

手順6では、`git diff --cached -z --name-status`と`git diff --cached --raw -z`でステージした内容を読む。
次のどれかがあれば止める。

- 禁止パス
- 新しい`*.sh`
- symlinkのモードとgitlink(入れ子のリポジトリ)のモード
- 要素が`.git`のパス
- `package.json`のscriptsの変更(ステージした中身を`git show :0:<path>`で読む)
- commitする索引の`git write-tree`が、gitleaksの検査したツリーと違う。
  理由は`worktree changed after the secret scan`になる。

どれかに当たれば、`git reset -q`でステージを戻してcommitしない。
この検査自体が失敗したときも、ステージを戻してから失敗させる。

手順7で違えば、`git reset -q <head_sha>`でcommitを取り消し、`committed tree differs from the inspected tree`を理由にする。
戻す先は、`HEAD`からたどらずに明示する。

pushは`HEAD`ではなく、作ったcommitのshaを`refs/heads/<ブランチ>`へ送る。

### サブモジュールと置換オブジェクトの扱い

検証と完了のステップが変更の一覧に使う`git status`と`git diff`には、`--ignore-submodules=none`を付ける。
対象は`--raw HEAD`、`--cached --raw`、`--cached --name-status`の各呼び出しである。
`.gitmodules`や設定の`ignore = all`で、サブモジュール(gitlink)の変更を隠させないためである。

`f/factory/lib/workspace.ts`と`steps/pr_workflow_support.ts`が実行するgitには、環境変数`GIT_NO_REPLACE_OBJECTS=1`を付ける。
PR修正と実装フローのworktreeでの操作も含む。
`refs/replace/`で差し替えたオブジェクトを読まないためで、差し替えのrefは検査コマンドが作れる。

`commitAndPush`のfetchは、サブモジュールに降りない(`--no-recurse-submodules`)。

### 差分の大きさの上限

差分に含まれるファイル数が`max_fix_changed_files`を超えるか、追加と削除の行数の合計が`max_fix_diff_lines`を超えると、検証のステップが止める結果を返す。
マージのコンフリクトやファイルの削除による大きな変更を見つけるためである。

### pushの直前の確認

pushの直前には、`commitAndPush`がfetchし直した`head_sha`と、準備のステップが確かめた値([準備での確認](../pr-workflow.md#準備での確認))を比べる。
違えば、その間に人がpushしたとみなし、pushを止めてブロックにする。

### コミットの作成者情報

コミットのauthorとcommitterには、PATが解決するGitHubアカウントのログイン名とnoreplyのメールアドレスを使う。
メールアドレスの形は`<数値ID>+<ログイン名>@users.noreply.github.com`である。
個人のメールアドレスをどこにも書き込まないためである。
値は`git commit`の環境変数(`GIT_AUTHOR_*`と`GIT_COMMITTER_*`)としてだけ渡し、git configには書き込まない。

## PR修正の安全策

PR修正のフロー(`pr_fix`)は、Claudeに書き込みのツールを与える。
次の安全策で、信頼できないPRの内容やコメントから、Factoryの設定やworkerを書き換えられないようにする。
仕組みの詳細は、この文書の[安全策の実装](#安全策の実装)と、[PRワークフローの仕様の「検査コマンドの実行」](../pr-workflow.md#検査コマンドの実行)と[「準備での確認」](../pr-workflow.md#準備での確認)にある。

### Factory自身の投稿の判定

コメントがFactory自身の投稿かどうかは、投稿者がFactoryのGitHubアカウントであり、かつ本文にFactoryのマーカーがあるかで判定する。
Factoryは人と同じGitHubアカウントで動くので、ログインだけでは人の投稿と区別できない。
マーカーだけでは第三者が偽装できる。

この判定で除外するのは、Factory自身のPR修正の返信だけである。
人のコメントと、Factoryの最初のレビューの指摘は、修正の依頼として扱う。

### ツールの制限

Claudeに渡すツールは`Read`、`Glob`、`Grep`、`Edit`、`Write`だけで、`Bash`は渡さない。
`--restricted`でコード実行のツールとWebFetchを外し、ファイルのツールを作業ディレクトリに閉じる。
ネットワークは遮断しない。

検査コマンドの実行と権限は、[検査コマンドの実行と権限の内部仕様](../check-sandbox.md)にある。

### 対象リポジトリの設定を信頼しない

対象リポジトリの`mise.toml`や`package.json`のscriptsは、信頼できない入力として扱う。
workerのmiseは対象リポジトリの`mise.toml`を信頼しない。
信頼が無いと動かない検査コマンドは実行せず、止めて報告する。

### 保護パスの変更を止める

保護パスを変更したら、修正を止める。
保護パスは`.claude/`、`.agents/`、`mise.toml`、`lefthook.yml`、`package.json`のscripts、新しい`*.sh`などである。
CIのワークフローとcomposite action(`.github/workflows/`と`.github/actions/`)も含む。
これらはFactoryやCIが実行する設定で、書き換えられるとコードを実行されるためである。
markdownlint-cli2とtextlintの設定(`.markdownlint-cli2.jsonc`、`.textlintrc.json`など)も止める。
どちらも設定から任意のモジュールを読み込め、pre-commitと`check-docs`ジョブの`mise run lint:docs`が読むためである。
Biomeの設定(`biome.json`、`biome.jsonc`)も止める。
lintの規則を決めるので、書き換えると検査を緩めて通せるためである。
`.gitignore`も、どのディレクトリでも止める。
Biomeは`.gitignore`が無視するファイルを、追跡済みでも検査しないためである。
Consoleでバンドルを通らずに配信される`console/public/`と`console/index.html`も止める。
配信するdraw.ioのビューアを固定する`console/drawio-viewer.json`も止める。
固定を書き換えるPRを作る側も止める。
対象は、`f/factory/drawio_viewer_bump`のscript、スケジュール、script定義(`.script.yaml`)である。
`f/factory/lib/`では、次の3つが対象である。

- `drawio_viewer_bump.ts`
- `drawio_viewer_bump_github.ts`
- `drawio_viewer_observations.ts`

この3つのscript定義(`.script.yaml`)も対象である。
lockは保護しない。
理由は、残るリスクと「libのlockを保護しない理由」に書いた。

dependabotのセキュリティ更新PRを自動で処理するフローも止める。
対象は、次のscriptと定義である。

- マージの判定、影響調査のプロンプト、npm registryの取得、ゲート入力の組み立て、フローの支援関数
- PRの取得、スケジュール、3つのステップ
- 上のscriptそれぞれの定義(`.script.yaml`)
- フローのディレクトリ(`f/factory/dependabot__flow/`)の全体。
  フローに埋め込むモジュールも含む

書き換えられると、許可していない更新を人の確認なしにマージできるためである。
まだ存在しないファイルも、名前を先に止める。
後から置かれたファイルが、保護から漏れないようにするためである。
PRの取得とステップのlockは止めない。
`windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
共有のGitHub取得(`f/factory/lib/github.ts`)は、ほかのフローも使うので止めない。

固定を強制し、配信物を作って検査するスクリプトも止める。
図を隔離して描くiframeの検査(`tests/lib/drawio_frame_isolation.test.ts`)も止める。
一覧は`f/factory/lib/protected_paths.ts`の`FORBIDDEN_EXACT_PATHS`にある。
scriptの定義の`lock`が自分の`.script.lock`を指す契約テストも止める。
対象は`tests/lib/script_yaml_lock_contract.test.ts`である。
`wmill sync push`は、`lock: '!inline <パス>'`のパスを読み、中身をlockとして保存する。
パスに制限はなく、絶対パスや`..`も書ける。
保護の外の定義を書き換えて参照先を変えると、workerやホストの任意のファイルがlockとしてワークスペースに載りうる。
このテストは、全定義の参照先を固定する。
あわせて、追跡するツリーにsymlinkとsubmoduleがないこと、`f/`の下にモジュールフォルダ(`__mod`など)がないことを確かめる。
`f/`の外の走査の対象と、symlinkの検査に使うパスは、`git ls-files -z`の出力だけから作る。
非ASCIIや引用の要るパスが欠けないようにするためである。
定義の集合(`definitions`)は、ファイルシステムをたどる`Glob`から作る。
`f/`の下の検査は、`readdirSync`で読んだ一覧に掛ける。
script定義以外のYAMLとJSONには、`!inline`を許さない。
flow、resource、appも同じ`!inline`を読むため、これらの経路を塞ぐ。
`f/`の下では、`node_modules`という名前のフォルダも検査から外さない。
`f/`の下の小文字の拡張子(`.yaml`、`.yml`、`.json`)のファイルは、script定義(`.script.yaml`、`.script.json`)を除き、除外なしで深い検査に掛ける。
`definitions`の`Glob`も、大文字の拡張子は拾わない。
`f/`の外の走査は、大文字の拡張子も拾う。
エスケープや行の継続で作る`!inline`、`%TAG`の指示子、タグ(`!in%6Cine`など)も拒む。
JSONは、解釈した後の値を調べる。
`f/`の外のファイルを、wmillが同期して読むかは確かめていない。
そのため、`f/`の外の追跡するYAMLとJSONを、広めに調べる。
`f/`の外では、`findLockViolations`が検査するscript定義の集合に入るものだけを、この走査から外す。
`node_modules/`の下や大文字の拡張子の`.script.yaml`は、集合に入らなければ走査に残る。
走査は2段に分ける。

| 段 | 対象 | 拒むもの |
| --- | --- | --- |
| 浅い検査 | 走査の対象のすべて。除外しない | 文字列の`!inline`、`!`を表すエスケープ(`\x21`、`\u0021`、`\U00000021`)、`!`に続く空白でない並びの中の`%`、BOM、行頭の`%`の指示子 |
| 深い検査 | 浅い検査の対象から、除外の3パスを引いたもの | YAMLのタグ、解釈した後の値が`!inline`で始まる文字列、解釈できないファイル |

深い検査の除外は、次の3つの完全一致のパスだけである。
ディレクトリやグロブでは除外しない。

- `.github/workflows/ci.yml`: GitHub式の式の否定が、YAMLのタグの検査に当たる。
- `tsconfig.json`、`tsconfig.wmill.json`: `tsc`が読むコメント付きのJSONで、JSONとして解釈できない。

`wmill.yaml`の`includes`が`f/**`だけなら、3つともwmillが項目として解釈しない名前である。
この3つに掛かるのは浅い検査だけである。
見るのは、`!`を表すエスケープ、文字列の`!inline`、`!`に続く`%`、BOM、行頭の`%`の指示子である。
`!`以外の文字のエスケープは見ない。
例えば、JSONの`"!\u0069nline x"`のように`!`の後ろの`i`をエスケープした`!inline`は、浅い検査をすべて通るので、この3つでは拒めない。
解釈できないファイルは、読み手によって解釈が分かれうるので、違反として数える。
保護した`.yml`と`.yaml`の`run: |`の中のシェルの否定(`if ! cmd`、`test ! -f`)は、深い検査で誤検知になる。
YAMLのタグの検査が、`!`を値の頭のタグと読むためである。
直すには、契約テストの除外の3パスを広げる必要がある。

`findLockViolations`が検査する定義は、`definitions`の集合差で、`f/`の外の走査から外れる。
この検査が見るのは、主に次である。

- `lock`の値の一致
- 定義のパスに空白がないこと
- BOMと行頭の`%`の指示子
- `lock`のキーが1回だけであること(YAMLのみ)
- 文字列の`!inline`が、`lock`の行だけであること(`.yaml`の定義のみ)

`.script.json`は、`lock`の値の一致、BOM、指示子だけを見る。
`lock`以外のフィールドの、素の文字列の`!inline`も見ない。
`.script.json`は今のツリーに0件だが、保護していない変更で足せる。
`lock`以外のフィールドの、エスケープした`!inline`は、どちらの形式でも見ない。
被害が出るのは、wmillが`lock`以外のフィールドの`!inline`を解決するときだけである。
`f/`の下の定義も、同じ状態である。

`wmill.yaml`も止める。
`codebases`の`customBundler`は、`wmill sync push`が反映時に、設定の文字列をシェルで実行する。
`assets`の`from`は、`wmill sync push`が任意のパスのファイルを読み、ワークスペースに載せる。
どちらも、保護の外から書き換えられると、反映するworkerやホストで任意のコマンドが走り、任意のファイルが載る。
そのため、`wmill.yaml`は`FORBIDDEN_EXACT_PATHS`に入れて、`codebases`に限らず丸ごと止める。
別名の`wmill.yml`と、サブディレクトリの`wmill.yaml`も、ファイル名で止める。
wmillが`wmill.yml`を読むかは確かめていないので、読むものとして安全側に倒す。
Factoryが扱う他のリポジトリのサブディレクトリの`wmill.yaml`も保護パスになるが、安全側として受け入れる。
`wmill-lock.yaml`は、依存の変更のたびに書き換わるので止めない。

テストの実行環境のうち、`tests/preload.ts`も止める。
`bunfig.toml`の`preload`が全テストの前に読み込むファイルで、書き換えられるとテストの前にコードが走る。
保護したテストは、どれも保護していないコードと同じ実行の中で走る。
契約テストと`tests/lib/drawio_frame_isolation.test.ts`は、その例である。
CIの`check`ジョブと`check-docs`ジョブが走らせる検査のうち、保護していないものがある。
例は、`scripts/lint-*.ts`、`lint-docs.ts`、ほかのテスト、`tsconfig.json`、`wmill lint f`の設定である。
このツリーに`mise-tasks/`は無いが、置かれればmiseが読むので、同じ経路になる。
保護していないコードの変更で、これらの検査を無効にしたまま、CIを緑にできる。
そのため、CIはこの経路の関門にならない。
止めるのはマージ前の人のレビューである。
GitHubは、そのレビューを強制していない。
保護パスは、保護していないコードの変更を止めない。

YAMLの解釈は、テストが使うBunとwmillで違いうる。
そのため、script定義では`lock`の行を完全に一致させ、解釈の違いに頼らない。
CIがどのジョブを動かすかを決める`scripts/ci-scope.ts`も止める。
書き換えられると、検査のジョブを飛ばされるためである。
カバレッジの下限を検査する`scripts/check-coverage.ts`と`tests/scripts/check_coverage.test.ts`も止める。
下限の定数、層の下限の表、除外の一覧、対象の定義を、自動の修正が書き換えて検査を緩めるのを防ぐためである。
CIが出すメタデータのパッチを取得して検査する`f/factory/lib/metadata_patch_*.ts`の6つも止める。
6つは、manifest、zip、yaml、verify、imports、downloadである。
それぞれの`.script.yaml`も止める。
lockは、`metadata_patch_manifest.script.lock`だけを止める。
新しいscriptのlockを照合するときの空のlockの参照(`EMPTY_LOCK_REFERENCE`)で、壊されると新しいscriptの自動適用が断られ続けるためである。
書き換えられると、パッチの受け取り側の検査が緩むためである。

`wmill-lock.yaml`のhashを再計算する`f/factory/lib/`の`metadata_hash`、`metadata_precheck`、`metadata_signature`も止める。
それぞれの`.script.yaml`も止める。
書き換えられると、依存が変わるPRや、入力のスキーマが変わるPRのlockを、人の確認なしに書き換えさせられるためである。

配信のCSPを持つ`infra/Caddyfile`と、配信物を検証する`infra/console_fetcher/`も止める。
一覧は`f/factory/lib/protected_paths.ts`にある。
implementのClaudeは保護パスの変更を記録するだけで止まらない。
カバレッジの下限での影響は、[テストの基準](../../testing-guidelines.md#残るリスク)にある。
層の下限を下げる変更と除外の一覧に足す変更を、人のレビューだけが止めることと、lcovが改ざんを防がないことも、そこに書く。

#### libのlockを保護しない理由

上のlibのうち、依存の無いものの`.script.lock`は保護しない。
中身は`"dependencies": {}`と`<empty>`だけである。
`metadata_patch_manifest.script.lock`は、空のlockの参照なので保護する。

- libは`main`を持たず、単独のjobとして動かない。
  importする側のscriptは、自分の`.ts`と`.script.lock`で動くので、libのlockは実行の入力にならない。
- libの`.ts`と、`lock`の参照先をlib自身のlockに固定する`.script.yaml`は、保護する。
  `.script.yaml`の`lock: '!inline <パス>'`は、反映のときに`wmill sync push`が読む。
  書き換えられると、任意のファイルがlockとして保存されうる。
- CI回と競合回は、`*.script.lock`を全scriptについて拒否する(`ci_fix_paths.ts`)。
  この拒否は変わらない。
- メタデータのパッチを適用する経路は、対応する`.ts`が保護されたscriptのlockを`protected_source`で拒否する。
  拒否の理由は`protected_path`から変わりうるが、拒否は続く。
- 保護しない前提は「libが入口を持たない」ことである。
  `tests/lib/protected_paths.test.ts`が、保護するlibの`.ts`に次が無いことを固定する。
  `main`、`preprocessor`、行頭の`export default`、再exportである。
  崩れたら、lockを保護に戻す。
- 実機のWindmillで、libのlockが使われないことは確かめていない。
  根拠は、Windmillの文書とリポジトリの実物である。
  前提が外れていても、importする側のlock(`steps/*.script.lock`など)がすでに保護の外にあるので、新しい種類の穴は増えない。

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

残るリスクは[R-FIX-02](../../security-risks.md#r-fix-02)である。

通常の回は、`allowed_check_commands`が空でない間、pushと人の確認より前に検査コマンドを実行する。
対象は、Factoryが扱うすべてのリポジトリである。
`factory_repo`と、`owners`のうち`repo_allowlist`が許すものを指す。
`repo_allowlist`が空なら、`owners`のすべてになる。
`check_commands_by_repo`は通常の回に効かない。
Claudeが書き換えた、lockfile、`scripts`以外の`package.json`、ツールの設定も、そのまま検査で実行されうる。
実装の回は、同じ変更を保護パスとして検査を省き、PR本文と通知に載せる。
通常の回は、検査を省かず、載せない。
通常の回は、無視されたファイルを`FORBIDDEN_*`の判定に入れない。
`.env`や`bunfig.toml`を新しく作られても、検査が読むまで止まらない。
`.gitignore`は保護の一覧にあるので、Claudeが無視の規則を足すと、その変更で止まる。
もとからある無視の規則に当たる名前で新しく作ったファイルは、判定から外れる。
無視されたファイルはコミットされないので、PRに跡が残らない。
実行するユーザーは非特権で、networkはworkerと共有する([検査コマンドはフローが実行する](../check-sandbox.md#検査コマンドはフローが実行する))。

Claudeが読む文には、運用者以外の文が入りうる。
dependabotの所見に入るnpm公開者の文と、PRの本文や差分がその例である。
レビューとコメントのうち、`allowed_labeler_associations`に無い投稿者の分は除く。
外部の投稿者のコメントは、通常は届かない。
ただし、Factory自身のレビューは運用者のアカウントで投稿されるので、除外を通る。
その内容は、外部の文を含むPRの差分や本文から作られうる。
要件定義と設計も読み、その元のIssueの本文は、起票者が運用者とは限らない。
この差の残るリスクは[R-FIX-28](../../security-risks.md#r-fix-28)である。

実装の一覧だけに当たる変更は、通常の回では返信と通知のどちらにも載らない。
例は、`.github/`のdependabotの設定、`infra/`のCI用のファイル、lockfileである。
マージの前に見る人へ、変更が伝わらない分も、この差に含まれる。
`.devcontainer/`、gitフック、`.yarn/`のように、人の開発環境が開くか操作したときに実行するものは、レビューの前にその人の環境で実行されうる。
lockfileや`package.json`の`trustedDependencies`も、人がinstallしたときに依存のlifecycle scriptを実行させうる。
これらも、受け入れる対象に含める。
通常の回を実装の一覧にそろえる場合は、次のどちらかを選ぶ。

- 実装の一覧だけに当たったパスを、返信と通知に載せる。
  コードとテストの変更で足りる。
- 実装の回と同じに、止めずに検査を省き、返信と通知に載せる。
  検査をしていない修正を、既存のPRのheadへpushする。

保護パスで止まった回の集計は、この差の根拠にしない。
通常の回について、集計が数えるのは`FORBIDDEN_*`に当たって止めた回で、lockfileやツールの設定を書き換えて通った回は数えない([保護パスで止まった回数を数える](../../operations/pr.md#保護パスで止まった回数を数える))。

CIの修正と競合の修正は、実装の一覧を使うので、この差を持たない。

### symlinkと特殊なファイルを止める

symlinkの作成・変更・削除、入れ子のリポジトリ、`.git`という要素を含むパス、通常のファイルでないものがあれば止める。
symlinkを通すと、作業ディレクトリの外のファイルを読み書きされるためである。
変更の一覧は、引用符付きのパスや未追跡のディレクトリでも判定を素通りしない形で取得する。

### HEADとブランチの確認(PR修正の安全策)

変更を調べる前に、worktreeのHEADとブランチが、準備のときに見たPRのものと同じかを確かめる。
検査コマンドがcommitやブランチの切り替えをすると、その変更が差分から消えて検査を素通りするためである。

### worktreeの.gitファイルの書き換えを止める

worktreeの`.git`ファイルは、準備のときに検証して中身を記録する。
以降、Claudeを起動する前とgitを実行する前に、記録と一致することを確かめる。
参照先を別のディレクトリに向けられると、そこのconfigの設定を次のgitがrootで実行するためである。
この安全策は実装のフローでも同じように働く。

### gitが読む設定を限る

`f/factory/lib/workspace.ts`と`f/factory/steps/pr_workflow_support.ts`が実行するgitは、読む設定を同じ方法で限る。
どちらも`workspace.ts`の`buildGitArgv`と`localGitEnv`を使う。

システムとグローバルの設定は、環境変数`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_SYSTEM`、`GIT_CONFIG_GLOBAL`、`GIT_ATTR_NOSYSTEM`で読ませない。
workerのホストの設定が、検証の前提を変えないためである。
コミットのauthorは環境変数で、認証は`GH_TOKEN`で渡すので、これらの設定は要らない。
workerのイメージは、グローバルのgit設定もgtrのグローバル設定も持たない。
HOMEは、ghなどの子プロセスと、gitの`~`の展開(`.git/config`のパスの`~`、httpsの`$HOME/.netrc`)のために渡す。
workerのHOMEには`.netrc`を置かない。
イメージにも置いていない。
`safe.directory`は設定しない。
workerとcloneはどちらもrootで動き、`/workspaces`のボリュームの所有者が同じになるためである。
Dockerfileとworkerの`docker-compose.yml`に、`USER`と`user:`の指定は無い。

転送はhttpsだけを許す。
環境変数`GIT_ALLOW_PROTOCOL`を`https`にする。
`.git/config`に`protocol.ext.allow=always`と`ext::`のremoteを書かれると、`GH_TOKEN`を持つ環境でコマンドを実行されうる。
この環境変数は`protocol.*`の設定より優先されるので、設定ファイルでは許可を広げられない。
対象のremoteはhttpsだけなので、fileやsshは使えなくてよい。

main cloneの`.git/config`は、gitがremoteやブランチの設定を読むので、読ませないことはできない。
`extensions.worktreeConfig`が有効なときは、worktreeごとの`config.worktree`も読まれる。
どちらも書き換えられると、`-c`では`config.worktree`の読み込みを止められない。
検査コマンドは別のuidで動き、書き込めない。
書き込める経路が増えたときに備えて固定する。
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
これらは、残るリスクの表の[R-FIX-03](../../security-risks.md#r-fix-03)にあたる。
`git gtr new`のcheckoutは`GH_TOKEN`を持つ環境で動く。
検査コマンドは検査用のユーザーで動き、main cloneの`.git`に書き込めない([検査コマンドの権限](../check-sandbox.md#検査コマンドの権限))。
検査コマンドが書き換えられるworktreeの`.git`ファイルは、記録との照合で止める。

### コミットの直前の再検査

完了のステップは検証とは別のジョブなので、commitの前にもう一度確かめる。
worktreeを使うプロセスが残っていないこと、ブランチとHEADが記録どおりであること、ステージした内容に保護パスやsymlinkが無いことを見る。
1つでも通らなければ、commitとpushをしない。

commitの前には、実装フローと同じgitleaksの検査もする。
commitするツリーは、gitleaksが検査したツリーと同じことを確かめ、pushは作ったcommitのshaだけを送る。
検査していない変更と履歴をpushしないためである。
手順は[この文書の「コミットの前の再確認」](#コミットの前の再確認)にある。

### 差し替えとサブモジュールに惑わされない

gitの実行には`GIT_NO_REPLACE_OBJECTS=1`を付け、`refs/replace/`で差し替えたオブジェクトを読まない。
変更の一覧には`--ignore-submodules=none`を付け、サブモジュールの変更を隠させない。
差し替えのrefとサブモジュールの設定は、検査コマンドが作れるためである。

同じ理由で、ローカルの`origin/HEAD`と追跡ref(`refs/remotes/origin/*`)も、送る内容を決めるときには信じない。
検査コマンドはメインのcloneの`.git`を書き換えられ、`--prune`なしのfetchは書き換えられた`origin/HEAD`を直さない。
実装フローが空のブランチをpushするときは、リモートに`git ls-remote`で問い合わせた既定のブランチの先頭を送る。
リモートの`HEAD`が既定のブランチと違うとき、リモートに既定のブランチが無いとき、ローカルの追跡refがリモートと違うときは、何もpushしない。

### 差分の大きさの上限(PR修正の安全策)

変更したファイルの数が`max_fix_changed_files`を超えるか、差分の行数が`max_fix_diff_lines`を超えたら止める。
マージの衝突やファイルの削除による大きな変更を、レビューなしにpushしないためである。

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

残るリスクは[R-FIX-04](../../security-risks.md#r-fix-04)である。

pushの直前には、PRのheadが準備のときから変わっていないことだけを確かめ直す。
変わっていれば、pushせずにブロックで止める。
人がpushした変更を上書きしないためである。

### コミットの作成者情報(PR修正の安全策)

コミットのauthorとcommitterには、PATのアカウントのログイン名とGitHubのnoreplyメールアドレスを使う。
個人のメールアドレスをどこにも書き込まないためである。
値は`git commit`の環境変数としてだけ渡し、git configには書かない。

### CIのログの扱い

CIの失敗を直す回の部品は、Actionsのログを取り込んでClaudeのプロンプトに入れる。
部品の責務、入力の検証、flowが守る前提は[CIの失敗を直す部品の仕様](../ci-fix.md)にある。

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
- テストの行は、PRの基点から持っていた行を消せない。
  削除された行がPRの足した行かは、行の位置で判定する。
  PRのmerge-baseとbaseの今の先端の、どちらの差分でも追加された範囲にある行だけを、PRの足した行とする。
  行の位置で判定するので、PRが基点と同じ内容の行を別の位置に足しても、基点の行は足した行にならない。
  積み重ねたブランチで、baseにすでにある行も足した行にならない。
  差分は、`-U0 --inter-hunk-context=0 --diff-algorithm=myers`で取り、hunkの見出しの行数ではなく、中の行を数えて読む。
  利用者の設定で範囲がずれないようにするためである。
  PR側と先端側の差分は`--ignore-all-space`も付け、PRが字下げだけを変えた基点の行を、PRが足した行にしない。
  整形で1行が複数行に分かれたときの扱いは、[R-FIX-27](../../security-risks.md#r-fix-27)にあたる。
  PRが足した行でも、空行とコメントだけの行(行頭が`//`、`#`、`/*`、`*`、`<!--`の行)への置き換えと、削除より意味のある追加行が少ないhunkは拒否する。
  判定は行頭の文字列だけで行う。
  `void 0;`、`;`、`if (false) ...`のような、書いてあるが何もしない行への置き換えは検出できない。
  `#`で始まる行は常にコメントと読むので、Rustの属性やCのプリプロセッサの行を書き換える修正は拒否される。
  `--`、`;`、`%`で始まるコメントは見分けない。
  差分が大きすぎるとき、読めないときは、拒否に倒す。
  APIやgitの一時的な失敗は、例外にして自動の回復に任せる。
  基点を取り込むgitは、`.git`の記録を照合した直後にだけ実行する。
  基点は、PRが既定のブランチを向いているときだけ求める。
  既定でないブランチは、そのテストを持たないことがあり、持たないと全行がPRの追加に見えるためである。
- Claudeが返したコミットの件名と本文、要約、停止の理由も、gitleaksと`maskSecrets`に通す。
- 生のログ、抜粋、プロンプトは、JSONにできない型で包む。

残るリスクは次のとおりである。

- [R-FIX-05](../../security-risks.md#r-fix-05)
- [R-FIX-06](../../security-risks.md#r-fix-06)
- [R-FIX-07](../../security-risks.md#r-fix-07)
- [R-FIX-08](../../security-risks.md#r-fix-08)
- テストの期待値の書き換えは機械では判定できない。
  再レビューに頼る。
  PRが足した行の書き換えを許すので、この限界はPRが足した行にも及ぶ。
  行の数と位置だけを見るので、同じhunkの中で別の行へ置き換える変更も、書き換えと区別できない。
  置き換え先の行の判定は、行頭の文字列だけで行う。
  `void 0;`、`;`、`if (false) ...`のような、何もしない行への置き換えは検出できない。
  残るリスクの表の[R-FIX-09](../../security-risks.md#r-fix-09)にあたる。
- 空白を無視した差分では、行の位置がずれる。
  残るリスクの表の[R-FIX-10](../../security-risks.md#r-fix-10)にあたる。
- [R-FIX-11](../../security-risks.md#r-fix-11)
- [R-FIX-12](../../security-risks.md#r-fix-12)
- [R-FIX-13](../../security-risks.md#r-fix-13)
- [R-FIX-14](../../security-risks.md#r-fix-14)
- [R-FIX-15](../../security-risks.md#r-fix-15)
- [R-FIX-16](../../security-risks.md#r-fix-16)

### マージの競合を解く回(PR修正の安全策)

マージの競合を解く回(競合回)の部品は、リポジトリの既定のブランチ(base)の先頭をPRのブランチにmergeし、競合をClaudeに解かせ、mergeコミットをpushする。
git操作は`lib/workspace.ts`の`mergeBaseIntoWorktree`と`pushMergeCommit`に、検査は`lib/conflict_fix_round.ts`にある。
手順と検査の規則は[CIの失敗を直す部品の仕様](../ci-fix.md#競合回のgit操作と検査)にある。

#### baseの決め方

mergeするのは、PRのbaseがリモートの既定のブランチのときだけである。
`git ls-remote --symref`でリモートの`HEAD`が指すブランチを、完全なref名で照合し、そのブランチの先頭のshaを読む。
ローカルの追跡ref(`refs/remotes/origin/*`)は読まない。
検査コマンドが書き換えられるためである。

読んだshaを明示してfetchし、mergeもそのshaで行う。
fetchはサブモジュールに降りない。
fetchからmergeまでの間にbaseが進んでも、検査する内容と記録がずれない。

#### workflowスコープを付けない

PATにWorkflowsの権限は付けない([GitHubのPAT](../../security.md#githubのpat))。
`.github/workflows/`を含むpushをGitHubに拒否させるためである。

baseの側が`.github/workflows/`を変えていると、mergeコミットのpushは拒否される。
そのため、mergeした結果のツリーで、PRのheadからの差に`.github/workflows/`が含まれれば、Claudeを起動せずに止める。
それでもpushが`.github/workflows/`を理由に拒否されたときは、他の拒否と区別して返す。
区別は、拒否の行の括弧の中の理由だけで行う。
ブランチ名に`.github/workflows/`を含む別の拒否を、取り違えないためである。

#### mergeコミットのpush

pushするのは、検査したツリーを持ち、親が[PRのhead, base]のmergeコミット1つだけである。
rebaseとforce pushはしない。

基準コミットは送らない。
基準コミットは衝突マーカーを残したままローカルにだけ作り、pushするコミットは`commit-tree`で新しく作る。
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
基準コミットには、競合ファイルだけを`add`する。
`add -A`は使わない。

#### 残るリスク

- [R-FIX-17](../../security-risks.md#r-fix-17)
- [R-FIX-18](../../security-risks.md#r-fix-18)
- [R-FIX-19](../../security-risks.md#r-fix-19)
- [R-FIX-20](../../security-risks.md#r-fix-20)
- [R-FIX-21](../../security-risks.md#r-fix-21)
- [R-FIX-22](../../security-risks.md#r-fix-22)
- [R-FIX-23](../../security-risks.md#r-fix-23)
- [R-FIX-24](../../security-risks.md#r-fix-24)
- [R-FIX-25](../../security-risks.md#r-fix-25)
- 競合回の完了ステップは、失敗をDiscordとnoticeに通知しない。
  失敗は、作業項目の状態と注記としてConsoleに残る。
  運用者の対応が要る2件は例外で、通知を残す。
  リポジトリのオーナーの数値IDの照合に失敗したときと、workerのイメージが古いときである。
  ただし、イメージの古さは準備と検証のステップが残し、完了のステップで検出したときは残さない。
  その場合は、行の起動の回数の上限に達して`rounds_exhausted`になるまで、通知が無い。
  上限に達するまでの時間は、上限の回数に巡回間隔の5分を掛けた程度である。
  詳細は[完了の結果](../pr-workflow.md#完了の結果)にある。
  残るリスクの表の[R-FIX-26](../../security-risks.md#r-fix-26)にあたる。
