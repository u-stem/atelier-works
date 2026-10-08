# 実装フロー

工程3の実装フロー(`f/factory/implement`)の内部の挙動、設定値、安全策の仕組みをまとめる。実装フローのコードを変更する人が読む。運用の手順は[運用](../operations.md)に、作業項目の状態と実装フローのリースは[作業項目](work-items.md)に書く。

## 全体の流れ

実装フローは、承認済みの要件定義から対象リポジトリに実装を書き、PRを作るところまでを受け持つ。マージは常に人が行い、FactoryはマージのAPIを呼ばない。

実装フローを起動するのは承認の反映(`requirements_apply`)で、`factory_config`の`implement_enabled`が有効なときだけ承認の後に起動する。既定は無効で、無効の間、作業項目は承認済み(`approved`)で止まる。有効化の前に、sandboxのリポジトリでe2eを確かめる。

実装フローは4つのステップでできている。

| ステップ | 名前 | 役割 |
| --- | --- | --- |
| `implement_prepare` | 準備 | 前提を確かめ、ブランチとworktreeを用意する |
| `implement_generate` | 実装 | Claudeに最初の実装を書かせる |
| `implement_verify` | 検証と修正のループ | 検査し、失敗すればClaudeに直させる |
| `implement_finish` | 完了 | PRの作成、差し戻し、停止を振り分ける |

実装と検証のステップは、準備の結果が続行(`proceed`)でなければ飛ばす。完了のステップは準備の結果を受け取り、どの場合も動く。フローが例外で失敗すると、`on_error_flow`が失敗を記録する。

実装フロー1回の実行は、worker(`NUM_WORKERS`の数だけある)の1つを数時間占有する。その間、ほかのフローが使えるworkerはその分減る。実装フローの同時実行数は制限していない。

## 準備

準備のステップは、承認したときの前提がまだ成り立つかを確かめ、実装用のブランチとworktreeを用意する。

1. 作業項目がIssueの作業項目で、実装中(`implementing`)であることを確かめる。違えば何もせずに終わる。
2. 実装フローのリースを取る。取れなければ何もせずに終わる。リースの仕組みは[作業項目](work-items.md)に書く。
3. 日次予算、リポジトリの許可リスト、時間設定、Issueがopenか、承認済みの要件定義を確かめる。
4. ブランチのPR(閉じたものを含む)に、終わっていないPR修正かPRレビューがあれば止める。
5. worktreeを使っているプロセスを調べる。調べ方は[同時実行の防止](#同時実行の防止)に書く。
6. 実装ブランチのworktreeを`git gtr`で用意し、空のブランチをpushする。
7. worktreeの`.git`を検証して中身を記録する。
8. ブランチが既定のブランチから分かれた点(`git merge-base`)を、比較の基準(`base_sha`)として記録する。既定のブランチの先頭には、手順6でリモートと照合したshaを使う。

実装ブランチの名前は`factory/issue-<N>-wi-<work_item_id>`である。空のブランチを先にpushするのは、以後のpushをすべて既存の`commitAndPush`で行えるようにするためである。比較の基準は、後のステップで差分を測るときに使う。

空のブランチとしてpushするのは、既定のブランチの先頭のcommitだけである。
送り方は[pushする履歴の制限](#pushする履歴の制限)に書く。
pushの後は、新しく作ったworktreeも再利用の経路を通し、`origin/<branch>`へ`reset --hard`して`clean -fd`をする。

手順3と4の確認に通らないときの結果は次のとおり。どの場合もworktreeに触れない。

| 確かめること | 通らないときの結果 |
| --- | --- |
| 日次予算を超えていない | 人の対応待ち(`needs_human`) |
| リポジトリが許可リストに含まれる | 人の対応待ち |
| 時間設定がステップのtimeoutに収まる | 人の対応待ち |
| Issueがopenである | 取り消し(`cancelled`) |
| 作業項目の試行(attempt)に一致する承認済みの要件定義がある | 人の対応待ち |
| ブランチのPRに、終わっていないPR修正かPRレビューが無い | 人の対応待ち |

時間設定の確認は[タイムアウト](#タイムアウト)に書く。

準備のステップは、リポジトリのロックとfactory cloneのロックを待つ。リポジトリのロックの待ちは1回300秒で最大5回あり、ロックの待ちだけで約1800秒かかりうる。

Claudeに渡すIssueの題名、本文、URLは、取り込んだ時点の値(`work_items.title`、`body`、`issue_url`)を使う。工程2の要件定義の生成と同じ入力である。GitHubから取得した今のIssueは、openかどうかの判定と、取り込み時点のURLが空のときのURLにだけ使う。

## 実装

実装のステップ(`implement_generate`)は、`factory-implementation`スキルを使うheadless Claudeを、worktreeの上で1回実行する。

- Claudeに渡すツールは[Claudeに渡すツールの制限](#claudeに渡すツールの制限)のとおりである。
- 承認済みの要件定義のディレクトリは、実行ごとに一時ディレクトリへ複製して読ませる。
- Claudeを実行する前にリースを確かめる。失っていればClaudeを実行せず、検証のループが止まる結果(`lease_lost`)を返す。
- ステップにWindmillの再試行は付けない。

Claudeの1回の実行は、`implement_timeout_sec`と、期限までの残りの短い方で打ち切る。期限は準備の開始から`implement_flow_timeout_sec`後の時刻(`ImplementContext.deadline_at`)である。

プロンプトは`f/factory/lib/prompts.ts`の`implementPrompt`と`implementFixPrompt`が作る。出力の形は`IMPLEMENT_SCHEMA`で決め、`f/factory/lib/implement_support.ts`の型ガードと検証で確かめる。出力の意味の検査は実行が成功した後にだけ行う。件名が長いといった理由だけで実装全体をやり直さないためである。

Claudeは実装中に要件や設計を書き換えてはならない。要件を満たせないときは、要件の不足(`requirements_gap`)と不足の報告(`gap_report`)を返して中断する。この決まりは`factory-implementation`スキル(`.claude/skills/factory-implementation/SKILL.md`)に書く。

## 検証と修正のループ

検証のステップ(`implement_verify`)は、`f/factory/lib/implement_loop.ts`の検証のループを回す。Claudeの1回の実行を1ラウンドとし、ラウンドごとに次の順で処理する。

1. リースを確かめる。実装のステップがリースを失っていたか、今リースを持っていなければ、worktreeに触れず、記録もせずに止める。
2. worktreeの`.git`を確かめる。変わっていれば、worktreeでgitを1つも実行せずに止める。
3. Claudeの実行が失敗したか、要件の不足が報告されたら、記録して止める。
4. 差分をすべてステージし、指紋(`git write-tree`)と、比較の基準からの差分の量を取る。
5. 比較の基準からの変更パス(`git diff -z --name-status`)を調べる。
6. symlinkの変更と差分の超過を確かめ、当たれば止める。保護パスの変更は記録だけする。
7. 比較の基準から何も変わっていなければ、検査せずに「変更なし」として不合格にする。
8. 変更があれば、gitleaksを実行する。検査したツリーと手順4で取ったツリーが違えば、検査コマンドを実行せずに止める。同じなら、続けて検査コマンドを実行する。
9. ループを終えるかを判定する。
10. 修正ラウンドの前にリースと`.git`を確かめ、どちらかに通らなければ止める。

Claudeの実行ごとに`implement_rounds`へ1行記録する。リースを失って止まったラウンドは記録しない。

### 検査コマンド

検査コマンドは、そのリポジトリについて`check_commands_by_repo`に明示したものだけを実行する。保護パスを変えたラウンドと、エントリが無いリポジトリでは実行しない。gitleaksは設定に関わらず毎ラウンド実行する。

検査コマンドを実行する直前に、毎回`git clean -fdX`で無視ファイル(`node_modules/`やビルドの成果物)を消す。そのため、検査コマンドの先頭で依存関係をインストールする必要がある。worker imageにmiseは無いので、検査コマンドはworkerで直接動くものに限られる。

各検査コマンドは`implement_check_timeout_sec`で打ち切り、期限では打ち切らない。検査に失敗したら、その出力をDATAとして修正のプロンプトに渡し、Claudeに直させる。

### ループの終わり方

ループは次の表の上から順に判定して終える。どれにも当たらなければ、次の修正ラウンドに進む。

| 終了の理由 | 条件 | `implement_rounds.outcome` |
| --- | --- | --- |
| `requirements_gap` | Claudeが要件の不足を返した | `requirements_gap` |
| `checks_skipped` | 検査コマンドを実行しなかった | `checks_skipped` |
| `checks_passed` | 検査に通った | `done` |
| `max_rounds` | ラウンドが`implement_max_rounds`に達した | `check_failed` |
| `daily_budget` | 日次予算を超えた | `check_failed` |
| `deadline` | 期限までの残りが修正ラウンドの最悪の所要時間に足りない | `check_failed` |
| `stalled` | 差分か検査の出力が前のラウンドと同じ | `stalled` |

検査コマンドを動かさなかったラウンドは、GitHub側のCIに検査を任せる。停滞(`stalled`)で止めるのは、同じ状態でもう1回直させても予算を使うだけになるからである。期限の判定は、ラウンドの上限や日次予算と同じく、修正ラウンドの前のリースの確認より先に行う。

ループは、検査の前にも次の理由で止まる。

- symlinkの変更(`symlink`)
- 差分の超過(`diff_too_large`)
- `.git`の書き換え(`git_pointer_modified`)
- 変更の判定とgitleaksの検査の間のworktreeの変化(`worktree_changed`)
- Claudeの実行の失敗(`claude_error`)
- リースの喪失(`lease_lost`)

`worktree_changed`で止めるのは、変更の判定とgitleaksの検査の両方を経たツリーだけを、検証済みとして記録するためである。
理由は`worktree changed before the secret scan in round <N>`になる。

### 期限と修正ラウンド

検査に失敗したラウンドの後は、期限までの残りが修正ラウンドの最悪の所要時間(`fixRoundWorstCaseSec`)以上のときだけ、次の修正ラウンドを始める。足りなければ期限(`deadline`)でループを終える。最悪の所要時間は次の式で求める。

```text
implement_timeout_sec + 600 + 検査コマンド数 × (implement_check_timeout_sec + 15)
```

既定値で検査コマンドが4件なら7860秒である。この条件で始めた修正ラウンドは、Claude、gitleaks、検査コマンドがそれぞれのタイムアウトまでかかっても期限までに終わる。検査コマンドが多いほど修正ラウンドを始められる時間が短くなるので、1リポジトリの検査コマンドは4件までを目安にする。

Claudeが不正な出力を返したときは、1回の実行につき1回だけ再試行する。この再試行だけは期限までの残りで打ち切る。そのため、再試行したラウンドではgitleaksと検査コマンドが期限の後に動くことがある。再試行が打ち切られたときは、変更を検査していないのでpushしない。変更はworktreeに残り、作業項目は人の対応待ちになる。

最初の実装のClaudeが期限で打ち切られたか、期限の後で起動しなかったときも、差分は検査を経ていない。そのためpushせずに人の対応待ちにする。検査に通ったラウンドは、期限の後でもPRを作る。

## 完了

完了のステップ(`implement_finish`)は、ループの結果によって作業項目の行き先を振り分ける。状態の遷移の一覧は[作業項目](work-items.md)に書く。

| ループの結果 | 処理 |
| --- | --- |
| 準備で何もせずに終わった、リースを失った | 何もしない |
| Issueがcloseされていた | 取り消し(`cancelled`)にする |
| 検査に通った、検査を実行しなかった | コミットしてPRを作成または更新し、PR作成済み(`pr_open`)にする |
| 要件の不足 | 要件定義を作り直す工程2へ差し戻す |
| ラウンドの上限、日次予算、期限、停滞、差分の超過 | 途中の変更を残して、人の対応待ちにする |
| symlinkの変更、Claudeの実行の失敗、`.git`の書き換え、判定と検査の間のworktreeの変化、準備での停止 | 何もpushせずに、人の対応待ちにする |

完了のステップは、作業項目を読んだ直後にリースを確かめる。外への副作用の直前にも確かめ直す。外への副作用は、commitとpush、worktreeとリモートのブランチの削除、PRの作成と更新、`pr_url`の記録、ラベルの付与である。

途中経過と最終のcommitの前には、次の確認をすべて通す。
1つでも通らなければ、commitとpushのどちらもせずに人の対応待ちにする。

| 確認 | 詳細 |
| --- | --- |
| 生き残りのプロセスがいない | [pushの前の生き残りのプロセスの確認](#pushの前の生き残りのプロセスの確認) |
| HEADとブランチが記録どおり | [pushする履歴の制限](#pushする履歴の制限) |
| ステージした内容が検査したツリーと同じ | [検証したツリーだけのコミット](#検証したツリーだけのコミット) |

### PRの作成

検査に通ったラウンドのツリーをコミットしてpushし、PRを作る。既にPRがあれば本文を更新する。

- PRには`factory:review`ラベル(`review_label`)を付ける。`poll_prs`がこのラベルを見て自動レビューを起動する。
- PR本文の`Closes #N`で元のIssueに紐づける。
- Discordに`pr_opened`を通知する。保護パスの変更は、PR本文の「確認して欲しい点」と`pr_opened`の通知に載せる。
- 検査コマンドを動かさなかったときは、PR本文の「動作確認結果」に「検査未実施」と理由を書く。

コミットする新しい変更が無くても、ブランチに比較の基準より先のコミット(途中経過のコミットなど)があれば、それを使ってPRを作成または更新する。ブランチに比較の基準より先のものが何も無いときだけ、「実装が変更を生みませんでした」として人の対応待ちにする。

Issueがopenかを確かめるために取得したIssueの題名か本文が、取り込み時点と違うことがある。そのときはPR本文の「確認して欲しい点」にその旨を1行書く。通知はしない。

Consoleの**パイプライン**タブは、作業項目のブランチとPRを列に表示する。

### 途中の変更の扱い

ラウンドの上限、日次予算、期限、停滞、差分の超過で止まったときは、途中の変更を残す。PRが無ければ、gitleaksをもう一度実行し、通れば途中の変更をコミットして実装ブランチにpushする。gitleaksに通らないときと、検査自体が失敗したときはpushしない。

次のときも、途中経過と最終のどちらもpushしない。

- 前のステップのClaudeや検査コマンドが、worktreeに残っている。理由に残っているプロセスが載る。
- 検査コマンドがローカルでcommitかブランチの切り替えをした。理由には、worktreeのHEADが記録したブランチの先頭と異なる旨が載る。
- commitしたツリーが、検査したツリーと違う。
- 途中経過では秘密情報の検査の後に、最終のcommitでは検証の後に、worktreeが変わった。

PRがあるときは、未検証の変更がPRに入るのでpushしない。理由には「PRがあるため途中の変更はpushせずworktreeに残しました」と載せる。

symlinkの変更、Claudeの実行の失敗、`.git`の書き換え、判定と検査の間のworktreeの変化で止まったときは、検査を終えていない変更なのでpushせずworktreeに残す。worktreeに残った途中の変更は、次の実行の準備で捨てる。

途中経過のコミットと、再実行で実装が完了したときのコミットは別のコミットになる。1つのコミットにまとめるのは、途中で止まらなかった場合だけである。

### 要件の不足の差し戻し

Claudeが要件の不足を返すと、完了のステップは次の順に処理する。

1. worktreeを削除する。
2. PRが無ければ、実装ブランチをリモートとローカルから削除する。PRのheadのブランチを消すとPRが閉じるので、PRの検索に失敗したときも削除しない。
3. 不足の報告を却下理由(feedback)として、工程2を試行(attempt)を1つ増やして起動し直す。

試行の回数が`max_attempts`を超えるときは、差し戻さずに人の対応待ちにする。再承認の後は、同じブランチ名で実装をやり直し、既にPRがあればそのPRを更新する。

### 差分の大きさの測り方

差分の上限(`implement_max_changed_files`、`implement_max_diff_lines`)は、既定のブランチとの分岐点からの累積で測る。既存のPRを更新するときも同じなので、既にPRが大きいと上限に達しうる。

## 設定値

実装フローは`f/factory/factory_config`の次の値を読む。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `implement_enabled` | `false` | 承認の後に実装フローを起動するか |
| `implement_max_rounds` | `5` | Claudeを実行するラウンドの上限 |
| `implement_max_turns` | `80` | Claude 1回の実行のターン数の上限 |
| `implement_max_budget_usd_per_run` | `10` | Claude 1回の実行の費用の上限(USD) |
| `implement_timeout_sec` | `3600` | Claude 1回の実行を打ち切る秒数 |
| `implement_check_timeout_sec` | `900` | 検査コマンド1件を打ち切る秒数 |
| `implement_flow_timeout_sec` | `14400` | 準備の開始から期限までの秒数 |
| `implement_max_changed_files` | `60` | 分岐点から変えてよいファイル数の上限 |
| `implement_max_diff_lines` | `3000` | 分岐点からの追加と削除の行数の上限 |
| `check_commands_by_repo` | `{}` | リポジトリごとの検査コマンド |
| `daily_budget_usd` | `50` | 全フローで共有する1日の費用の上限(USD) |
| `max_attempts` | `3` | 要件定義の試行回数の上限 |

`check_commands_by_repo`は、`{"<owner>/<repo>": ["bun install --frozen-lockfile", "bun test"]}`の形で書く。workerで直接動く例は`bunx --bun tsc --noEmit`や`bunx --bun biome check .`である。実装フローは`allowed_check_commands`を使わない。

1つのIssueにかかる費用の上限は、`implement_max_rounds × implement_max_budget_usd_per_run`が目安である。Claudeの不正な出力への再試行は、その実行の費用の上限をもう1回使うので、最悪でその2倍になる。

## タイムアウト

`flow.yaml`の各ステップにはWindmillのtimeoutを付ける。アプリ側の期限と各timeoutが効かなかったときに、最後に打ち切るためである。

| ステップ | Windmillのtimeout | 定数 | 理由 |
| --- | --- | --- | --- |
| 準備 | 3600秒 | なし | ロックの待ちだけで約1800秒かかりうるので、完了より長くする |
| 実装 | 21600秒 | `IMPLEMENT_STEP_TIMEOUT_SEC` | Claude 1回と余裕が収まる |
| 検証と修正のループ | 21600秒 | `IMPLEMENT_STEP_TIMEOUT_SEC` | 期限と、期限の直前に始まった1ラウンド分の検査が収まる |
| 完了 | 1800秒 | なし | commitとpushの前にリポジトリのロックを待つ |

`IMPLEMENT_STEP_TIMEOUT_SEC`は`f/factory/lib/implement_support.ts`にある。上限を上げるときは、`flow.yaml`とこの定数を同じ変更で上げる。`tests/scripts/implement_flow.test.ts`が両者の一致を確かめる。

アプリ側では、次の単位で打ち切る。

| 対象 | 打ち切り |
| --- | --- |
| Claude 1回の実行 | `implement_timeout_sec`と期限までの残りの短い方 |
| 検査コマンド1件 | `implement_check_timeout_sec`(期限では打ち切らない) |
| gitleaks | 300秒 |
| フロー全体 | 準備の開始から`implement_flow_timeout_sec` |

期限は、`retry_work_item`で再実行するたびに最初から数え直す。

### 時間設定の確認

準備のステップは、時間設定が実装と検証のステップのtimeoutの範囲内かを確かめる(`implementTimeoutMisfit`)。次のどちらかが21600秒を超えると、worktreeを使わないまま作業項目を人の対応待ちにする。

```text
implement_flow_timeout_sec + 600 + 検査コマンド数 × (implement_check_timeout_sec + 15)
implement_timeout_sec + 600
```

600秒は、gitleaksの最大300秒と、gitとDBの操作の余裕300秒の和である。15秒は、検査コマンド1件が打ち切りの後に停止と出力待ちで上乗せしうる時間である。既定値なら検査コマンドは7件まで収まる。

確かめるのは準備のステップだけである。そのため、実装フローの実行中は時間設定を変えない。

### Windmillのtimeoutで打ち切られたとき

Windmillのtimeoutはジョブのプロセスにしかシグナルを送らない。そのため、打ち切られたステップが起動したClaudeや検査コマンドは残り、作業項目は失敗(`failed`)になる。再実行したときの扱いは[同時実行の防止](#同時実行の防止)に書く。

Windmillのtimeoutで打ち切られたステップのClaudeは、`--max-turns`と`--max-budget-usd`の上限に達するまで動き続けうる(#53)。
アプリ側のタイマーが、ジョブのbunのプロセスと一緒に消えるためである。
その費用は`agent_runs`に記録されず、日次予算(`daily_budget_usd`)の集計から漏れる。
次の実行の準備のステップが残ったプロセスを止めるまでの間の、既知の制約である。

ステップのtimeoutは、インスタンスの上限を超えられない。セルフホストでは環境変数`TIMEOUT`が上限で、未設定なら7日である。インスタンスの`job_default_timeout`を設定するときは、21600秒以上にする。実装と検証のステップ(とPR修正の検証のステップ)を先に打ち切らないためである。

## 再実行と中断

実装フローの再実行には`retry_work_item`を使う。
ジョブが失敗した作業項目はConsoleの**失敗**タブから実行し、それ以外はWindmillで`f/factory/retry_work_item`を作業項目のIDで実行する。
人の対応待ちの作業項目は、**失敗**タブに出ないためである。
Windmillでフローを直接動かすと、リースの確認で何もせずに終わる。

| 操作 | 挙動 |
| --- | --- |
| Windmillのrerun | 新しいジョブIDで最初から走り、準備の最初のリースの確認で何もせずに終わる |
| 途中のステップからのrestart | 新しいジョブIDで走り、再開したステップの最初のリースの確認で何もせずに終わる |
| 同じ作業項目での二重の起動 | 後の実行は準備で何もせずに終わる |
| Windmillでの取り消し | Claudeや検査コマンドは止まらずに残る |

二重の起動は、起動の応答が失敗したのに実際にはフローが動いていた場合などに起きる。rerunとrestartは、元の実行で進行中のClaudeの実行や検査を中断しない。

### 実行中のリースの喪失

実装フローは、実行中にリースを失うことがある。例えば、Issueのcloseで実行を取り消すときに`cancelJob`が失敗した場合である。実装フローは次のリースの確認で止まり、commit、push、PRの作成をしない。

- 実装のステップの、Claudeを実行する前
- 検証のループの、各ラウンドの冒頭と各修正ラウンドの前
- 完了のステップの、最初と外への副作用の直前

進行中のClaudeの実行や検査は中断しない。worktreeに残った途中の変更は、次の実行の準備で捨てる。

### 新しいバージョンの反映

`self_update`は、実行中の実装フローを待たずに新しいステップを反映する。そのため、準備と完了の間で、別のバージョンのステップが動く場合もある。実装中の作業項目がある間は、mainへのマージとデプロイを避ける。

### 残ったプロセスの掃除

`cleanup_workspaces`は、閾値を超えて動いているheadless Claude(`claude -p`)だけを孤児として止める。閾値は、`claude_timeout_sec`と`implement_timeout_sec`の長い方に5分を足した時間である。検査コマンドの生き残りは、この掃除の対象にならない。

実行中に、同じ実行の検査コマンドなどが残したプロセスがロックを持ち続けて失敗したときは、`retry_work_item`で再実行するだけでよい。
準備のステップがそのプロセスを止めてから続ける。

## 安全策の実装

実装フローはPR修正と同じくClaudeに書き込みのツールを渡す。PR修正と共通の仕組みは[PRワークフロー](pr-workflow.md)にも書く。

### Claudeに渡すツールの制限

Claudeに渡すツールは`Read,Glob,Grep,Edit,Write`だけで、`Bash`は渡さない。起動のオプションは`--permission-mode dontAsk`、`--allowedTools Edit Write`、`--restricted`である。検査はClaudeではなくフローのステップが実行する。

`--allowedTools Edit Write`と`dontAsk`は、PR修正で書き込みができると確かめた組み合わせである。作業ディレクトリはworktreeにし、要件定義の複製は`--add-dir`で渡す。

### 取り込み時点のIssueの使用

Claudeに渡すIssueの題名と本文は、取り込み時点のもの(`work_items.title`、`body`)である。承認の後にIssueを書き換えて、プロンプトに指示を差し込むことはできない。

GitHubから取得した今のIssueは、次の3つにだけ使う。

- openかどうかの判定
- 取り込み時点のURL(`work_items.issue_url`)が空のときのURL
- 取り込み時点と違う場合の、PR本文への注記

### 承認済み要件定義の複製

Claudeには、実行ごとに一時ディレクトリへ複製した要件定義のディレクトリを`--add-dir`で渡し、実行の後に削除する(`withReadOnlyDocDirCopy`)。元のファイルは渡さないので、Consoleが表示する承認済みの文書をClaudeは書き換えられない。

複製には、通常のファイルとディレクトリだけを写す。symlinkは指す先に関わらず写さない。リンク先を実体として写すと、`/proc/self/environ`のような文書の外のファイルが複製に入りうるためである。

FIFOなどの通常のファイル以外も写さない。そのため、複製の中に、Claudeの`Write`が外へたどれるリンクは残らない。

### 同時実行の防止

同じ作業項目の実装フローは、同時に1つしか作業しない。作業項目のリースに加えて、前の実行のプロセスが生きていないことも条件にする。

Windmillでジョブを取り消しても、新しいセッションで起動したClaudeや検査コマンドは止まらない。そのため、Claudeと、PR修正と実装の検査コマンドはロック付きで起動する。

- ロックは、worktreeの隣のロックファイル(`.<worktreeのディレクトリ名>.process.lock`)を`flock`で持つ。
- 持ち主を表す環境変数`FACTORY_LOCK_OWNER`を付ける。値は、実装フローとPR修正の区別、作業項目、ジョブIDである。
- ロックファイルを表す環境変数`FACTORY_LOCK_PATH`を付ける。

ロックファイルは、使っている間は消さない。

#### 準備での走査

準備のステップは、worktreeを使う前にこのロックを確かめる。既存のworktreeならブランチの公開、検証、`reset --hard`と`clean`より前、新しく作ったときは作った直後である。ロックの取得の成否に関わらず、`/proc`を走査する。

走査で探すのは次の2種類のプロセスである。

- 保持者: ロックファイルと同じdevとinoのfdにflockを持つプロセス
- このロックファイルのタグ(`FACTORY_LOCK_PATH`)を持つプロセス

#### 止めてよいプロセス

実装フローの準備が止めるのは、持ち主のタグが「同じ作業項目の実装フローで、この実行とは別のジョブ」のプロセスだけである。止めるときはSIGTERMを送り、10秒後にSIGKILLを送る。対象が自身のプロセスグループのリーダーなら、そのグループにも送る。

これらのプロセスは、次の理由で、終わった実行の生き残りと言える。

- この実行は作業項目のリースを持つので、同じ作業項目の別のジョブは今正当に動いていない。
- 止める直前に、リースを持ち続けていることを確かめ直す。ブランチのPR(閉じたものを含む)に、終わっていないPR修正とPRレビューが無いことも確かめ直す。
- シグナルを送る直前に、走査したときと同じプロセス(起動時刻が一致する)であることを確かめる。

止めた後に走査し直し、止めてよい残りがあれば、合わせて3回まで止め直す。止まる前に書き込まれたものは捨てる。既存のworktreeは再利用の経路で`origin/<branch>`へ`reset --hard`し、`clean -fd`をする。新しく作ったworktreeは、`.git`を検証してから、作った時点のコミットへ同じく戻す。

どちらも`reset --hard`の前に、HEADが`refs/heads/<branch>`を指すことを`git symbolic-ref -q HEAD`で確かめる。
`reset --hard`はHEADが指すブランチを動かすので、生き残りが別のブランチをcheckoutしていると、そのブランチを動かしてしまうためである。

- 指していなければ(別のブランチかdetached)、`git checkout -f --no-track -B <branch> <戻す先>`で対象のブランチへ移す。この切り替えは、それまでHEADが指していたブランチを動かさない。
- 次のときは、resetせずに失敗する。HEADを読めない、切り替えに失敗した、切り替えた後もHEADが指していない。
- git 2.43以降では、対象のブランチがほかのworktreeでcheckoutされていると切り替えに失敗する。workerのイメージのgitは、Debian trixieの2.47である。

#### 止めないプロセス

保持者やタグを持つ残りに次のプロセスがいれば、何も止めずに人の対応待ちにする。

- タグの無いプロセス
- PR修正のプロセス
- ほかの作業項目のプロセス

理由には、保持者のpid、経過秒、持ち主、コマンドを載せる。PR修正の準備の扱いは[PRワークフロー](pr-workflow.md)に書く。

fdを閉じる子孫は珍しくない。例えばPythonの`subprocess`は既定で`close_fds`を有効にする。それらは環境変数のタグで見つけ、ロックが空いていても、止めてよいものは止め、それ以外があればworktreeに触れない。PR修正と`cleanup_workspaces`も同じように扱う。

#### 調べられないプロセス

workerには`CAP_SYS_PTRACE`が無い。そのため、uidを変えたプロセスやダンプ不可にしたプロセスの環境変数とfdは読めない。

生きているのに環境変数とfdを読めないプロセスは、タグもロックとの関係も分からない。止めずに保持者と同じく扱い、worktreeに触れない。理由には「could not be inspected」と載せる。workerのジョブはすべてrootで動くので、通常は起きない。

この仕組みが見逃すのは次のものである。

- fdを閉じ、かつ環境変数も消すプロセス
- rootで動く検査コマンドがロックファイル自体を消した場合
- ロックの下で起動しないgit、gitleaks、ghの生き残り
- 要件定義を書くClaude(要件定義のディレクトリへの書き込みは排他しない)

#### 実行中にロックが取れないとき

実行中にロックが取れなかったときは、フローを失敗させる。同じ実行の検査コマンドが常駐のプロセスを残した場合に起きる。

検査コマンドは常駐のデーモン(バックグラウンドで動き続けるサーバーなど)を残してはならない。ロックのfdを持ったまま残ると、以降のラウンドがロックを取れずに失敗する。fdを閉じて残ったものも、次の準備やPR修正を止める。

### ロックファイルの掃除

ロックファイルは確かめるたびにworktreeの隣に作られ、worktreeを消しても残る。`cleanup_workspaces`は、ロックが持たれているか、タグを持つプロセスが残っているworktreeを消さない。
そのworktreeごとに、Consoleの**通知**タブへ`cleanup_worktree_busy`のnoticeを残す。
noticeは1回の掃除でパスごとに1件で、Discordには通知しない。

`cleanup_workspaces`がロックファイルを探す場所は次の2つの直下である。

- 掃除したリポジトリのメインのクローンの親
- `git worktree list`に載る各worktreeの親(realpath)

消す対象は、`.<名前>.process.lock`の形の空の通常ファイルで、隣に同じ名前のworktreeが無いものである。symlinkは対象にしない。消すのは次をすべて満たすときだけである。

- `/proc`の走査で、保持者、タグを持つプロセス、調べられないプロセスがいない。
- ロックを待たずに取れる。
- ロックを持ったまま確かめ直して、パスが今もロックしたファイル(同じdevとino)を指し、worktreeが無い。

消すのはロックを持ったまま行い、ロックは消し終わってから放す。削除のシェルは5秒で打ち切る。別の実行の走査は、削除のシェル(とそれが起動したflock、stat、rm)を一瞬の保持者として扱い、走査し直す。

確かめは、消される前の古いファイルを見て空いていると判断することがある。それでも問題が起きないのは次の理由による。

- ロック付きの起動は、そのたびにパスを開き直す。
- 残ったプロセスは、タグ(パス)で見つかる。
- worktreeを作る実行は、作った後にロックを確かめてからロック付きで起動する。

確かめ直した時点でworktreeが無ければ、その実行の起動は消した後の新しいファイルを開く。古いファイルのロックを持つプロセスが残ったまま、別の実行が新しいファイルでロックを取る状態にはならない。

一覧から消えたworktreeの親(gtrのworktreeの置き場所など)は分からない。そこに残ったロックファイルは、同じ親に別のworktreeが一覧に載るまで残る。

### 検査コマンドの実行範囲

検査コマンドは、Claudeが書いたテストやソースを、workerのコンテナ内でrootとして、サンドボックスなしで実行する。そのため実装フローは、そのリポジトリについて`check_commands_by_repo`に明示したコマンドだけを実行する。`allowed_check_commands`には落とさない。

検査コマンドを実行するたびに、noticeの`unsandboxed_check_commands`を記録する。workerのサンドボックスができるまでは、Issueを信頼できる人だけが起票するリポジトリにだけ、このエントリを設定する。

lockfileは保護パスなので、Claudeが書き換えたラウンドでは検査コマンドを実行しない。

### 対象リポジトリのCI

実装ブランチのpushとPRの作成で、対象リポジトリ自身の`push`と`pull_request`のCIが動く。CIは、人のレビューより前に、Claudeが書いたコードをそのリポジトリのsecretsを使える状態で実行しうる。対象リポジトリのCIの権限とsecretsの範囲は、この前提で設定する。

### 保護パスの記録

保護パスの変更は、止めずにPR本文とDiscordに列挙する。保護パスを変えたラウンドでは検査コマンドを実行せず、検査はGitHub側のCIに任せる。Claudeが書き換えた`mise.toml`や`package.json`のscriptsをworkerで実行すると、Issue本文を経由してコードを実行させる経路になるためである。

列挙するのは次の3種類である。

- 保護パスに当たる変更
- 新しく追加した`*.sh`
- `package.json`の`scripts`の変更

保護パスは`f/factory/lib/protected_paths.ts`の3つの定数で決める。

- ディレクトリ: `IMPLEMENT_PROTECTED_PATH_PREFIXES`
- 個別のファイル: `IMPLEMENT_PROTECTED_EXACT_PATHS`。PR修正の一覧と同じで、`console/index.html`である。
- ファイル名: `IMPLEMENT_PROTECTED_BASENAME_PATTERNS`

ディレクトリとファイル名は、PR修正の一覧に次を加えたものである。

| 種類 | 加えるもの |
| --- | --- |
| ディレクトリ | `.github/`全体(PR修正の`.github/workflows/`を広げる)、`infra/`、`.husky/`、`.githooks/`、`.yarn/`、`.devcontainer/` |
| 環境とgitleaks | `.env`と`.env.*`、`.gitleaksignore`、`.gitleaks.toml` |
| ランタイムのバージョン | `.tool-versions`、`.node-version`などの`.*-version`、`.nvmrc`、`rust-toolchain` |
| パッケージマネージャー | `.yarnrc`、`.pnpmfile.cjs`、JavaScriptのlockfile、すべての`package.json` |
| ツールの設定 | `*.config.[cm][jt]s`、`.eslintrc`、`.babelrc`、`.prettierrc` |
| タスクランナーなど | `Makefile`、`Justfile`、`Taskfile.yml`、`turbo.json`、`nx.json`、`deno.json`、`CODEOWNERS`、`.pre-commit-config.yaml` |
| JavaScript以外のlockfileとmanifest | `uv.lock`、`poetry.lock`、`Pipfile`、`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements*.txt`、`Cargo.toml`、`Cargo.lock`、`go.mod`、`go.sum`、`Gemfile`、`composer.json`、`composer.lock` |

PR修正の一覧そのものの中身は、[PRワークフロー](pr-workflow.md)の[禁止パスによる停止](pr-workflow.md#禁止パスによる停止)にある。markdownlint-cli2とtextlintの設定は、PR修正の一覧に含まれる。

`infra/`を加えるのは、workerのイメージとcomposeの定義の変更が、次にホストで`mise run up`するまで反映されないからである。レビューする人がその変更を知る必要がある。

保護パスの一覧は、Factory自身に限らず、実装フローが扱うすべてのリポジトリに効く。
ほかのリポジトリに`infra/`、`console/public/`、`console/index.html`などがあれば、それに触れたラウンドは検査コマンドを実行しない。
そのときは、GitHub側のCIの結果を見る。

判定は、比較の基準からの差分で行う。前のラウンドや前回の実行でコミット済みの変更も、毎回判定する。renameは元のパスの削除と新しいパスの追加として扱うので、保護パスから外への移動も捕まえる。

変更パスは`git diff -z --name-status`で取得する。引用符付きのパス(非ASCII文字や制御文字を含むもの)でも、保護パスの判定を素通りしない。

### symlinkの変更の停止

比較の基準からのステージ済みの差分(`git diff --cached --raw -z`)に、変更前か変更後のモードが`120000`のエントリがあれば、人の対応待ちにする。新規作成、変更、削除、typechange、renameのどれも対象である。ファイルシステムではなくgitのモードで判定するので、worktreeに残っていないsymlinkも捕まえる。

### worktreeの.gitの検証

Claudeは`Edit`と`Write`で、worktree直下の`.git`(gitdirへの参照)も書き換えられる。参照先を別のディレクトリに向けると、そこに置いた`config`のfilterなどを、次の`git add`がrootで実行する。

準備のステップは、worktreeを作った直後に`.git`を1回だけ読み、その中身で検証して記録する(`verifyWorktreeGitdir`)。検証は次の3点である。

- `.git`が、gitの書く正規の形`gitdir: <絶対パス>`そのものである。空白の数やタブが違うと、gitは別のディレクトリを読むため拒否する。
- `realpath`で解決した先が、`<main clone>/.git/worktrees/`の直下にある。
- その`gitdir`の戻り参照が、worktreeを指している。

以降は、worktreeでgitを実行する前に、`.git`が記録と一致する通常のファイルであることを確かめる。確かめるのは、各ラウンドの冒頭、途中経過のpushの前、最終のコミットの前である。違えば何も実行せずに人の対応待ちにし、途中の変更もpushしない。

次の2つの時点でも確かめる。Claudeの不正な出力への再試行の前と、検査コマンドの後で修正ラウンドのClaudeを起動する前である。違えば、再試行と起動をしない。確かめ自体が失敗したときも再試行しない。最初の試行の記録(費用)はそのまま残す。

既存のworktreeを再利用するときは、中でgitを実行する前に同じ検証をする。PR修正も同じである。通らなければ、worktreeの中でgitを使わずにディレクトリを削除する。続けて`git worktree prune`を実行し、worktreeを作り直す。削除の対象は、`git worktree list`が報告したパスのうち、リポジトリの作業ディレクトリの配下にあるものだけである。

worktreeを消すとき(要件定義への差し戻しや掃除)も、検証に通らなければ`git worktree remove`を使わずに同じ方法で消す。

### 差分の大きさの上限

差分の上限は、実装フロー専用の`implement_max_changed_files`と`implement_max_diff_lines`で決める。どちらかを超えたら人の対応待ちにする。

PR修正の、baseブランチが保護ブランチなら止める確認は、実装フローには適用しない。実装フローは保護されたbaseに直接pushせず、PRを作るだけだからである。

### gitleaksによる秘密情報の検査

gitleaksは、検査コマンドの設定に関わらず、毎ラウンド実行する固定の検査である。
毎ラウンド、差分をすべてステージし、そのツリーを`git write-tree`で記録する。
比較の基準からそのツリーまでの差分全体を次のコマンドで取り出し、追加された行を`gitleaks stdin --redact`に標準入力で渡す。

```bash
git diff --text --no-ext-diff --no-textconv -U0 <merge-base> <tree>
```

索引ではなく記録したツリーと比べるので、検査した内容とそのツリーはちょうど一致する。
検査したツリーと、そのラウンドで変更を判定したツリー(指紋)が違えば、検査コマンドを実行せずにそのラウンドで止める(`worktree_changed`)。

gitleaksは私有の一時ディレクトリで実行する。対象リポジトリの内容で検出を無効にさせないため、次のように起動する。

- 既定のルールだけを`--config`で強制する。
- `--gitleaks-ignore-path`をその一時ディレクトリに向ける。
- `--ignore-gitleaks-allow`を付ける。

このため、次のどれでも検出を無効にできない。

- `.gitleaks.toml`(壊れたものを含む)と`.gitleaksignore`
- 行の中の`gitleaks:allow`のコメント
- `.gitattributes`の`binary`と`-diff`の指定、textconv

前のラウンドや前回の実行でコミット済みの変更も、毎ラウンド検査する。検出結果は、ルール名とファイル名だけをClaudeへの修正の依頼とDBに渡し、一致した文字列は渡さない。

次の場合は検査の失敗として扱う。

- 検査する差分(上限32MiB)かレポート(上限8MiB)が出力の上限を超えた
- どちらかの出力の読み取りを打ち切った([子プロセスの停止](#子プロセスの停止)を参照)
- 終了コードが0と1以外だった

### 検証したツリーだけのコミット

検査に通ったラウンドと、検査コマンドを動かさなかったラウンドでは、ステージ済みのツリー(`git write-tree`)を記録する。
完了のステップは、コミットする直前にもう一度ステージして、記録と一致することを確かめる。
検査コマンドが追跡対象のファイルを書き換えた場合など、検証の後にworktreeが変わっていれば、pushせずに人の対応待ちにする。

`commitAndPush`はステージし直すので、commitの直前にも索引の`git write-tree`を同じツリーと比べる(`inspectStaged`)。
比べる先は、途中経過ならgitleaksが検査したツリー、最終のcommitならループで検証したツリーである。
違えば、commitとpushのどちらもしない。
理由は、途中経過では`worktree changed after the secret scan`、最終のcommitでは検証の後にworktreeが変わった旨になる。

commitの後、pushの前には、作ったcommitのツリーが比べたツリーと同じことを確かめる。
違えばcommitを取り消し、`committed tree differs from the inspected tree`を理由にする。

### pushする履歴の制限

途中経過と最終のcommitでは、`git add -A`の前に次を確かめる(`commitAndPush`の`requireLocalHeadAtExpected`と`expectedBranch`)。

- ローカルのHEADが、準備のステップの記録したブランチの先頭(`expected_head_sha`)である。
- HEADが実装ブランチにある。

ループはcommitしないので、HEADが動いていれば、検査コマンドがcommitかブランチの切り替えをしている。
そのcommitは差分の検査に現れない(後のcommitで消した秘密情報など)のに、pushすると履歴ごと送られる。
そのため、pushせずに人の対応待ちにする。

pushは`HEAD`ではなく、作ったcommitのshaを送る。
そのため、送る履歴は記録した先頭と、新しい1つのcommitだけになる。

準備のステップの空のブランチのpush(`pushNewBranch`)も、ローカルのブランチを送らない。
リモートにブランチが無いときは、ローカルのブランチを`update-ref --no-deref`で既定のブランチの先頭へ向け直す。
送るのは、リモートに問い合わせた既定のブランチの先頭のshaである。
リモートのブランチだけが消えた後は、検査コマンドのcommitがローカルのブランチに残りうるためである。
例えば、要件の不足の差し戻しでローカルのブランチの削除だけに失敗したときと、人がGitHubでブランチを消したときである。
削除して作り直さずに向け直すのは、checkout中のブランチも1回の操作で動かせ、worktreeを消さずに済むためである。

向け直すと、ローカルにだけあったcommitはブランチから外れる。
gitのreflogには残る。
人がGitHubで消したブランチは、消す前の状態には戻さず、既定のブランチの先頭から作り直す。

既定のブランチの先頭は、ローカルの`origin/HEAD`と追跡refを信じず、`git ls-remote --symref`の1回でリモートに問い合わせる。
問い合わせるのは、リモートの`HEAD`、実装ブランチ、既定のブランチである。
検査コマンドはメインのcloneの`.git`を書き換えられ、`--prune`なしのfetchは書き換えられた`origin/HEAD`を直さないためである。
次のどれかに当たれば例外を投げ、ローカルのブランチを動かさず、何もpushしない。

- リモートの`HEAD`が、ローカルの`origin/HEAD`から読んだ既定のブランチでない。
- リモートに既定のブランチが無い。
- ローカルの追跡ref(`refs/remotes/origin/<base>`)が、リモートの既定のブランチの先頭と違う。

この照合は、リモートに実装ブランチがあるときもする。
準備のステップは、照合したリモートの既定のブランチの先頭のshaから、比較の基準(`git merge-base -- <sha> HEAD`)を求めるためである。
短い名前の`origin/<base>`は引き直さない。
検査コマンドが作る`refs/heads/origin/<base>`や`refs/tags/origin/<base>`が、追跡refより先に解決されうるためである。
照合で、そのshaがローカルにあり、追跡refと同じことも確かめる。

向け直しの後でpushに失敗したときは、ローカルのブランチが既定のブランチの先頭を指し、worktreeには古いファイルが残る。
リモートにはまだブランチが無いので、次の実行がもう一度向け直してpushし、再利用の経路でworktreeを`origin/<branch>`へ戻す。

### pushの前の生き残りのプロセスの確認

完了のステップは、途中経過のpushと最終のcommitの前に、次のプロセスがいないことを確かめる。何も止めない。

- worktreeのロックを持つプロセス
- このロックファイルのタグを持つプロセス

前のステップのClaudeや検査コマンドが残っていれば、検査とcommitの間にworktreeを書き換えうる。
そのため、pushせずに人の対応待ちにし、理由に残っているプロセスを載せる。

### コミットメッセージのIssue参照の無効化

Claudeが書くコミットメッセージの件名と本文では、Issueへの参照を次のように書き換える。既定のブランチへのマージで任意のIssueを閉じたり、無関係なIssueにリンクしたりしないためである。

| 元の表記 | 書き換え後 |
| --- | --- |
| `#12` | `No.12` |
| `owner/repo#12` | `owner/repo No.12` |
| `GH-12` | `GH No.12` |
| IssueやPRのURL | ホストを`github[.]com`にする |

元のIssueとの紐づけは、Factoryが書くPR本文の`Closes #N`だけで行う。件名は72コードポイントを超えると拒否する。

### 子プロセスの停止

git、gh、Claude、検査コマンドは、新しいプロセスグループで起動する。グループで生き残ったプロセス(バックグラウンドに残した子)は、SIGTERMで止め、続けてSIGKILLで止める。止めるのはタイムアウトのときだけでなく、正常に終了した後も同じである。

`setsid`などで別のセッションに抜けたプロセスには、グループへのkillも孤児のClaudeの掃除も届かない。そのため、グループを止めた後、2秒たっても出力のパイプが閉じなければ読み取りを打ち切り、結果に打ち切りの注記を付ける。抜けたプロセス自体はworkerに残る。

打ち切った出力は途中で切れていることがある。そのため、出力を判断に使う実行は、終了コードが0でも失敗として扱う。対象は次のとおりである。

- gitleaksと、それに渡す差分
- 保護パス、symlink、`package.json`のscriptsの判定に使う変更の一覧とファイルの中身
- 差分の大きさ
- 検証したツリーの`git write-tree`
- 検査コマンド

### 検査コマンドの出力の上限

検査コマンドの出力は、ストリームごとに1MiBまでしか保持しない。超えた分は、先頭と末尾を残して間を捨てる。DBには、秘密をマスクした先頭16KBを保存する。失敗した検査の出力を先に並べる。

### pushの拒否

`.github/workflows/`の下を含むpushは、PATに`workflow`の権限が無いとGitHubが拒否する。拒否されたときは、その旨を人の対応待ちの理由に載せる。
