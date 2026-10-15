# CIの失敗を直す部品の内部仕様

PRのCIの失敗をClaudeに直させる回(CI回)が使う部品の責務、入力の検証、失敗時の方針を定める仕様である。
次のファイルと、それを呼ぶ`pr_fix`のステップを変更する人が読む。

- `lib/github.ts`のログ取得
- `lib/ci_log_support.ts`、`lib/ci_fix_classify.ts`
- `lib/ci_fix_prompt.ts`、`lib/ci_fix_paths.ts`
- `lib/ci_fix_round.ts`
- `lib/github.ts`のartifact取得と、`lib/metadata_patch_*.ts`
- `lib/metadata_hash.ts`、`lib/metadata_precheck.ts`、`lib/metadata_signature.ts`、`lib/metadata_git_ports.ts`
- `lib/ci_metadata_rehash.ts`

残る危険は[セキュリティ](../security.md)に、失敗の判定と状態は[PRのCI監視の仕様](pr-ci.md)に書く。

## 方針

CIのログはリポジトリへ書ける人が決める外部入力である。
プロンプトインジェクションと、秘密値の漏れが最大の危険になる。
そのため、ログは取得、整形、検査、プロンプトへの埋め込みの各段階で、信頼できないものとして扱う。
判断できないときと検査できないときは、必ず処理を止める(fail-closed)。

## 部品の責務

| ファイル | 責務 |
| --- | --- |
| `lib/github.ts` | ジョブの一覧とログ本文の取得。IDと応答の照合 |
| `lib/ci_log_support.ts` | ログの整形と絞り込み。秘密値の検査。揮発する値の型。Claudeの出力文字列の検査 |
| `lib/ci_fix_classify.ts` | 失敗が、自動で直せる種類かの分類。`metadata`の失敗は、hashの再計算の経路として分ける |
| `lib/ci_fix_prompt.ts` | CI回のプロンプトと出力のJSON schema |
| `lib/ci_fix_paths.ts` | Claudeが加えた変更の許可リスト方式の検査 |
| `lib/ci_fix_round.ts` | 上の部品をつなぐ流れ。PRの状態の確認と分類(`readCiFailure`)、ログから抜粋まで(`gatherCiLogs`)、変更の入力の組み立て、通常の回との違いの判断。`wmill-lock.yaml`だけの変更の形の判定(`isLockOnlyChange`) |
| `lib/ci_metadata_rehash.ts` | `metadata`だけが落ちた回の再計算の流れ。書き込み、独立した照合(`confirmRehash`)、pushの直前の再確認、固定の理由 |
| `lib/metadata_git_ports.ts` | 事前検査が読むポートのgitの実装。baseの先端のcommitの取り込み |
| `lib/workspace.ts` | 文字列をgitleaksで検査する実行(`runGitleaksOnText`) |

## CI回のflowが守る前提

部品は、呼び出す側のflowが次の前提を守ることを当てにする。
部品の中では強制できないため、flowを書く人が守る。

- Claudeに`Bash`を渡さない。
  検査コマンドはflowが実行する。
  ログに書かれた指示でコマンドを実行させないためである。
- Claudeに渡すツールは、ファイルの読み取り、検索、編集に限る。
  修正のステップと再実行は、`lib/ci_fix_round.ts`の同じ定数(`CI_FIX_TOOLS`と`CI_FIX_ALLOWED_TOOLS`)を使う。
  テストが、定数に`Bash`が無いことと、両方のステップがこの定数を使うことを固定する。
- ログの抜粋と、抜粋を含むプロンプトは、stepの結果、DB、ログ、通知に載せない。
- 揮発する値の型は、JSONにすることを拒否する。
  ただし、`VolatileCiExcerpt.read()`が返す配列は普通のオブジェクトなので、型では守れない。
  取り出した配列も、stepの戻り値に載せない。
- `CiFixChange`の入力は、Claudeの変更後の作業ツリーと、実行前のheadの差分から、flowが作る。
  gitのrename検出は切り、移動は削除と追加の2件で渡す。
  rename検出を使うと、移動元の削除が見えなくなるためである。

## CI回の流れ

`pr_fix`のフローは、作業項目の`ci_check_id`が非NULLのとき、CI回として動く。
通常の回との違いは[PRワークフロー](pr-workflow.md)の「CIの失敗を直す回」に書く。
ここでは、部品を呼ぶ順と、止める条件を書く。

### 検査コマンドの前提

検査コマンド(`allowed_check_commands`)は、依存の取得(インストール)を含まなければならない。
CI回は、準備のステップの後と、検査コマンドのたびにその後で、無視されたファイルを消す。
`node_modules`のような依存の取得先も消えるので、取得を含まない検査コマンドは、毎回失敗する。
実装フローも同じ前提である([実装フロー](implement.md))。

### 修正のステップ

修正のステップ(`pr_fix_apply`)は、`runCiFixApply`で次の順に進む。
どこかで止めたときは、Claudeを起動せず、結果の`outcome`を`blocked`にして返す。

1. factory-fixスキルにマーカー`ci-fix-skill:v1`があることを確かめる。
   CI回の規約を知らないClaudeに直させないためである。
2. `gatherCiFailureInput`でログを抜粋にする。
   - PRが開いていて、headが失敗の行のheadのままであることを確かめる。
   - headの実行から、workflowごとの最新で失敗したものを、5件まで選ぶ。
   - 選んだ実行のジョブを読み、`classifyCiFailure`で分類する。`fixable`でなければ止める。
   - 失敗したジョブの先頭3件のログを読む。トークンの権限が足りないときと、ログが無いときは止める。ログが欠けたときは例外で止める([ログの取得](#ログの取得))。
   - 抜粋を作る(`buildCiExcerpt`)。秘密値の検出、検査の失敗、使える本文が無いときは止める。
   - PRがすでに変更したファイルの一覧を読む。
3. プロンプトを作り(`buildCiFixPrompt`)、Claudeを起動する。
4. Claudeの出力は、JSON schemaに加えて、コードでも検査する。
   結果が`done`か`blocked`で、`replies`が空でなければならない。
   満たさない出力は不正な出力として、1回だけ再試行する。再試行の後も満たさなければ、実行の失敗にする。
   返信は指摘に答えるためのもので、CI回には答える指摘が無い。
   ログに仕込まれた指示で、返信がPATの名義で投稿されるのを防ぐため、schemaだけに頼らない。
5. コミットの件名と本文、要約、停止の理由を`guardCiRoundText`で検査する。検出と検査の失敗は止める。

CI回が作る理由は、`ci round`で始まる。
固定の文か、Claudeの`blocked_reason`の前に`ci round: claude blocked:`と空白1つを付けた文である。
接頭辞は、次の操作の選択を先頭のCI回の規則だけに当てるために付ける。
ログに仕込んだ文で、基盤を直す手順を案内させないためである。
通常の回と共通の理由(PRがドラフトなど)は、そのまま通る。
ジョブ名やログの文は入れない。
生のログは、`gatherCiFailureInput`の中で抜粋に変えて捨てる。
Claudeの実行が失敗したときも、失敗の種類だけを入れた固定の文(`ci round: claude run failed (<種類>)`)にする。
実行の詳細(不正な出力の先頭の抜粋、stderr)は、秘密値の検査を通っていない。
例外、理由、通知のどれにも載せない。
ステップの戻り値、DB、通知に載るのは、固定の理由とClaudeの検査済みの文字列だけである。

### 検証のステップ

検証のステップ(`pr_fix_verify`)は、通常の回の検査に加えて、変更を`checkCiFixChanges`で検査する。
検査の時点は、Claudeの実行の後、検査コマンドの後、再実行の後である。
通常の回の検査で止まったときは、許可リストの検査をしない。
止める理由に入るパスは、Claudeが選べる名前やリポジトリのファイル名なので、秘密値の検査(`guardCiRoundReasons`)を通す。
検出と検査の失敗のときは、理由を固定の文1件に置き換える。

入力(`CiFixChange`)は、`collectCiFixChanges`が作る。

- 追跡しているファイルは、実行前のheadとの差分(`git diff --raw`と`-U0`)から作る。
  リネーム検出を切り、外部のdiffとtextconvのプログラムを使わない。
- 未追跡のファイルと、`.gitignore`で無視されたファイルも入れる。
  無視の規則をかけずに一覧を取るので、`.gitignore`を書き換えても隠せない。
  無視されたファイルはcommitされないが、検査コマンドの動き方を変えうる。
- symlinkは先を読まない。
  通常のファイルでないもの、大きすぎるファイル、大きすぎる差分は、モードを`000000`にして対応外として拒否する。
  未追跡のファイルが読めないときも、同じく対応外として拒否する。
- 変更が200件を超えたら、1件ずつ読まずに止める。
- 変更を読む時間が2分を超えたら、残りを読まずに止める。
  ファイルごとにgitを実行するので、時間の上限が無いと、検証のステップのtimeoutを超えうる。
- gitの失敗は例外にする。空の一覧として扱うと、変更を見落とすためである。

無視されたファイルは、準備のステップでworktreeを用意した後と、検査コマンドの実行のたびにその後で、`git clean -fdX`で消す。
検査コマンドの生成物と、Claudeが書いたファイルを見分けるため、Claudeを実行する時点では無視されたファイルが無い状態にする。
検査コマンドの後に消すのは、`.git`が準備のステップの記録のままのときだけである。
書き換えられていれば消さず、続く検査が同じ確認で止める。

検査コマンドが失敗した後の再実行は、CIのログの抜粋を取り直す。
ローカルの検査の失敗の出力(最大2件)も、CIのログと同じ手順で整形と秘密値の検査を通し、抜粋の先頭に加える。
再実行の結果にも、`replies`が空であることと、文字列の検査を適用する。

### 完了のステップ

完了のステップ(`pr_fix_finish`)は、commitの前に、ステージした内容を保護パスの検査に加えて`checkCiFixChanges`で検査する。
止める理由は、検証のステップと同じく秘密値の検査を通す。
この検査はロックの中で動く。秘密値の検査は、止める理由があるときだけ走る。
続けて、秘密値の検査を通ったツリーがPRのheadに対して新しく加えるファイルのパスを、1回の秘密値の検査にかける。
許可された新規テストのファイル名に秘密値を載せて、commitを通して流出させる経路を塞ぐためである。
既存のファイルの名前はすでに公開されているので、検査するのは状態が追加のパスだけにする。
この検査は、リポジトリのロックを取る前に行う。時間のかかる検査でロックを長く持たないためである。
パスの一覧は索引ではなくツリーから作る(`listCiAddedPathsInTree`)。
内容が検査したツリーのままであることは、`commitAndPush`の`expectedTreeSha`が保証する。
当たったときは、パスを含まない固定の文で止める。
当たったルールの名前だけを`log.warn`に残し、一致した文字列は残さない。
検査できなかったときは、別の固定の文で止める。
続けて、pushの直前に、PRの状態を読み直す。
PRは、開いていなければならず、draftとauto-mergeは許さない。
headも、失敗の行のheadのままでなければならない。
headが動いていれば、作業項目をブロックで終える。それ以外は人の対応待ちで終える。
返信は投稿しない。
commitする変更が無いときの理由は、返信を投稿したとは書かず、`no changes to commit`だけにする。
再実行と付け直しは案内しない。
人が基盤を直す手順がある理由は、手順を残し、再実行の部分だけを差し替える。
差し替える案内は、保留の理由が一時的な理由(ドラフト、auto-merge)なら、保留が解けるまで待つか、PRにpushする案内である。
そうでなければ、PRへのpushの案内である。
イメージが古い理由は、保留の理由ではなく、失敗の行が24時間後に保留なしで戻ることを案内する。
手順が無い理由の次の操作は、保留の理由に写せる理由なら、その理由の敬体の固定文(`prCiFixHoldInfo`の`stopAction`)にする。
写せない理由は、原因を確かめて直し、PRへpushする案内とする。
保留の理由の語彙と、止めた理由を写す規則は[PRのCI監視の仕様](pr-ci.md)に書く。

### metadataジョブの失敗を直す経路

`metadata`ジョブだけが落ちたCI回は、Claudeを起動せず、`wmill-lock.yaml`のhashの再計算で直す(決定的な経路)。
修正のステップは、日次予算の検査より前に、この経路を試す。費用がかからないためである。
`metadata`だけが落ちた行は、Claudeを使わないので、起動の判断が、factory-fixスキルのマーカーも確かめない。
修正のステップのマーカーの確認は、この経路より後ろにあるので、この経路は通らない。

`check`などの直せる失敗と`metadata`が同時に落ちたときは、再計算せず、Claudeが先に`check`などを直す。
Claudeが`f/`のscriptを直すと、hashが再び古くなる。
先に再計算すると、その後にもう一度再計算が要り、`pr_ci_fix_max_rounds`(既定2)を使い切って`rounds_exhausted`になる。
Claudeを先にすれば、1回目でClaudeが直し、次のCIで`metadata`だけが落ちて、2回目に再計算で直る。
混在の回は、通常の`fixable`と同じに、日次予算で保留する。
予算を使い切った日に、混在の行を予算の免除でclaimすると、巡回のたびにラウンドを消費するためである。
保留した行は、巡回のたびに読み直すだけで、ラウンドを消費しない。

1. `readCiFailure`で、PRが開いていて、headが失敗のheadのままであることと、失敗の分類を確かめる。
   `metadata`だけが落ちているのでなければ、通常の流れに進む。
2. GitHubのAPIでPRのbaseブランチ名とその今の先端のshaを読み、そのcommitをローカルに取り込む(`fetchCommit`)。
   事前検査は、baseの先端の木を読むためである。
   取り込みはshaを指定し、取り込み先を指定しない。
   ローカルに無いときだけ取り込み、追跡ref(`refs/remotes/origin/<base>`)も、ブランチも、タグも動かさない。
   `commitAndPush`は、追跡refを動かす取り込みをリポジトリのロックの中で行う。
   ロックの外から同じrefを更新すると、refのロックが衝突して失敗しうるためである。
3. `planMetadataRehash`が、worktreeのオブジェクトからhashを再計算する。
   通って、本文が変わるときは、worktreeの根の`wmill-lock.yaml`を書き換える(`writeRootWmillLock`)。
   `O_NOFOLLOW`で開き、通常のファイルでなければ書かない。ファイルは作らない。書き先はこの1つだけである。
   書いた後に、ファイルの大きさが本文のバイト数と同じことを確かめる。
4. 書き換えたときは、固定の件名と本文(`METADATA_REHASH_COMMIT_SUBJECT`と`METADATA_REHASH_COMMIT_BODY`)を持つ`done`で返す。
   返信は空である。
5. 次のときは、`blocked`で返す。
   - 事前検査が、固定の理由で通らない。依存やschemaが変わるPR、mainを取り込んでいないPRなどである。
   - 再計算しても本文が変わらない(`lock_up_to_date`)。
     `metadata`ジョブが、Windmillの起動やログインなど、hash以外の原因で落ちているので、再計算では直らない。
   - 根の`wmill-lock.yaml`が、symlink、通常のファイルでないもの、実行権限のあるもの、無いファイル、書き込めないファイルである(`lock_not_writable`)。
     実行権限のあるファイルは、モード`100755`でcommitされ、後のステップが`100644`だけを許すためである。

   理由は`ci round: the lock cannot be recomputed automatically (<種別>)`である。
   種別は固定の語彙で、PRの作者が決めるパスは入れない。
   補足を足すのは、`scan_unavailable`(workerのBunの版)と`internal_error`(例外の種類)の2つだけである。
   形は`scan_unavailable: bun <版>`のように、種別に続けて入れる。
   運用者が、workerのイメージの更新で直るかや、原因の見当を見分けるためである。
   種別は作業項目の理由に残り、再計算が直せるPRの割合を、種別ごとに数えて測れる。

再計算の回も、`pr_ci_fix_max_rounds`が数える回に含まれる。
Claudeの回と再計算の回は、同じ上限を分け合う。

失敗は、一時的なものと、再試行しても直らないものに分け、検証と完了のステップの照合も同じ分け方に従う。

- 一時的な失敗は、例外にして投げ、`metadata_manual`にしない。
  修正のステップはflowが2回まで再試行し、再計算は何度行っても同じ結果になるためである。
  - 事前検査の`port_error`(gitコマンドの失敗、時間切れ、ポートの値の形の誤り)と`ancestry_unknown`。
  - 取り込み、GitHubのAPI、書き込みの`open`以外の失敗。
- 再試行しても直らない失敗は、例外にせず、固定の理由で止める。
  - `lock_not_writable`。
  - 事前検査の固定の理由。`dependency_changed`、`head_lacks_base`、`base_stale`などである。
  - 実行時に残るimportの自己検査の失敗(`scan_unavailable`)。workerのBunの版が合わない状態で、何度行っても外れる。
  - 木の一覧が読めないこと(`tree_unreadable`)。`ls-tree`の出力が上限で切れたときと、形が合わないときである。
  - 想定外の例外(`internal_error`)。ポートの例外はすべて`port_error`か`tree_unreadable`に変わるので、残るのは純粋な計算の例外である。
    同じ入力では同じ結果になる。補足に、例外の種類を、標準のエラーの名前に限って載せる。
- 検証と完了のステップの照合は、一時的な失敗のとき、例外を投げる。ステップが失敗し、行は回復が戻す。
  flowの再試行があるのは修正のステップだけである。検証と完了のステップは再試行されず、失敗すると`on_error_flow`から回復が行を戻す。
  再試行しても直らない理由のときは、再計算の回では、保護パスの違反にせず、修正のステップと同じ固定の理由(`metadataManualReason`)で止める。
  Claudeの回では、保護パスの違反(`deny`)になる(判定は、下の`stop`の段落に書く)。
  回復は、この理由を`metadata_manual`に写す。

検証のステップと完了のステップは、前のステップの結果を受け取る欄を足さず、worktreeの変更から再計算の出力かを決める。
前のステップの出力を信用しないためである。
次の2つをどちらも満たすときに限り、この変更を許す(`confirmRehash`)。

- 変更が、根の`wmill-lock.yaml`1件だけである。モードは`100644`で、状態は`modified`である。
- その本文が、PRのheadの木から独立して再計算した結果と、バイト列まで同じである。比べるのは、文字列ではなくバイト列である。
  文字列に復号すると、先頭のBOMが落ち、不正なUTF-8が置き換わって、違う内容が同じに見えるためである。

この例外は、許可リスト方式の検査`checkCiFixChanges`ではなく、呼び出し側の`inspectCiFixChanges`に置く。
照合の結果は、次の3つのどれかになる(`RehashCheckVerdict`)。

- 確認できた(`allow`)。変更を許す。
- 形が外れた、本文が再計算と違う、本文を読めない、baseの先端が動き続けた(`deny`)。
  例外を使わず、保護パスの違反として拒否する。
- 再計算が、再試行しても直らない理由で失敗した(`stop`)。保護パスの違反にはせず、固定の理由を返す。
  一時的な失敗は、この3つに入れず、例外を投げる。

`stop`にするのは、再計算の回(`metadata`だけが落ちた回)に限る。
Claudeの回で`wmill-lock.yaml`だけが変わったときに、「metadataジョブの失敗を直せない」と案内しないためである。
Claudeの回では、`deny`にして、保護パスの違反として拒否する。
回の種類は、検証と完了のステップが、PRのheadのCIの実行から読み直して決める(`rehashRoundProbe`)。
修正のステップの出力を信用しないためである。読み直すのは、固定の理由で直せないとわかったときだけである。

- 検証のステップは、この形が確かめられたとき、検査コマンドを実行しない。
  hashだけを書き換えた変更は、検査コマンドが確かめるコードを含まず、対象リポジトリのコードを実行する危険だけが残るためである。
  実行しないので、検査コマンドの告知(`unsandboxed_check_commands`)も出さない。
  告知は、最初の検査コマンドの直前に、1回だけ出す。
- 完了のステップは、リポジトリのロックの外で同じ照合をする。ロックの中では、ステージしたバイト列が照合済みのバイト列と同じかを確かめる(`stagedRehashGate`)。
  変更が候補でないとき、ステージが照合済みと違うときは、許さない。
  秘密値の検査、ツリーの照合、保護パスの検査、PRの状態の確認、オーナーの数値IDの照合、headの確認は、通常どおり通す。
- commitの親は、`commitAndPush`が`head_sha`に固定する。
  ローカルのHEADが`head_sha`でなければcommitせず、pushは強制しないので、ブランチの先端が動いていればpushは拒否される。
- 照合では、baseの先端を読み、その先端で再計算し、比べた後にもう一度先端を読む。動いていれば、新しい先端で取り直す。取り直しは3回までである。
- pushの直前に、baseの先端をもう一度読む。動いていれば、pushせず、新しい先端で確かめ直し、本文が変わるならこの回を止める(`CI_ROUND_REHASH_STALE_REASON`)。
  先端はpushの後にも動きうるが、その差は次のCIの実行が検査する。

## ログの取得

`listWorkflowRunJobs`は、実行のジョブを、stepつきで読む。
最新の試行だけを、1ページ100件で最大3ページまで読む。
`getWorkflowJobLog`は、ジョブ1件のログ本文を読む。

入力と応答は次のように検証する。

- 実行のIDとジョブのIDは、正の安全な整数でなければ、API呼び出しの前に例外を投げる。
  endpointへ入れる値を限るためである。
- コミットのshaは、完全な40桁でなければ例外を投げる。
- 応答のジョブの`run_id`と`head_sha`が、期待する値と違えば例外を投げる。
  別の実行のログを取り違えないためである。
- 応答の形が違えば例外を投げる。

ログ本文は次のように受ける。

- 本文はJSONではないので、文字列のまま受ける。
- 本文は`VolatileCiLog`で包んで返す。
  `reveal`で取り出すのは、`buildCiExcerpt`に渡す直前だけにする。
- 出力は8MBで切る。
  先頭と末尾を残し、間は`omittedMarker`でつなぐ。
- 失敗の原因は末尾に出るのが普通なので、切れても使える。
- 切れたかは`truncated`で返す。
  出力全体のバイト数が上限を超えたかで決める。
  本文に書かれた注記の文字列は見ないので、切れたのに切れていないと判定させることはできない。
  不正なUTF-8を含むログでは、切れていないのに切れたと判定することがある。
- `ensureSuccess`は使わない。
  本文をエラーの文に写してしまうためである。

結果は、呼び出し側が扱いを分ける種類を、例外にせず判別型で返す。

| 結果 | 条件 |
| --- | --- |
| `ok` | 2xxで、`gh`の終了コードが0。本文と`truncated`を持つ |
| `forbidden` | 403。トークンの権限が足りない |
| `log_unavailable` | 404か410。ログが無いか、保存期間を過ぎた |

例外は次の3種類である。

| 例外 | 条件 |
| --- | --- |
| `GitHubCiLogError` | 上の3つ以外のステータスと、応答が返らない通信断 |
| `GitHubCiLogIncompleteError` | 2xxなのに、取り直しても`gh`の終了コードが0以外 |
| `GitHubRateLimitError` | rate limit。ほかの読み取りと同じ |

`GitHubCiLogError`が持つのはHTTPのステータスだけである。
`GitHubCiLogIncompleteError`は、固定の文だけを持つ。
どちらも、本文、ヘッダー、`gh`のstderrは載せない。

ログは端末の制御列を含むので、`getWorkflowJobLog`だけが`gh api`に`--allow-escape-sequences`を渡す。
制御列の除去は、取得ではなく[ログの整形](#ログの整形)が行う。

2xxのステータスを受けた後でも、`gh`は本文を欠いたまま終わることがある。
次の場合は、本文が空か欠けて、終了コードが0以外になる。

- 制御列を理由に、`gh`が本文を出さない。
- 本文の途中で切れる。
- timeoutで止めた結果、本文が欠ける。

本文は見ず、終了コードで判定する。
一時的な切断をCIの回に持ち込まないため、GETが冪等であることを使い、1回だけ取り直す。
取り直しても終了コードが0以外なら、`GitHubCiLogIncompleteError`を投げる。
例外は呼び出し側のstepを止める。
Claudeは起動しない。
フローの再試行(`pr_fix_apply`は2回、60秒間隔)で、取得をやり直す。
再試行でも欠けたときは、作業項目が失敗で終わる。
回復が失敗の行を戻し、回数の上限の範囲で、次の巡回が評価し直す。
フラグを付けたのに`gh`が拒否する場面は特定できていない。
この例外は、`gh`の挙動が変わっても、本文の欠けたログをClaudeに渡さないための備えである。

出力が上限に達しても、runnerはプロセスを止めず、先頭と末尾を残して最後まで読む。
そのため、上限に達した正常なログは終了コード0で終わり、`truncated`つきのログとして返る。
終了コードが0以外なら、上限に達したかによらず、欠けたログとして扱う。

ログの取得先は署名付きURLへの302で、`gh`が内部でたどる。
URLは受け取らない。
エラー、ログ、戻り値のどれにも出さない。
認証情報が別のホストへ渡らないことは、`gh`の挙動に頼る。
このリポジトリのテストでは確かめられない。

## ログの整形

`cleanLogText`は、次のものを取り除く。
改行は残す。

- 端末の制御列(ANSIのCSI、OSC、DCSなど)。
  OSCはリンクの偽装に使われる。
- 行頭のタイムスタンプ
- 制御文字(C0、C1、DEL)
- 書式文字(書字方向の制御、ゼロ幅、タグ文字、BOM、ソフトハイフン)、私用領域、対のないサロゲート
- 異体字選択子、ハングルの詰め文字、クメール文字の固有母音、モンゴル文字の異体字選択子、点字の空白などの、見えない文字

改行コードと行区切りの文字は、LFにそろえる。
タブと幅の違う空白は、普通の空白にする。
検査の前に不可視文字を除くのは、不可視文字で分割された秘密値を、検査に見せるためである。

生のログが大きいときは、先頭の128K字と末尾の1M字だけを残してから、行に分ける。
間は省略の注記でつなぐ。
改行だけの巨大な入力でも、行の配列のメモリを有界にするためである。
間にある`##[error]`の行は落ちる。

改行の種類をそろえた後に、1行を2000字で切ってから、正規表現にかける。
進捗表示の復帰文字で区切られた行を、1行にまとめて切ってしまわないためである。
改行の無い巨大な入力でも、どの正規表現も入力の長さに比例した時間で終わらせるためである。
終端の無い制御列は、本文の文字クラスから改行、ESC、BELを除いて、ESCをまたいで照合し直さない。

整形の後、切る前の全文で、トークンの形の文字列を伏せる。
対象は`github_pat_`、`gh[oprsu]_`、`sk-ant-`で始まる文字列とDiscordのwebhookのURLで、接頭辞の後ろをすべて`***`にする。
切り口にかかった秘密値の一部が、gitleaksと`maskSecrets`の長さの条件をすり抜けて残ることを防ぐためである。

`condenseJobLog`は、整形したログを字数の上限に収める。

1. 空行と、`##[endgroup]`と`##[debug]`の行を捨てる。
2. 1行を、省略記号を含めて300字に収める。
3. 連続する同じ行を、1行と繰り返しの回数にまとめる。
4. 収まらなければ、先頭の1割、`##[error]`の行、末尾の順に割り当てる。
   `##[error]`の行は全体の3割までで、最後の1行を必ず含める。
   末尾を押し出さないためである。
5. 選ばなかった行は、省略した行数の注記でつなぐ。

上限は次のとおりである。

| 項目 | 値 |
| --- | --- |
| 1ジョブのログの字数 | 3000 |
| 全ジョブを合わせた字数 | 9000 |
| ログを渡すジョブ数 | 3 |
| ジョブごとの失敗したstepの数 | 5 |
| ジョブ名とstep名の字数 | 60 |

ジョブ名とstep名は、同じ除去を通し、トークンの形の文字列を伏せてから、空白を詰めて切る。
伏せるのは切る前である。切り口にかかった秘密値の断片を残さないためである。
空なら`(unnamed)`にする。

## 秘密値の検査

`buildCiExcerpt`は、gitleaks(`gitleaks stdin`)を二段にかける。

1. ジョブごとに、整形した絞る前の全文をかける。
   最大で約1.15M字(UTF-16の字数)である。
   UTF-8では最大で約3.4MBになりうる。
   抜粋から落ちる部分の秘密値でも、止めるためである。
2. トークンの形の文字列を伏せて絞った、全ジョブの文字列(ジョブ名、step名、ログ)を、1回かける。

`buildCiExcerpt`の呼び出しは最大で4回である(ジョブ数の上限3に1を足す)。
gitleaksの実行回数は、ステップごとに数える。

| ステップ | 最大の回数 | 内訳 |
| --- | --- | --- |
| 修正 | 5 | 抜粋の4回と、Claudeの出力(`guardCiRoundText`)の1回 |
| 検証 | 6 | 再実行の抜粋の4回と出力の1回、止める理由の検査の1回 |
| 完了 | 2 | 止める理由の検査の1回と、新規ファイルのパスの検査の1回 |

1回のタイムアウトは呼び出し側が決める。
`buildCiExcerpt`の検査にかかる時間は、最悪でタイムアウトの4倍になる。
設定は`GITLEAKS_DEFAULT_ONLY_CONFIG`に固定し、対象リポジトリの設定と無視ファイルを読ませない。
gitleaksの実行は`CiTextScanner`として注入する。
実際の実行は`runGitleaksOnText`である。

- どちらの段でも、検出があれば、行を消して続けず、`secret_detected`(理由`gitleaks`)を返す。
  最初の検出で止め、残りの検査はしない。
  抜粋が欠けた状態で修正させないためである。
  呼び出し側はClaudeを起動せず、人に渡す。
- 実行の失敗、タイムアウト、出力の打ち切り、想定外の終了コードは、検出ありと同じに扱う(理由`scan_failed`)。
  fail-closedにするためである。
- 検査を通った文字列にも、`maskSecrets`をかける。
  既知の形式の秘密値を、gitleaksとは別に伏せる二重の防御である。
- 全文の検査は、トークンの形の文字列を伏せる前に行う。
  検出のない接頭辞だけの断片が切り口にかかる場合は、伏せ字にして続ける。
- 使えるログ本文が無ければ`empty`を返す。
  呼び出し側は、ログを取得できなかった場合と同じに扱う。

`guardCiRoundText`は、CI回のClaudeが返したコミットの件名と本文、要約、停止の理由を、同じ手順で検査する。
ログの内容を写した文字列が、コミットや通知から外へ出ることを防ぐためである。
コミットメッセージを組み立てる前に使う。
この4項目で、CI回の出力文字列は足りる。

## 揮発する値

検査前のログは`VolatileCiLog`、検査を通った抜粋は`VolatileCiExcerpt`、抜粋を含むプロンプトは`VolatileCiPrompt`で包む。
どれも、プロンプトを作ってClaudeに渡す間だけ持つ値である。
stepの結果、DB、ログ、通知には載せない。
型で他の値と区別し、JSONにしようとすると例外を投げる。
文字列にしても中身を出さない。
stepの戻り値に混ざると、黙って記録されず、そのstepが失敗する。

## 失敗の分類

`classifyCiFailure`は、実行のジョブの名前と結論から、CI回で直せるかを決める。
結論が`failure`のジョブだけを見る。

| 結果 | 条件 |
| --- | --- |
| `fixable` | 失敗したジョブがすべて、Factoryが自動で直せる種類。`metadata`以外で失敗したジョブ(`jobs`)と、`metadata`の失敗の有無(`metadataFailed`)を返す |
| `unfixable_job` | 名前が空で、種類を決められない失敗がある |
| `other_conclusion` | `failure`以外の結論。`cancelled`、`timed_out`、`startup_failure`、`action_required`、`stale`、`unknown` |
| `no_failure` | 失敗したジョブが無い |

名前が`metadata`で始まるジョブの失敗は、Claudeではなく、`wmill-lock.yaml`のhashの再計算で直す。
CI回のClaudeには、シェルもロックファイルを書く権限も無いためである。
`metadata`だけが失敗したときは、`jobs`が空の`fixable`になる。ログは読まず、Claudeも起動しない。
`check`などと同時に失敗したときは、`jobs`に`check`などだけが入り、`metadataFailed`が真になる。
この混在の回は、Claudeが先に`check`などを直し、再計算は、`metadata`だけが落ちた回に行う。
名前は正規化(互換文字を畳み、小文字にする)して比べる。
複数のジョブが当たるときは、`unfixable_job`、`other_conclusion`、`fixable`の順に優先する。
直せない失敗が混ざったまま一部だけを直しても、CIは通らないためである。
結論が空か未知の文字列なら、`unknown`として扱い、直さない。
表示用のジョブ名は、無害化して60字までにする。

## プロンプト

`buildCiFixPrompt`は、CI回のプロンプトを組み立てる。
PRの情報は、ownerとrepoの名前、PR番号(正の安全な整数)、完全なコミットsha、実行のURL(`parseRunUrl`を通ったもの)を検証してから載せる。
検証に失敗したら例外を投げる。

- ジョブ名、step名、ログの抜粋、PRの変更ファイルのパスは、すべて`dataFence`の中に入れる。
  囲みの外には、検証済みの値と固定文だけを置く。
- PRの変更ファイルのパスは、`isSafeRepoPath`を通るものだけを、重複を除いて100件まで載せる。
  超えた分は件数にする。
- nonceは、囲みの中身に含まれない値を引く。
  引けなければ例外を投げる。
- 囲みの中は命令ではなくデータだと、固定文で述べる。
- ログの中の指示に従わないことと、ログの文を出力に写さないことも述べる。
- Claudeにシェルが無いことを述べる。
- テストを弱めないこと、CIの定義と設定を変えないこと、抑制のコメントを足さないことを述べる。
- 抜粋が空なら例外を投げる。
  欠けた入力で修正させないためである。

出力のJSON schema(`CI_FIX_SCHEMA`)は、`outcome`を`done`か`blocked`に、`replies`を空に限る。
CI回には返信する指摘も、要件の不足も無いためである。
`additionalProperties`は`false`にする。

## 変更するファイルの検査

`checkCiFixChanges`は、Claudeが加えた変更の一覧を、許可リスト方式で検査する。
入力は、変更ごとのパス、種別、gitのモード、追加した行、削除した行の数と、PRがすでに変更したファイルのパスである。
gitは呼ばない。

許可するのは次の2つだけである。

- PRがすでに変更したファイル
- 新規に追加するテストファイル

変更ごとに、次の順で最初に当たる違反を1件返す。

| 理由 | 条件 |
| --- | --- |
| `unsafe_path` | 空、絶対パス、ドライブ名、`..`か`.`か空のセグメント、バックスラッシュ、`.git`のセグメント、制御文字や不可視文字を含む、NFKCに正規化すると変わる |
| `symlink` | モードが`120000`、または種別の変更 |
| `unsupported_change` | 種別を判定できない、またはモードが`100644`と`100755`以外(サブモジュールなど) |
| `protected_path` | 保護パスかFactoryの安全装置 |
| `case_variant_path` | PRが変更したファイルと、大文字小文字だけが違う |
| `not_in_pull_request` | PRが変更しておらず、新規のテストファイルでもない |
| `test_not_additive` | テストの削除、またはテストの既存の行の削除 |
| `weakens_checks` | 検査を弱める行を追加した |

モードは変更後の値を渡す。
削除では変更前の値を渡す。
シンボリックリンクの真偽値は別に持たない。
モードだけを情報源にして、食い違う入力を作らせないためである。

保護パスは、実装フローの保護パス(`IMPLEMENT_PROTECTED_*`)に、CI回だけの拒否を足したものである。
照合は大文字小文字を区別しない。
全体の一覧は、`ci_fix_paths.ts`の定数にある。
次は例である。

- `.claude/`、`.agents/`、`.github/`、`console/src/`、`scripts/`、`migrations/`
- `wmill.yaml`、`wmill-lock.yaml`、`tsconfig*.json`、`biome.json`、`.mcp.json`、`*.script.lock`
- Windmillの定義: `*.schedule.yaml`、`*.variable.yaml`、`*.resource.yaml`、`*.resource-type.yaml`、`*.trigger.yaml`
- Windmillのflowの定義: `*__flow/`の配下
- 無視ファイル: `.gitignore`、`.ignore`、`.prettierignore`、`.eslintignore`、`.dockerignore`など、名前が`ignore`で終わる隠しファイル
- エディタの設定: `.editorconfig`
- テストの収集と実行を変えるファイル: `conftest.py`、`pytest.ini`、`tox.ini`、`.mocharc*`
- カバレッジとテストの準備: `.nycrc*`、`.c8rc*`、`.coveragerc`、`vitest.setup.*`、`jest.setup.*`
- Factoryの安全装置は、次の名前で始まるファイルである。
  - `f/factory/lib/`の`claude`、`protected_paths`、`log`、`workspace`、`check_sandbox`、`check_runner`、`prompts`、`github`
  - `f/factory/lib/`の`types`、`job_tmp`、`repo_owner_gate`、`model_policy`、`config`
  - `f/factory/lib/`の`host_action`、`process_lock`、`factory_repo_gate`
  - `f/factory/lib/`の`ci_`、`pr_ci_`、`main_ci_`、`pr_fix_launch`
  - `f/factory/lib/`の`metadata_`
  - `f/factory/steps/`の`pr_fix_`と`pr_workflow_support`
  - `f/factory/`の`watch_pr_ci`と`watch_main_ci`

CI回のClaudeがこれらを書き換えると、自分を止める検査を弱められるためである。
無視ファイルとテストの実行を変えるファイルは、`tests/`の配下の新規ファイルでも拒否する。
入れ子の`.gitignore`は、biomeの対象から既存のファイルを外せる。
`conftest.py`は、pytestの収集を変えられる。
この拒否は、テストのパスの判定より前に行う。
`github`を拒否するので、Factory自身のリポジトリで`github.ts`の不具合がCIを落としても、CI回は直せずに人へ渡す。

拒否した安全装置が直接importするモジュールは、拒否するか、受け入れる理由を書いた表に載せる。
表は`tests/lib/ci_fix_paths.test.ts`の`ACCEPTED_DEPENDENCIES`にあり、静的なimportを数えるテストが、一覧に無い依存や使われなくなった項目で失敗する。
受け入れたのは、ほかのフローが日常的に直す共有モジュールで、拒否すると正当な修正を止めるものである。
`db`、`discord`、`poll_support`、`implement_*`、`factory_clone`、`self_update_support`、`job_ids`、`prose_check`がこれにあたる。

テストのパスは、`tests`などのディレクトリの配下か、`*.test.ts`と`*.spec.ts`の形のものである。
テストは追加だけを許す。
削除と、既存の行を削る変更は拒否する。

追加行に検査を弱める記述が含まれたら拒否する。
全パターンは、`ci_fix_paths.ts`の`WEAKENING_PATTERNS`にある。
次は例である。
照合は大文字小文字を区別しない。

- 警告と型検査の抑制: `biome-ignore`、`@ts-ignore`、`@ts-expect-error`、`@ts-nocheck`、`eslint-disable`
- テストの除外と保留: `.skip`、`.only`、`.todo`、`.failing`、`.if(`、`.skipIf(`、`["skip"]`、`skip: true`、`xit(`、`fit(`
- テスト実行の中断とモジュールの差し替え: `process.exit(`、`mock.module(`
- テストの振る舞いの差し替え: `spyOn(`、`vi.mock(`、`jest.mock(`、`.mockImplementation`、`.mockReturnValue`、`.mockResolvedValue`
- カバレッジの除外: `istanbul ignore`、`c8 ignore`、`v8 ignore`
- 秘密値の検査の許可: `gitleaks:allow`
- 文書の検査の抑制: `markdownlint-disable`、`markdownlint-capture`、`markdownlint-configure-file`、`textlint-disable`
- ほかの言語の抑制: `# noqa`、`# type: ignore`、`nolint`

違反の報告に載せるパスは、不可視文字を除き、120字に切る。
パスは外部由来の文字列だからである。

## メタデータのパッチの受け取り

CIの`metadata`ジョブが出すパッチ(artifact)を、取得し、検査し、書き込む内容の一覧にする部品である。
artifactはPRの作者が完全に決められるので、安全は内容の制限で成り立たせる。
取り決めは[セキュリティ](../security.md#受け取る側が必ず確かめること)にある。

| ファイル | 責務 |
| --- | --- |
| `lib/github.ts` | 実行のartifactの一覧(`listWorkflowRunArtifacts`) |
| `lib/metadata_patch_download.ts` | zipのバイト列の取得(`downloadArtifactZip`)。トークンの渡し先と取得先の制限 |
| `lib/metadata_patch_zip.ts` | zipの安全な読み取り。結果は、パスから内容への対応 |
| `lib/metadata_patch_manifest.ts` | パスの許可リストと、manifestの形と上限 |
| `lib/metadata_patch_imports.ts` | scriptのimportの読み取り。相対importの閉包と、裸のimportの検出 |
| `lib/metadata_patch_yaml.ts` | `.script.yaml`と`wmill-lock.yaml`の検査 |
| `lib/metadata_patch_verify.ts` | 適用条件の検査。通れば書き込む内容を、通らなければ失敗の種別を返す |

### パッチの取得

zipは`fetch`で取得する。
`gh api`の出力は文字列に復号されるので、バイナリのzipが壊れるためである。
トークンはGitHubのAPIへの最初の要求にだけ載せ、リダイレクトはたどらない。
返った302の`Location`が、`https`のAzureのblob storageでなければ断る。
次の要求にはトークンを付けず、リダイレクトをたどらない。
この制限は、トークンを別のホストへ渡さないために、`github.ts`から分けた`metadata_patch_download.ts`に置き、保護パスにする。

取得の前に、期限切れと、申告された大きさ(`size_in_bytes`)が上限を超えるものを断る。
取得の間は、実際に受け取ったバイト数が上限を超えた時点で読むのをやめる。
上限は`metadata_patch_zip.ts`の`MAX_ZIP_BYTES`で、呼び出し側が渡す。

失敗は`GitHubArtifactDownloadError`で、種別とHTTPのステータスだけを持つ。
署名付きURL、本文、トークンは、例外とログに載せない。
取得したバイト列は、ログとDBに載せない。

### zipの読み取り

`readMetadataPatchZip`は、中央ディレクトリを自前で読み、`inflateRawSync`で展開する。
結果は`{ ok: true, files }`か`{ ok: false, reason }`で、`reason`は固定の種別である。
zipの中の文字列は、`reason`に載せない。
断る内容は、[セキュリティ](../security.md#zipの内容の制限)にある。

### importの読み取り

`metadata_patch_imports.ts`は、`Bun.Transpiler`の`scanImports`で、import文、`export from`、動的import、requireの呼び出しを読む。
トランスパイラは構文を解析するので、コメントや文字列の中のimport風の文字列は拾わず、コメントで引用符を挟んだ隠し方も見抜く。
トランスパイラが落とす型だけのimport、波括弧の中が型修飾子だけのimport、型の位置の動的importは、正規表現で足す。
型の位置でしか使わないimportでも、`import { Foo } from "x"`の形は、トランスパイラが返す。

指定子は、局所と裸に分ける。
局所は、相対の指定子と、`/f/`で始まる指定子である。
`resolveLocal`が、局所の指定子を、headの木の`f/`の下の`.ts`の一覧(`listHeadSources`)に解決する。
`/f/`は`f/`と読む。候補は、そのままのパス、`.ts`の補完、`.js`の読み替え、`index.ts`で、一覧にあるものだけを選ぶ。
拡張子のないファイルは、一覧に無いので選ばない。
閉包の計算と、依存の集合をたどる処理は、同じ関数を使う。

次のimportは、指定子を決められないので、追えないものとして扱う。
引数に単独の文字列リテラルを取らない動的importとrequireの呼び出しと、import属性は、トランスパイラに渡さない。

- 引数が、エスケープを含まない単独の文字列リテラルでない動的importとrequireの呼び出し。連結を含む。
  指定子の後ろに第2引数(import属性など)や末尾のコンマが付く形も、含む。
- メソッドとして呼ぶrequire(`import.meta.require`や`loader.require`)。
- import属性。語の`with`か`assert`の直後が、開き波括弧かコメントの開始であるもの。
  間に空白や改行を挟んでも、コメントを挟んでも断る。`type: "macro"`はビルド時にコードを実行するためである。
  コメントは終端を探さず、開始だけで断る。終端を探すと、入力によっては計算量が2乗になる。
- `/u/`と、`/f/`以外の`/`で始まる指定子。
- 局所の指定子が、一覧のファイルに解決できないもの。
- トランスパイラが読めないソースと、1ファイルの上限を超えるファイル。

呼び出しの形と属性の形は、コメントや文字列の中の出現も追えないものに倒す。誤って断る側である。
`f/`の下のすべての`.ts`が、追えるものとして読めることを、テストで確かめる。

ファイルの読み取りとimportの解析は、パスごとに1回だけ行い、結果を使い回す。

### 適用条件の検査

`verifyMetadataPatch`は、実行とPRの事実、zipの展開結果、読み取りのポートを受け取る。
自分ではI/Oをしない。
ポートは、履歴の祖先の判定、merge commitの親の取得、headの木の`f/`の下の`.ts`の一覧(`listHeadSources`)、headの木とbaseの木のファイルの読み取りである。
baseの木は、baseブランチの今の先端(`PrFacts.baseSha`)の木である。
manifestの`baseSha`と`mergeSha`は出どころの照合にだけ使い、内容の比較には使わない。過去のcommitを選ばれないためである。
`isAncestor`は、判定できないことをnullで伝える。
`readHeadFile`と`readBaseFile`は、無いことと読めないことを分けて返し、読めないときは検査が断る。
ほかのポートは、失敗を例外で伝え、検査は例外をそのまま投げる。

検査は次の順に行い、最初に当たった失敗を返す。

1. 実行の出どころとPRの差分
2. manifestと、実体の大きさとsha256、削除、保護パス
3. 履歴。`baseSha`がbaseの今の先端の祖先であること、headがbaseの今の先端を含むこと、`mergeSha`の親の順序。
   headが先端を含まないときは`head_lacks_base`で断り、`main`を取り込んだ後の再実行を待つ。依存の比較のずれで、人の手に回さない。
4. ファイルごとの内容

PRの差分(`PrFacts.diff`)は、`base...head`の全件でなければならない。
呼び出し側は、APIの件数の上限で切れたときに`diffTruncated`を真にする。
真のときは、許可リストの外のパスを見落とすので、検査はパッチを断る。

ファイルごとの検査の条件は、[セキュリティ](../security.md#lockの制限)にある。

成功の結果は、書き込む内容の一覧(`writes`)である。
書き込む側は、headの木のsymlinkをたどって木の外へ書かないよう、書き込む前に確かめる。
失敗の結果は、固定の種別(`code`)と、無害化した補足(`detail`)である。
補足はパスなど入力に由来する値を含み、PRの作者が決められる。
補足は、制御文字、書式文字、行の区切りを除き、バッククォートを`'`に置き換え、JSONの文字列にして長さを切る。
PR本文やコメントに載せるときは、コードスパンで囲み、メンションとリンクを無効にする。
置き換え済みなので、補足は囲んだコードスパンを内側から閉じられない。

### 再計算の配線の方針

hashの再計算をCI回のflowへ配線する際の決定は、次のとおりである。
流れは[metadataジョブの失敗を直す経路](#metadataジョブの失敗を直す経路)に書く。

- artifactを経由しない再計算を、artifactの適用の代わりに、先に試す。
  `metadata`ジョブが落ちたCI回は、修正のステップがまず再計算を試す。
  再計算は`schema`を書かないので、`main`の引数が変わるPRは、事前検査が人の手に回す。
- ポートの実装は、`metadata_git_ports.ts`にある。
  木の一覧は`git ls-tree`、ファイルは`git cat-file blob`、祖先の判定は`git merge-base --is-ancestor`である。
  GitHubのREST APIでは読まない。ファイルごとの読み取りでPATのrate limitを使い切らないためである。
- ポートは、gitを引数の配列で呼び、シェルを通さない。
  blobは、木の項目の`oid`で読む。PRの作者が決められるパスを、gitの引数にもシェルの文字列にも使わない。
- baseの先端は、GitHubのAPIでbaseブランチの先端のshaを読んで使う。
  PRのAPIの`base.sha`は使わない。baseブランチの今の先端とは限らないためである。
  そのcommitがローカルに無いときだけ、shaを指定して取り込む。追跡refは動かさない。
- 再計算が書き込むcommitの親は、`head_sha`に固定する。
  `commitAndPush`が、ローカルのHEADが`head_sha`であることと、リモートのブランチの先端が`head_sha`であることを確かめる。
  pushは強制しないので、先端が動いていればpushは拒否される。`--force*`は使わない。
- 検査の後にheadが動く競合は、完了のステップが、pushの直前にPRのheadを読み直して確かめる。
- baseの先端が動く競合は、照合の中と、pushの直前の2か所で確かめる。
  動いていれば、pushせず、新しい先端で確かめ直す。取り直しは3回までで、本文が変わるときは回を止める。
- `main`が進んでPRのheadがbaseの先端を含まなくなる(`head_lacks_base`)ときは、人の手に回す。
  待つ扱いにしない。mainを取り込むのは人のcommitで、Factoryのcommitだけを自動で直す前提から外れ、待っても再計算は始まらない。
  通知は`metadata_manual`で、必要ならmainを取り込んで`mise run metadata`を実行する案内になる。
- 再計算と`main`の取り込みを繰り返さないので、その回数の上限は無い。
  再計算の回は、`pr_ci_fix_max_rounds`が数える回に含める。
- 再計算が直せるPRの割合は、人の手に回った作業項目の理由で測る。
  理由は`ci round: the lock cannot be recomputed automatically (<種別>)`で、種別は固定の語彙である。
  作業項目の理由を種別ごとに数える。
- `ls-tree`の出力が上限で切れたときと、形が合わないときは、同じcommitで何度読んでも直らない。
  ポートは`TreeUnreadableError`を投げ、検査は`tree_unreadable`を返して、人の手に回す。
  時間切れとgitの失敗は一時的なので、ふつうの例外を投げ、検査は`port_error`を返す。
  修正のステップは、`port_error`を例外にして、flowの再試行に任せる。
- `readBlob`の戻り値の形が合わないのは、ポートの実装の誤りである。
  検査は`port_error`を返し、再試行に任せる。実装の誤りは、ポートのテストが見つける。
- パスにU+FFFDを含む項目と、同じパスの重複は、事前検査が`invalid_tree`で人の手に回す。
  不正なUTF-8のパスを文字列にすると、別のパスが同じ文字列になり、表の項目が消えるためである。
- ファイルが無いまま`wmill-lock.yaml`に残っている項目(孤児のキー)は、再計算がそのまま残す。
- 再計算はwmill CLIを起動しない。workerのwmill CLIの版が`mise.toml`の版と違っても、結果に影響しない。
  算法は、固定した版の挙動を写したもので、版の変更は[算法を固定するテスト](#算法を固定するテスト)が見つける。
- 再計算のcommitの後、PRの状態は通常のCI回と同じになる。
  作業項目のheadを記録しないので、`poll_prs`が新しいheadの再レビューを起動する。
- `main`の取り込みで`wmill-lock.yaml`が衝突したときは、人が解消する。

### artifactの適用で残る論点

次は、artifactのパッチを適用する側を実装するときに決める。
検査は、これらを前提にしない。
最初の項目は、呼び出し側が守る契約である。

- 出どころの検査を先に呼ぶ。
  `checkProvenance`は、実行の事実とPRの差分だけを見る。artifactもポートも渡さない。
  呼び出し側は、`listWorkflowRunArtifacts`と`downloadArtifactZip`より前にこれを呼び、失敗ならダウンロードも展開もしない。
  出どころで断れるものを、ネットワークとメモリを使う前に断るためである。
  `verifyMetadataPatch`も先頭で同じ検査をもう一度行うので、呼び忘れても通ることはない。
- artifactの適用でも、ポートはローカルのcloneで実装する。
  対象は、`listHeadSources`、`readHeadFile`、`readBaseFile`、`isAncestor`、`readCommitParents`である。
- artifactの適用でも、commitの親を`headSha`に固定し、pushの直前にブランチの先端とbaseの先端を確かめる。
- `ci.yml`が、artifactのIDとdigestを`metadata`ジョブのログに出す処理は、まだ無い。
  追加は保護パス(`.github/`)の変更なので、別に行う。
  照合できない間は、パッチを適用しない。
- フローのキー(`__flow+...`)が変わるパッチの扱い。
- artifactのIDとdigestを、`metadata`ジョブのログの値と照合する手順。
- `mergeSha`を本物のPRのmerge commitに結び付けること。適用の前に、GitHub APIのPRの`merge_commit_sha`と照合する。
  lockの比較先はheadの木とbaseの先端の木で、過去のcommitを選べないので、残るリスクは出どころの補助が破られる程度である。
- `main`の依存更新のたびに、閉包の多くのscriptで、依存の集合かlockが食い違う場合の扱い。検査の前に、`main`を取り込む。
- `.script.yaml`だけの変更や、scriptの削除で、キーが変わる、または消えるときの扱い。

再計算の配線で、今は扱わないこともある。

- 再計算の回でも、照合からCIを読み直すまでの間にCIの状態が変わると、`deny`になること。
  人が`metadata`ジョブを再実行した場合、PRが閉じた場合、headが動いた場合である。
  保護パスの違反になり、保留は`fix_stopped`で、案内は付かない。
  回の種類を、DBの作業項目に印として書く案は、決定的な回を数える列と合わせて検討する。
- 照合の`deny`(`mismatch`)に、一時的な原因が含まれること。
  baseの先端が3回動き続けた場合と、`readRootWmillLock`や`readStagedRootLock`の読み取りの失敗である。
  今は保護パスの違反として扱うので、保留は`fix_stopped`になる。原因を分けるかは、頻度を測ってから決める。
- `scan_unavailable`で保留した行は、workerを更新しても、headが進むまで外れない。
  決定的な理由は同じheadでは起動し直さないためである。
- 同じheadで`RehashTransientError`がN回続いたら、決定的な失敗に切り替えること。
  今は、flowの再試行の上限で失敗し、回復が行を戻す。
- 決定的な回だけを別に数えること。
  数えるには、作業項目に印を持たせる列か、`agent_runs`を使う問い合わせの追加が要る。DBの変更を伴うので、別に行う。
- `head_lacks_base`のPRを待ち扱いにすること。
  Factoryがmainを取り込む仕組みが先に要る。
  仕組みを決めるために、過去のFactoryのPRで、`metadata`ジョブが落ちた回にheadがbaseの先端を含んでいた割合を測る。
  この割合が、再計算が直せるPRの上限の目安になる。
  測るものには、CIが落ちてから監視が拾うまでの間に、mainが進んでheadがbaseの先端を含まなくなる割合も含める。
  これらの測定は、再計算の配線の外で行う。
- 再確認の基準を、baseの先端ではなく`merge-base(baseの先端, head)`にすること。
  mainが進むと、再確認が`head_lacks_base`になり、人の手に回る頻度が上がる。
  上の割合の測定と合わせて、基準を変える効果を測ってから決める。
- 直せる失敗と`metadata`が同時に落ちた回で、Claudeを起動する前に事前検査を試すこと。
  Claudeが`f/`を触るかは、起動の前には決められない。今は混在の回を、Claudeが先に直す。
- `lock_up_to_date`で止めた回の、失敗したジョブの自動の再実行。
  Windmillの起動やログインで落ちた実行をやり直すには、ActionsのPATの書き込み権限が要る。
- 反映の前に`unfixable_job`で保留した行の案内の描き直し。反映の手順で扱う。

## メタデータのhashの再計算

wmill CLIとバックエンドを使わずに、Factory自身が`wmill-lock.yaml`のhashを計算し直す部品である。
共有のlibを変えたPRは、CIの`metadata`ジョブが、hashの食い違いで落ちる。
再計算は、このうち依存が変わらないPRだけを直す。
artifactを経由しないので、取得、zip、出どころ、manifestの検査は要らない。
未信頼のPRのheadを読むだけで、scriptの実行も、wmill CLIの起動もしない。
事前検査は、悪意のあるPRに対する境界ではなく、悪意のないPRで古い`schema`やlockが最新のように書き直されるのを防ぐ、正しさの検査である。
取り決めは[セキュリティ](../security.md#hashの再計算)にある。

### 再計算の部品

| ファイル | 責務 |
| --- | --- |
| `lib/metadata_hash.ts` | ファイルの内容から、`wmill-lock.yaml`の全キーのhashを計算する(`computeLockEntries`)。既存のlockの行ごとの値だけを置き換える(`patchWmillLock`) |
| `lib/metadata_precheck.ts` | gitの木を読み、依存が変わらない再生成かを確かめる(`planMetadataRehash`)。確かめられたときだけ、新しい本文と、変わったキーを返す。正しさを守る検査で、敵対的な入力に対する境界ではない |
| `lib/metadata_signature.ts` | `main`と`preprocessor`の署名、トップレベルの型宣言、Windmillの注釈を、字句で読んで比べる |
| `lib/metadata_git_ports.ts` | 事前検査が読むポートを、ローカルのcloneのgitで実装する(`createGitPrecheckPorts`) |

4つとも、保護パスである。

### hashの算法

算法は、`mise.toml`で固定したwmill CLIの版(`ASSUMED_WMILL_CLI_VERSION`)から写した。
写し元は、`generateScriptHash`、`generateFlowHash`、`generate-metadata rehash`の分岐である。

- scriptのhashは、ワークスペースの依存のJSON、scriptのソース、`.script.yaml`の全文を、この順につなげたsha256である。
  `dependencies/`が無いので、依存のJSONは`{}`に固定する。
- scriptのキーは、拡張子を除いたパスである。
  wmillは最初の`.`までをキーにするので、拡張子の前に`.`を含む名前は扱わない。
- flow全体のhashは、フォルダ直下のscriptのファイルごとのhashを、キーでソートして並べたJSONのsha256である。
  キーは`<フォルダ>+__flow_hash`である。
  インラインscript(フォルダの中のscriptの拡張子のファイル)を持つflowは、実物のwmillと照合できていないので扱わない。
  扱うのは、インラインscriptを持たないflowだけで、hashは空のオブジェクトのsha256になる。
- `flow.yaml`、`.script.lock`、依存先のscript、`wmill.yaml`、言語は、hashに入らない。
- 先頭のBOMは、1つだけ取り除いてからhashに入れる。
  wmill CLI 1.817.0に、BOM付きのコピーで`generate-metadata rehash`をかけて確かめた。
  2つ目のBOMは残るので、`.ts`と`.script.yaml`の両方で、2つ並んだBOMは別のhashになる。

`patchWmillLock`は、既存の行の値だけを置き換える。
引用符、キーの順、改行は変えない。
置き換えた結果は`parseWmillLock`で読み直し、形が崩れていないことを確かめる。
再計算したキーが元のlockに無いときは、置き換えず、失敗として返す。
元のlockのキーに再計算した値が無いときも、同じく失敗として返す。
ただし、ファイルが無いまま残っている項目は例外である。
wmillも消さない項目なので、baseの先端の木で、ファイルから決まらなかったキーは、そのまま残す。

### 事前検査

`planMetadataRehash`は、baseの先端とheadのcommitを受け取る。
読み取りは、木の一覧(`listTree`)、blobの読み取り(`readBlob`)、祖先の判定(`isAncestor`)の3つのポートで行う。
ポートを実装するときは、gitのオブジェクトから読む。
作業ツリーのファイルは開かない。
`metadata_precheck.ts`は、ポートの型と、受け取った値の検査だけを持つ。gitを使うポートは`metadata_git_ports.ts`が実装する。

- `listTree`は、`git ls-tree -r -z -l <sha>`を実行する。submoduleの大きさ(`-`)は0にする。
  失敗は2つに分ける。
  - 出力が上限(32MiB)で切れたときと、形が合わないときは、`TreeUnreadableError`を投げる。同じcommitでは何度読んでも直らない。
  - 時間を超えたときと、gitが失敗したときは、ふつうの例外を投げる。一時的な失敗である。
- `readBlob`は、同じcommitの木の項目から`oid`を引き、`git cat-file blob <oid>`を実行する。パスはgitの引数にしない。木は、commitごとに1回だけ読む。
- blobの標準出力は、文字列に復号せず、バイト列で受け取る。復号すると、先頭のBOMが落ち、不正なUTF-8が置き換わり、hashの入力が変わるためである。
- 木に無いパスは`missing`にする。blobでない項目と、大きさが木の申告と違う内容は`failed`にする。
- `readBlob`のgitの失敗と時間切れは、一時的なので、`failed`にせず例外を投げる。
  `failed`は、検査が`read_failed`として人の手に回すので、一時的な失敗を含めない。
- `isAncestor`は、`git merge-base --is-ancestor`の終了コード0を`true`、1を`false`にし、それ以外は`null`にする。
- `ref`は40桁の小文字の16進数に限る。短い名前は、別のrefに解決されうるためである。
- gitは引数の配列で実行し、`buildGitArgv`の固定の設定と`localGitEnv`の環境変数を使う。
PRの差分は、2つの木の`f/`の下を、blobのIDで比べて求める。
名前の変更は、削除と追加の2件に見えるので、scriptの集合が変わったものとして扱う。

ポートの値は、受け取った入口で検査する。
`baseSha`と`headSha`は40桁の小文字の16進数、木の項目の`oid`は40桁か64桁の小文字の16進数、`size`は0以上の整数でなければならない。
`readBlob`の戻り値は、`kind`が3つのどれかで、見つかったときの内容がバイト列でなければならない。
形が合わないときは`port_error`を返す。
`readBlob`の内容は、木の項目の`oid`と照合する。
`blob <長さ>`と空文字(NUL)を前に付けた内容のハッシュで、`oid`が40桁ならSHA-1、64桁ならSHA-256を使う。
ポートが別のrefや作業ツリーを読んだ誤りを、断つためである。
`isAncestor`は、`true`のときだけ祖先とみなす。
`listTree`を実装するときは、`git ls-tree -r -l -z`を使う。
`-z`を付けないと、非ASCIIのパスが引用符つきで返り、実際のパスと一致しなくなる。

次の表の順に確かめ、最初に外れた条件の種別を返す。

| 確かめること | 外れたときの種別 |
| --- | --- |
| `baseSha`と`headSha`が40桁の16進数で、木の項目の形が正しい。パスにU+FFFDが無く、同じパスの重複も無い。上限の値が正の安全な整数である | `invalid_ref`、`invalid_tree`、`invalid_limit` |
| 実行時に残るimportの読み方が、固定の小さな入力で想定どおりである | `scan_unavailable` |
| 読んだ内容が、木の項目の`oid`と一致する。木に無いパスで内容が返らない。`readBlob`の戻り値の形が正しい | `blob_mismatch`、`port_error` |
| headがbaseの先端を含む | `head_lacks_base`、判定できないときは`ancestry_unknown` |
| `f/`、`wmill.yaml`、`wmill-lock.yaml`、`dependencies/`にsymlinkとsubmoduleが無い | `special_file` |
| 上の4つのファイルと`f/`のファイルが、大きさと件数の上限以下 | `file_too_large`、`too_many_files` |
| 申告の大きさの合計と、読んだバイト数の合計が、headとbaseのそれぞれで上限以下 | `too_much_input` |
| headに`dependencies/`が無い | `workspace_dependencies` |
| `wmill.yaml`がbaseの先端と同一 | `wmill_yaml_changed` |
| PRの差分に、scriptとflowのファイルの追加、削除、名前の変更が無い。許可リストにない種類のファイルの追加と削除も無い | `script_set_changed` |
| PRの差分に、`.script.lock`とflowのlockが無い | `lock_file_changed` |
| PRの差分に、flowの定義の変更が無い | `flow_changed` |
| PRの差分に、`.script.yaml`が無い | `script_yaml_changed` |
| 変更されたscriptが、TypeScript(bun)である | `unsupported_script` |
| すべてのscriptで、実行時に残る裸のimportの閉包が、baseの先端とheadで同じ | `dependency_changed`、追えないときは`dependency_untraceable`、読めないときは`read_failed`、訪問と局所importの解決の合計が上限を超えるときは`too_much_input` |
| 変更された`.ts`の注釈、`main`と`preprocessor`の署名、型宣言が、baseの先端と同じ | `annotation_changed`、`main_changed`、`main_presence_changed`、`preprocessor_changed`、`declaration_changed`、読めないときは`main_unparsable` |
| hashを計算できる形である。インラインscriptを持つflowは計算できない | `unsupported_script`、`missing_metadata`、`not_text`、`duplicate_key` |
| baseの先端のscriptとflowから計算したhashが、baseの先端の`wmill-lock.yaml`の値と、すべてのキーで一致する | `base_stale` |
| 再計算したキーの集合が、headのlockのキーの集合と一致する | `lock_key_set_mismatch`、`wmill_lock_invalid` |
| hashが変わるキーが、PRが`.ts`を変えたscriptのキーか、baseの先端のlockの値に戻すキーだけである | `unexpected_key_change` |

ポートが例外を投げたときは、`port_error`を返す。
ただし、`listTree`が`TreeUnreadableError`を投げたときは、`tree_unreadable`を返す。
表の自己検査が外れたときは、`scan_unavailable`を返す。
それ以外の想定外の例外は、`internal_error`を返す。
一時的な種別は、`port_error`と`ancestry_unknown`だけである。ほかは、再試行しても変わらない。
`read_failed`は、木にあるのに内容が無いときと、大きさが木の申告と合わないときだけ返す。
種別は固定で、例外の内容は載せない。補足は、`scan_unavailable`のBunの版と、`internal_error`の例外の種類だけである。
閉包をたどる間は、読んだ内容を保持せず、必要なら読み直す。
hashの計算では、木ごとに、入力のファイルをまとめて保持する。
保持量は、読む合計の上限までである。

追加と削除を許す種類の許可リストは、次の名前の末尾である。
これらは、scriptのhashに関わらない。

- `.schedule.yaml`、`.variable.yaml`、`.resource.yaml`、`.resource-type.yaml`
- `folder.meta.yaml`、`.md`

トリガーのファイルは、許可リストに入れない。
Windmillのトリガーのファイル名は`*.http_trigger.yaml`などの形である。
`wmill.yaml`の`includeTriggers`が無効で、このリポジトリのトリガーはsyncしないので、追加と削除は人の手に回ってよい。

失敗の`path`はPRの作者が決められるので、PR本文やコメントに載せるときは無害化する。

裸のimportの閉包は、[importの読み取り](#importの読み取り)と同じ関数で求める。
ただし、実行時に残るimportだけを数える(`runtimeOnly`)。
型だけのimport、型だけのexport、型の位置でしか使わないimport、使われないimportは、トランスパイラが省くので数えない。
読み方は、`trimUnusedImports`を有効にした`Bun.Transpiler`の`scanImports`だけである。
実行しない読み方だけを使う理由は、[セキュリティ](../security.md#hashの再計算)にある。
マクロの実測の根拠は、`tests/lib/metadata_patch_imports_runtime.test.ts`にある。
閉包の実測の根拠は、リポジトリの全scriptで閉包のパッケージ名と`.script.lock`の`dependencies`のキーが一致するテストにある。
値のimportに書き換えて本体で使い始める変更は、省かれていたimportが現れるので、依存の変化として人の手に回る。
PRが触っていないscriptも、すべて確かめる。
追えないimportが1つでもあれば、その1つのために全体が人の手に回る。
局所importの解決は、headの木の`f/`の下の`.ts`の一覧で、両方の木に同じように行う。

上限の値は、次の定数が持つ。

| 上限 | 定数 | 置き場所 |
| --- | --- | --- |
| 1ファイルの大きさ | `MAX_FILE_BYTES` | `metadata_patch_manifest.ts` |
| `f/`のファイル数 | `MAX_SOURCES` | `metadata_patch_verify.ts` |
| 読むバイト数の合計 | `DEFAULT_MAX_READ_BYTES` | `metadata_precheck.ts` |
| 訪問と局所importの解決の合計 | `DEFAULT_MAX_TRACE_VISITS` | `metadata_precheck.ts` |
| 1scriptがたどるファイル数 | `MAX_TRACED_FILES` | `metadata_patch_imports.ts` |
| 型宣言の範囲を数える字句の数(範囲を探す字句と、ダイジェストのために読む字句の合計) | `MAX_DECLARATION_STEPS` | `metadata_signature.ts` |

### 人の手に回す条件

事前検査が、再試行しても直らない種別を返したときは、再計算せず、人が手元で`mise run metadata`を実行して直す。
一時的な種別は、人の手に回さず、例外にして再試行する([事前検査](#事前検査))。
判断できないとき、読めないとき、字句の切れ目に確信が持てないときは、通さずに人の手に回す。
通すと依存の変化を見落とし、回すと人の作業が増えるだけで済むためである。

### mainの引数の比べ方

`.script.yaml`のうち、コードから決まる項目は、`schema`と`has_preprocessor`である。
そこで、`main`と`preprocessor`の署名と型宣言が同じなら、`.script.yaml`も同じとみなす。
`metadata_signature.ts`は、構文木を作らず、字句で読む。
workerで動くwasmのパーサーに、依存を増やさないためである。

- コメントを除き、文字列、テンプレート、正規表現を1つの字句にして、括弧の対応を数える。
- 署名は、`export function main`(`async`つきを含む)から、本体の開き波括弧の前までである。
  引数の既定値と戻り値の型を含むので、`schema`の`default`が変わるときも署名が変わる。
- トップレベルの`type`、`interface`、`enum`、`class`の宣言文も、署名とあわせて比べる。
  同じファイルの型宣言の中身を変えると、`schema`が変わる(実測)ためである。
  比べる宣言は、`main`の署名が参照するものに絞らず、ファイルのすべてにする。
  `.script.yaml`が変わらない変更でも人の手に回りうるが、安全側の措置である。
- 型宣言は、`main`と`preprocessor`のどちらかがあるファイルだけで比べる。
  どちらも無いファイル(lib)は、型のフィールド、enumの値、classのメソッドの追加と変更が、`.script.yaml`を変えなかった(実測)。
- 空白とコメントの違いは、違いとして扱わない。
- 字句を読み切れないときは、読めないものとして断る。
  閉じない文字列とコメント、閉じ波括弧の後の`/`、括弧の不一致がこれにあたる。
- `main`と`preprocessor`が`export function`以外の形で公開されるとき(変数、既定のexport、`export { main }`)と、2つ以上あるときも断る。
  `export`の次の12字句までを、`=`、`(`、`;`で止めて見る。改行では止めない。
- Windmillの注釈に見えるコメント行(`//npm`、`//nodejs`、`//native`、`// package_json: x`など)の集合も比べる。
  形は、`//`の後に1語、続けて任意で`:`と値、とする。ファイルのどこにあっても拾う。
  1語だけの普通のコメントも拾うので、その追加や変更は人の手に回る。
- テンプレートの`${}`の入れ子は64段までにし、超えたら読めないものとして断る。
  字句に分ける処理が例外を投げたときも、読めないものとして断る。

実機で確かめた、コードと`.script.yaml`、`.script.lock`の関係は次のとおりである(wmill CLI 1.817.0、ローカルのWindmill)。

- 同じファイルの`type`宣言の中身を変えると、`.script.yaml`の`schema`が変わる(`properties`の追加、`enum`の値の追加)。
- 別のファイルからimportした型の中身と、型をimportする元のファイルは、`.script.yaml`を変えない。引数の型は、型名(`Opts`なら`format: resource-opts`)で決まる。
- `main`のJSDoc、引数の前後のコメント、`main`の本体のコメントは、`.script.yaml`を変えない。
- `preprocessor`の追加は、`has_preprocessor: true`を足す。署名の変更は`.script.yaml`を変えないが、署名も比べる。
- `//npm`の追加は、`.script.lock`のbun.lockの部分を変える。
- `//nodejs`、`//nobundling`、`//native`、`//bun`は、`.script.lock`を変えなかった。
  ただし、実行の仕方を変えるので、比べる。
- `//npm foo`、`//nobundling // x`、`//npm,nodejs`は、`.script.lock`を変えなかった。注釈の形を、1語の後ろに任意の文字を許す形に広げる必要は無い。
- `// package_json: {…}`と値を同じ行に書く形は、`.script.lock`を`// workspace-dependencies-mode: manual`に変える。
- `// package_json:`と`//extra_package_json:`の後ろの行に値を書く形は、このWindmillでは、`.script.lock`を作れず失敗する。
  失敗の理由は、このworkerが、インラインのworkspace dependenciesとextra modeを使えないことである。
  依存が実際に解決される形は確かめられなかったので、`:`で終わる注釈と、`:`の後に値がある注釈に続く`//`の行を、注釈として集めて比べる。
- exportの付かない`function main(x: string) {}`の追加は、`schema`を変える。`export default function main`は、`.script.yaml`を変えなかった。
  exportの有無にかかわらず、`main`の宣言を見つけたら人の手に回す。
- アロー関数の`const main = (a: string) => {}`は、`export`の有無を問わず、追加と変更のどちらでも、`.script.yaml`を変えなかった。
  `export const main`は安全側に人の手に回すが、`schema`の元にはならない。
- 使われないimportと、型の位置でしか使わないimportの追加は、`.script.lock`の`dependencies`を変えない。
  値として使うimportの追加は、変える。
- 字句の読み取りは、括弧が対応する入力を前提にする。
  `checkDependencies`が先に、headのすべての`.ts`をトランスパイラに通すので、構文が不正な入力はそこで断られる。
  型宣言の範囲を数える処理は、数える字句の数に上限を置き、仕事量を有界にしている。
  範囲を探すために進めた字句と、宣言のダイジェストのために読んだ字句を、あわせて数える。
  宣言は文字列として持たず、sha256のダイジェストだけを持つ。
  範囲が重なる宣言(`class A1 extends class A2 extends …`のように入れ子にした形)が、同じ本体を何度も保持しないためである。
  超えたら`main_unparsable`で人の手に回る。
  括弧が対応する入力を前提にする点は、この順序に頼る。

### 算法を固定するテスト

`tests/lib/metadata_hash.test.ts`は、リポジトリのcommit済みのファイルから計算したhashを、`wmill-lock.yaml`のすべての項目と比べる。
ファイルが無いまま残っている項目だけが、一覧で例外になる。
`mise.toml`のwmill CLIの版が、`ASSUMED_WMILL_CLI_VERSION`と違うときも、このテストが落ちる。

テストが落ちたときは、算法を確かめ直す。

1. 新しい版の`generateScriptHash`、`generateFlowHash`、`generate-metadata rehash`の分岐を読む。
2. 摂動を加えたコピーで、`wmill generate-metadata rehash`の出力と`patchWmillLock`の結果を、バイトで比べる。
3. 再計算したlockで、`wmill generate-metadata --dry-run`が、すべて最新だと答えることを確かめる。
4. `ASSUMED_WMILL_CLI_VERSION`を直す。

`rehash`はバックエンドなしで動き、依存が変わらないPRでは、通常の再生成と同じ`wmill-lock.yaml`を出す。
確かめ直すときの照合に使い、テストの本体には入れない。

## 既知の限界

- 抑制の記述の検出は、追加行を1行ずつ見る文字列の照合である。
- 囲みによる無効化は検出できない。
  `if (false)`で囲む、別の関数に包んで呼ばない、コメントアウトする、といった書き方である。
- `if (false)`の単独は、誤検知が多いので検出の対象にしない。
- テストの期待値の書き換えは、機械では判定できない。
  再レビューに頼る。
- 非テストのファイルで、行を削って検査を無効にする変更も、機械では判定できない。
- 追加行で既存のテストの振る舞いを変えられる書き方が、ほかにもありうる。
  差し替えの関数を呼ばずに、グローバルの値を直接書き換える、といった書き方である。
- 拒否した安全装置の依存のうち、受け入れた共有モジュールは、CI回のClaudeが書き換えられる。
- base64に包まれた秘密値や、複数の行に分割された秘密値は、gitleaksと`maskSecrets`で検出できない可能性がある。
- 生のログが大きいときは、先頭と末尾以外を読まない。
  間にある`##[error]`の行は落ちる。
- 新規ファイルのパスの秘密値の検査は、秘密値と似た文字列を含む正当なファイル名を、誤検知として止める。
  止まった修正は、行が`fix_stopped`で保留される。人が直してPRにpushするまで、同じheadでは起動し直さない。
- 再レビューでCI回の差分を重点的に見る固定文は、CI回のpushの後、レビューの前に人がpushすると外れる。
  レビューするshaが変わり、CI回のpushしたcommitを含まなくなるためである。
  この抜けは受け入れる。通常のレビューは変わらず行われるためである。
- 再レビューでCI回の差分を重点的に見る固定文は、DBの問い合わせが失敗すると外れる。
  列が無い、行の形が合わないといった続く失敗でも同じである。
  失敗すると、重点確認は黙って外れる。残るのは`log.warn`だけで、noticeと通知は出さない。
  外れても通常のレビューは変わらないためである。
- 完了のステップは、ロックの中でPRの変更ファイルの一覧(`getPrFiles`)も読む。
  この呼び出しはGitHub APIのページ送りなので、応答が遅いと、ロックを長く持つ。
- 認証情報が別のホストへ渡らないことは、`gh`の挙動に頼る。
- `agent_runs.error`には、`lib/claude.ts`が実行の詳細を書く。検査を通っていない出力の抜粋がDBに残る。
- パッチの`.script.yaml`の`schema`は、許可リストにない文字(`\`、`!`、`&`、`*`、`%`、タブ、`$`)と`x-windmill`を含むものを拒む。
  説明文などに、これらの文字を正当に含むscriptは、自動では直らない。
- `.script.yaml`と`wmill-lock.yaml`は、完全なYAMLとして解析しない。wmillが書く形から外れたものは、正当でも断る。
- 型だけのimportの読み取りは、正規表現で、コメントで引用符を挟んだ隠し方を見抜けない。
  型は実行時の依存ではなく、閉包の範囲にだけ効く。
- `Bun.Transpiler`が、Windmillのworkerのbunと`bun test`のbunで、同じ結果を返す前提である。
  結果が同じことを確かめるテストは無い。
- Windmillが依存を決めるimportの読み方と、`Bun.Transpiler`の読み方は、同じとは限らない。
  食い違いは、依存の変化の検出に効く。
  最後の防御は、次の2つである。
  閉包の既存のscriptのlockを、headの木とbaseの先端の木の両方と同一に限ること。
  局所importの解決を、閉包と依存の集合で一致させること。
  古いlockに新しいhashが残る形は、import集合の比較と、解決の一致で防ぐ。
- パッチの`.script.yaml`の`schema`のうち、`default`、`enum`、`format`、`resourceType`の中身は読まない。
  コードの既定値と違う`default`を、Factoryのcommitに置ける。
- `main`の署名の比較は、字句の近似である。
  正規表現と除算の見分けや、型宣言の範囲を、完全には決められない。
  決められない形は断るが、字句の読み違いで、署名の違いを見落とす入力がありうる。
- 実行時に残るimportの読み方は、Bunの版にも依存する。
  worker(1.4.0)とローカル(1.4.2)で、リポジトリの全scriptの閉包のパッケージ名が`.script.lock`の`dependencies`と一致することを、両方で確かめた。
  較正のテストは、`Bun.version`を失敗の説明に残す。
  `scanImports`がマクロを実行しないことを確かめたのは、Bun 1.4.0と1.4.2だけである。
  workerのBunを上げるときは、実行時のimportのテストを、workerのイメージで流し直す。
  検査の入口の自己検査は、型だけのimport、副作用のimport、値のimport、再export、名前空間import、リテラルの動的importを、固定の入力で確かめる。
  import属性を持つimportが、読む前に断られることも、入口で確かめる。
  想定と違う結果を見つけたときは、`scan_unavailable`で止め、補足にBunの版を載せる。
  同じworkerでは何度行っても外れるので、一時的な失敗として再試行せず、人の手に回す。
  Bunの版の許可リストは持たない。版が変わっても、自己検査を通ればよい。
- 手元で`mise run check:comment-only`を未信頼のブランチに流すと、マクロが実行されうる。
  `scripts/check-comment-only-diff.ts`が`transformSync`を使うためである。
  この部品の外にある、別の経路である。
- 上限を置いていない範囲もある。
  検査は、`listTree`が返す項目の数を数えない。`f/`以外の項目は、形の検査と表の構築の分だけ、項目の数に比例する。
  ポートの呼び出しの時間には、検査は期限を持たない。
  1つのファイルの字句の分割とimportの読み取りは、ファイルの大きさに比例し、時間の上限を持たない。
  ファイルの大きさと読む合計に上限があるので、時間は有界だが、時間そのものの上限は置いていない。
- hashの算法は、`ASSUMED_WMILL_CLI_VERSION`の版だけで確かめた。
  `dependencies/`、`__mod`のフォルダ、JSONのflowのように、このリポジトリに無い形は、写さずに人の手に回す。
  算法を固定するテストが見つけられるのは、版の変更と、リポジトリの現物との食い違いだけである。
