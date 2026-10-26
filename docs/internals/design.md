# 設計書の生成

承認済みの要件定義から設計書を作る処理を定める仕様である。
設計フロー、設計書の保存、設計のClaudeの書き込み範囲を変更する人が読む。

設計工程の生成側は入っているが、入口は閉じていて動かない。
本番では作業項目が設計中(`designing`)にならず、設計の承認依頼も作られない。

## 入口が閉じていること

要件定義の承認を反映する`requirements_apply`は、承認の分岐を、依存を注入できる関数`applyApprovedBranch`に切り出している。
設計フローを起動する依存`startDesign`が空でなければ、作業項目を承認待ち(`awaiting_approval`)から設計中へ移し、設計フローを起動する。
空であれば、承認済み(`approved`)へ移して実装へ進む従来の経路を通る。

本番の依存を組み立てる`buildApprovedBranchDeps`は、`startDesign`を常に空にする。
テストがこの戻り値を固定する。
設計フローを手で起動しても、起動側がジョブIDを記録しないので、準備ステップがリースを確かめられずに何もせず終わる。
準備ステップは、起動側が記録したジョブIDとの一致を、最大60秒待って確かめる。

設計中を経由すると`approved`を通らない。
要件定義が承認されたことの根拠は、承認依頼(`approval_requests`)の承認の行だけになる。

## 設計フローの流れ

設計フロー(`f/factory/design`)は、pipelineフローと同じ形の3つのステップで動く。
入力は`work_item_id`、`design_attempt`、`feedback`である。
`design_attempt`は1から数える。
0は設計していない作業項目の既定値にだけ使う。
`design_generate`にフローの再試行(`retry`)は付けない。
再試行はステップ全体を呼び直すので、要件定義へ戻す遷移と、起動したpipelineのジョブIDの記録が、再試行と競合するためである。
どのステップも、設計フローのリースを持つときだけ作業項目を書き換える。
リースは[作業項目の状態とリース](work-items.md)に書く。

| ステップ | 処理 |
| --- | --- |
| `design_prepare` | リースを確かめ、現在のattemptに一致する承認済みの要件定義があるかと、オーナーの数値IDを確かめる。Issueが閉じていれば取り消す。設計の試行を保存し、設計用のworktreeを作り直す |
| `design_generate` | 日次予算を確かめ、headless Claudeに設計書と図を書かせ、検査して下書きとして保存する |
| `design_request_approval` | 設計の承認依頼を記録して通知し、作業項目を設計の承認待ち(`awaiting_design_approval`)へ移す |

承認済みの要件定義が無いとき、オーナーの照合に通らないとき、日次予算を超えているときは、作業項目を人の対応待ち(`needs_human`)にしてDiscordに通知する。
後続のステップは飛ばす。

## 設計書の置き場所

設計書と図は、要件定義書と同じく、DBではなくworkerのファイルに置く。
試行ごとのディレクトリの形式は次のとおり。

```text
/var/lib/factory/requirements/<owner>/<repo>/issue-<N>/wi-<work_item_id>/design/req-<attempt>/attempt-<design_attempt>/
```

パスに要件定義のattemptと設計の試行の両方を入れる。
要件定義のattemptを進める更新(`setAttemptIfLeaseHolder`)は、同じ文で設計の試行を0に戻す。
パスに要件定義のattemptが無いと、戻った後の設計が、承認済みの設計の図を上書きしうるためである。

ディレクトリには、設計書の`design.md`と、図の`<name>.drawio`だけを置く。
Console用workerのマウントと、作業項目の掃除(`wi-<work_item_id>`ごとの削除)は、要件定義と共通である。

DBの設計の下書き(`design_drafts`)は、本文(`markdown`)、概要、図の参照、未確定事項、ファイルの置き場所(`doc_dir`)、読んだ既定ブランチの先頭(`head_sha`)を持つ。
図のXMLはDBに保存しない。

| 制約 | 内容 |
| --- | --- |
| 複合外部キー | `(requirement_draft_id, work_item_id)`が`requirement_drafts`の`(id, work_item_id)`を指す。別の作業項目の要件定義を指せない |
| 試行 | `design_attempt`は1以上である |
| 一意性 | 一意制約は無い。同じ組を複数保存でき、最新の行を採る |
| 削除 | 作業項目の削除は、`requirement_drafts`を経由して`design_drafts`に届く |

`requirement_drafts`の`UNIQUE (id, work_item_id)`は、複合外部キーのために足している。
`work_items`への直接の外部キーは作らない。
作ると`work_items`に暗黙のロックがかかり、`cleanup_db`の削除とロックを取る順が逆になるためである。

## Claudeの実行

`design_generate`は、試行ごとのディレクトリを空にしてからテンプレートを`design.md`として複製し、そこをClaudeのカレントディレクトリにする。
空にするのは、再試行した試行に前の試行の書きかけを見せないためである。

| 項目 | 値 |
| --- | --- |
| カレントディレクトリ | 試行ごとのディレクトリ |
| ツール | `Read`、`Glob`、`Grep`、`Write`、`Edit` |
| 書き込みの範囲 | `--restricted`で、作業ディレクトリと`--add-dir`の下に限る |
| 対象リポジトリ | 設計用のworktreeを`--add-dir`で読み取り専用として渡す |
| 要件定義の本文 | DBの`requirement_drafts.markdown`を、`dataFence`に入れてプロンプトに渡す |
| 要件定義の図 | 一時ディレクトリに複製した図だけを`--add-dir`で渡す |
| スキル | `factory-design`と`drawio-diagram` |
| 構造化出力 | `{outcome, summary, open_questions, gap_report}` |
| モデル | `heavy_model` |
| 上限 | `max_turns`、`max_budget_usd_per_run`、`claude_timeout_sec` |

`outcome`は、設計書を書けたときの`designed`と、要件の不足を返すときの`requirements_gap`のどちらかである。
`requirements_gap`では`gap_report`が空であってはならず、`designed`では`gap_report`が空でなければならない。

実行の後、`design.md`と`*.drawio`以外の項目は、警告を残して消す。
各図は`validateDrawioXml`で検査し、通らなければステップは例外で失敗する。
失敗は`on_error_flow`が扱う。

### 出力の守り

設計のClaudeの出力のうちDBに保存する文字列は、信頼できない入力を読んだClaudeの出力として扱う。
`summary`は1000字、`open_questions`は30件までで各要素は1000字までに収める。
`open_questions`の空の要素は捨てる。
処理の順は、制御文字と書式文字の除去、`maskSecrets`、切り詰めである。
除くのは、C0制御文字、DEL、C1制御文字(U+0080〜U+009F)、書式文字(Unicodeの分類`Cf`)である。
書式文字にはゼロ幅スペース、双方向の制御、バイトオーダーマークに加えて、絵文字をつなぐゼロ幅接合子(ZWJ)も入る。
そのため、ZWJでつないだ絵文字の列は、つながりが崩れる。
制御文字と書式文字を先に除くと、秘密情報の途中に挟まれた見えない文字でマスクをすり抜けられない。
結合文字(`Mn`、`Me`)、既定で無視されるコードポイント(`Default_Ignorable_Code_Point`)、ハングルのフィラー、U+2800は、保存する文字列からは除かない。
日本語の濁点の結合と異体字列に使うためである。
代わりに、それらを除いた影の文字列でマスクを判定する。
影に秘密情報があれば、影をマスクした結果を保存するので、それらの文字は落ちる。
影に秘密情報が無ければ、元の文字列をマスクして保存するので、濁点の結合と異体字列は崩れない。
見える区切り文字(空白、ハイフン、記号)を秘密情報の途中に挟む難読化は、マスクでは止められない。
マスクを切り詰めより先に行うと、切った末尾に秘密情報の一部が残らない。
改行とタブは本文に使うので残す。
`gap_report`は[要件の不足](#要件の不足)の上限を使う。

### 試行ディレクトリの再利用の防止

試行ディレクトリを空にする前、保存済みの設計の下書きの置き場所と重ならないか確かめる(`hasDesignDraftForDocDir`)。
持つ下書きがあれば、ディレクトリを触らず、作業項目を人の対応待ちにする。
空にして書き直すと、その下書きの図が消えるためである。

### 書き込み境界

設計のClaudeは、承認済みの要件定義を書き換えられない。
元の要件定義のディレクトリは、`--add-dir`の対象と、カレントディレクトリのどちらにも使わない。
Claudeが読む図は、行に宣言された図で、ファイル名の規則(`[a-z0-9-]{1,64}.drawio`)に合う通常のファイルだけを複製する。
リンクの図は、警告を残して複製に入れない。
複製を作る前に、`doc_dir`が`/var/lib/factory/requirements/`の下にあることを、Consoleの読み戻しと同じ方法で確かめる。

元のディレクトリの内容のハッシュは、承認の前に保存した基準値(`requirement_drafts.doc_hash`)と比べる。
基準値の取り方、図の複製との関係、照合の結果は[要件定義の生成と承認](requirements.md)の「基準値」に書く。
照合は次の位置で行い、合わなければ保存せずに作業項目を人の対応待ちにする。

| 位置 | 合わないときの理由 |
| --- | --- |
| Claudeの起動前、図の複製の前 | 設計を始める前に書き換わっていた |
| 図の複製の中。複製が読んだバイト列のハッシュを比べる。図が無く複製しないときは行わない | 設計を始める前に書き換わっていた |
| 図の複製の後 | 設計を始める前に書き換わっていた |
| Claudeの実行の後。実行が失敗したときと要件の不足を返したときも、結果を採る前に行う | 設計の実行中に書き換わった |

どの位置でも、基準値があるのにディレクトリが無ければ、書き換えとは別の理由(ディレクトリが無い)で止める。

基準値が無い下書きは、警告を1回ログに残す。
ルートがシンボリックリンクなら、基準値の有無に関わらず、書き換えとして止める。
実行の前の内容として、図の複製が読んだバイト列のハッシュ(複製しなかったときは複製の後の内容のハッシュ)を取り、実行の後のハッシュと比べるだけにする。

元のディレクトリは、作業ディレクトリと`--add-dir`のどちらの外にもある。
`--restricted`が、その外への書き込みを拒むかは確かめていない。
そのため、元のディレクトリが書き換わりうるかも確かめられていない。
ハッシュの比較は、書き換えを防ぐものではなく、検出して止める補強である。
複製とworktreeへの書き込みは使い捨てなので、検出の対象にしない。
セキュリティ上の限界は[セキュリティ](../security.md)の「設計書の生成の安全策」に書く。

## 検査

テンプレートは`.claude/skills/factory-design/template.md`にある。
生成した文書は、`f/factory/lib/design_doc.ts`の`validateDesignDoc`が機械的に検査する。
章立てなどの決まりは`f/factory/lib/design_template.ts`の定数に持つ。

| 検査 | 内容 |
| --- | --- |
| 章立て | `##`の見出しが、順序も含めて決まった9章と一致する |
| 要件のID | 要件との対応表のIDが`DS-001`の形である |
| 禁止の記法、引用、長さ、図、文章 | 要件定義書と同じ規則である([要件定義の生成と承認](requirements.md)の「テンプレートと検査」) |

Claudeの出力が検査を通らないときの再試行も、要件定義と同じである。

## 要件の不足

設計が要件定義だけでは足りないと判断したときは、`requirements_gap`と、要件定義への報告(`gap_report`)を返す。
`design_generate`は次のように扱う。

1. `gap_report`を長さの上限と`maskSecrets`に通す。
2. 要件定義の試行(`attempt`)が上限(`max_attempts`)に達していれば、作業項目を人の対応待ちにする。
   理由は`design requirements_gap after max_attempts N`である。
3. 達していなければ、リースを条件にした1文の比較交換で、設計中から要件定義の生成中(`requirements_generating`)へ移す。
   同じ文で`design_attempt`を0にし、`flow_job_id`を空にする。`attempt`はこの文では書かない。
4. `pipeline`を`attempt + 1`で起動し、ジョブIDを記録する。
5. 起動か記録に失敗したら、リースが空のときだけ人の対応待ちへ戻す。
   手順は却下の再生成と同じである([作業項目の状態とリース](work-items.md)の「却下と再生成」)。

`gap_report`は、信頼できない入力を読んだClaudeの出力である。
`feedback`には自動の報告の印(`AUTOMATED_FEEDBACK_MARKER`)で始まる文として渡す。
`requirementsPrompt`は、印のある`feedback`を人の差し戻しの理由として扱わず、`dataFence`に入れて、別の段のClaudeが出した信頼できない報告だと明記する。
リースを失った実行は、何も書かず、起動もしない。

## 承認依頼

`design_request_approval`は、承認依頼を記録する前に、最新の下書きの行を確かめる。
行の`design_attempt`がフローの入力と、行の`requirement_draft_id`が最新の承認済みの要件定義の下書きと、それぞれ一致しなければ、例外にする。

承認依頼は、種類(`kind`)を`design`、対象(`subject_id`)を`design_drafts.id`として記録する。
`payload`は`{"attempt": n, "design_attempt": m}`で、期限は7日である。
続けて、作業項目を設計中から設計の承認待ちへ比較交換で移し、Discordに設計の承認依頼を通知する。
移せなければ、記録した依頼を期限切れにする。
古い下書きを承認できないようにするためである。
人が先に決定していれば、依頼は変えない。

## worktreeと掃除

設計は、対象リポジトリの設計専用のworktree(`/workspaces/<owner>/<repo>/design-<N>`)を読む。
要件定義用の`req-<N>`とは別にする。
要件定義の承認の反映が`req-<N>`を消すので、共有すると設計の途中で消えるためである。

`design_prepare`は、リースと設計中の状態を確かめた後でだけ、`design-<N>`を毎回作り直す。
前の実行のプロセスが使用中なら、消さずに例外とする。
リースを失った実行は、worktreeを触らずに終える。
既定ブランチの先頭は、メインのcloneで求めて`head_sha`として次のステップへ渡す。
Claudeの実行の後に、`design-<N>`の中でgitを実行しない。
書き換えられた`.git`の設定を、gitが読みうるためである。

`design_generate`は、Claudeの実行をworktreeのプロセスロックで包む。
準備が使用中のworktreeを消さないためである。
ロックの持ち主の種別は`design`で、値はリースのルートジョブIDである。
設計の準備は、プロセスを止めない。
実装の準備も、持ち主が`design`のプロセスは止めない。
残ったプロセスが使用中なら、`WorktreeBusyError`で引き返す。
後始末は`finally`で行う。

| 後始末の対象 | 削除の条件 |
| --- | --- |
| `design-<N>`のworktree | リースを持つときだけ。リースを失った実行が消すと、同じパスを使う新しい実行のものを消しうる |
| 要件定義の図の複製 | リースに関係なく消す。ジョブごとの一時ディレクトリで、新しい実行と共有しない |

実行が強制終了されて`finally`が走らなかったときの`design-<N>`は、日次の掃除(`f/factory/cleanup_workspaces`)が消す。
消す対象の判定は`f/factory/lib/cleanup_support.ts`にある。
対象は、終端の作業項目の`design-<N>`である。
稼働中の作業項目のものは除く。

## 人の対応待ちの通知

設計フローの人の対応待ちの通知は、理由の訳と次の操作を`designNeedsHumanFields`で作る。
設計フローの失敗でも、`on_error_flow`の`failureNextAction`が、設計フローの失敗に設計向けの次の操作を返す。
worktreeのロックが残っているときの案内が、実装と設計で変わるためである。
設計のClaudeが残したプロセスを確かめて止める操作を示し、設計の準備が何も止めないことを添える。

設計が使う理由の文字列は、理由の定数と関数が作る。
理由と次の操作の対応は、`pr_workflow_support.ts`の表(`DESIGN_REASON_RULES`)が持つ。
表は定数をimportせず、文字列を直接書く。
`tests/scripts/pr_workflow_support_design.test.ts`が、定数と関数の出力を表と突き合わせる。

| 理由 | 定数または関数 |
| --- | --- |
| 設計フローを起動できなかった | `DESIGN_START_FAILED_REASON` |
| 承認済みの要件定義が無い | `designNoApprovalReason` |
| 要件の不足を返したが試行が上限に達した | `designGapExhaustedReason` |
| 設計を始める前に書き換わっていた | `REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON` |
| 設計の実行中に書き換わった | `REQUIREMENTS_MODIFIED_REASON` |
| 実装の関門で書き換わっていた | `REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON` |
| 要件定義のディレクトリが無い | `REQUIREMENTS_DIR_MISSING_REASON` |
| 保存済みの下書きと同じディレクトリである | `DESIGN_DOC_DIR_IN_USE_REASON` |

書き換えとディレクトリが無い場合の次の操作は、承認済みのディレクトリを確かめ、要件定義を作り直すことである。
作業項目を再実行しても、基準値が残るので同じ理由で止まる。

## リースと失敗

設計フローのリースは、pipelineフローと同じ規則で、`flow_job_id`が自分のルートジョブIDと一致することを求める。
`on_error_flow`は、設計フローの失敗でも、`flow_job_id`がルートジョブIDと一致するときに限って作業項目を失敗(`failed`)にする。
要件へ戻す比較交換は`flow_job_id`を空にする。
空の間は、残った古い実行の失敗が、新しい作業項目を失敗扱いにできない。

設計中と設計の承認待ちは、承認済み以降の状態の集合(`APPROVED_OR_LATER_STATUSES`)に入れる。
設計中の親の作業項目を、PR修正の差し戻しが見つけられるようにするためである。
