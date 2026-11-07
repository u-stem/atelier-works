// 保護パスの判定を、pr_fixとimplementフローで共有する。
// pr_fix(`steps/pr_workflow_support.ts`)では一致するとpushを止め
// (docs/security.md「PR修正の安全策」)、implementフロー(`lib/implement_support.ts`)では
// PR本文とDiscord通知に記録するだけにする。
// `implement_support`が`steps`からimportしないで済むよう`lib`に置き、
// `pr_workflow_support.ts`が判定関数とpr_fixの一覧を再exportする。

export type ChangedPathStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechange"
  | "unknown";

export type ChangedPath = {
  readonly path: string;
  readonly status: ChangedPathStatus;
};

/**
 * pr_fixが保護するディレクトリ。
 * どのコマンドが実行されるか、パッケージマネージャーやgitが何を信頼するかを変える設定を
 * すべて含める(エージェントの設定、CIのワークフローとcomposite action、
 * miseのXDG・ドットファイルの設定場所、
 * ディレクトリ形式のlefthook設定)。
 * composite actionは、PATのWorkflowsの権限の拒否が及ばないので、パスで止める。
 * `console/public/`も含める。Consoleでバンドルを通らずにそのまま配信され、ページの中で動くファイルを置く。
 * `infra/console_fetcher/`も含める。Consoleの配信物を検証して配信するコードで、書き換えられると、
 * 検証をすり抜けた内容が運用者のブラウザに配信される。
 * `f/factory/dependabot__flow/`も含める。dependabotの更新を自動でマージするフローで、
 * `flow.yaml`に加えて、フローに埋め込むモジュールも書き換えられると、許可していない更新をマージできる。
 * `f/factory/investigate__flow/`も含める。調査の入口のフローで、`flow.yaml`にinline scriptを混ぜられると、関門を通らずにClaudeを起動できる。
 * `f/factory/investigate_isolation_probe.`も含める。調査のClaudeの隔離の測定のscriptで、関門はこのscriptの完了ジョブの結果を信頼する。
 * 拡張子を問わない前方一致にして、`.ts`、`.script.yaml`、`.script.lock`、`.schedule.yaml`をまとめて塞ぐ。
 * 書き換えられると、隔離に合格していない測定が合格の結果を返せる。測定のscriptに隣り合う名前も、先に押さえる。
 * ホストの実行役が実行する道具のディレクトリも含める。
 * `scripts/host_apply/`は実行役の実装、`infra/worker/`は実行役がビルドするworkerのイメージ、
 * `mise/`はmiseの設定ディレクトリで、どれもホストのユーザーの権限で動くか、動く道具の入力になる。
 * これらの変更をホストへ通す関門は、保護パスではなく実行役の承認である(`docs/security.md`のホストの実行役の節)。
 * 保護パスは、pr_fixの自動修正がこれらを書き換えるのを止め、implementのPRに明記させる補助である。
 * ローカルのフック(`scripts/claude-hooks/`とそのテスト`tests/scripts/claude-hooks/`)も含める。
 * subagentの拒否(push、秘密値の参照、保留の操作)を決めるので、書き換えられると拒否が外れる。
 * miseのタスクのディレクトリ(`mise-tasks/`と`.mise-tasks/`)も含める。置いたファイルが`mise run`のタスクとして実行されるので、
 * 拒否のフックが見分ける`hold:*`の外から、保留などの操作を実行する道になる。まだ存在しなくても、名前を先に押さえる。
 */
export const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".github/actions/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
  "console/public/",
  "infra/console_fetcher/",
  "f/factory/dependabot__flow/",
  "f/factory/pr_review_intake__flow/",
  "f/factory/investigate__flow/",
  "f/factory/investigate_isolation_probe.",
  "scripts/host_apply/",
  "infra/worker/",
  "mise/",
  "scripts/claude-hooks/",
  "tests/scripts/claude-hooks/",
  "mise-tasks/",
  ".mise-tasks/",
];

/**
 * pr_fixが保護する個別のファイル(リポジトリのルートからの相対パス)。
 * `console/index.html`は、Consoleのすべてのscriptの読み込み元で、バンドルを通らずに配信される。
 * ファイル名だけでは他の`index.html`と区別できないので、パスで判定する。
 * `console/drawio-viewer.json`は、CIが取得して配信するdraw.ioのビューアの取得元とsha256を固定する。
 * 書き換えられると、別のスクリプトを固定の値として配信される。
 * 固定を書き換えるPRを作る`f/factory/drawio_viewer_bump.ts`、その判断の`lib/drawio_viewer_bump.ts`、
 * 更新だけが使うGitHubの読み取りの`lib/drawio_viewer_bump_github.ts`、14日の待ちの根拠になる
 * 観測の記録の`lib/drawio_viewer_observations.ts`、スケジュールとscriptの定義(`*.schedule.yaml`、
 * `*.script.yaml`)も同じ理由で守る。書き換えられると、人の確認なしに別の取得元や版を固定のPRにできる。
 * 部品のscript定義(`lib/drawio_viewer_bump*.script.yaml`、`lib/drawio_viewer_observations.script.yaml`)も守る。
 * `.script.yaml`は、`lock`の参照先を決める。参照先を書き換えられると、反映のときにworkerやホストの
 * 任意のファイルがlockとして読まれうるので、libのものも守る。
 * 一方、`drawio_viewer_bump.script.lock`と`lib/drawio_viewer_observations.script.lock`は守らない。
 * `windmill-client`の版を上げる変更で、全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
 * 依存の無い`lib/`のlockも守らない(後述の「libのlockは入れない」)。
 * 固定を強制する側も同じ理由で守る。ビューアの照合と取得、配信物の一覧(manifest.json)の作成、
 * lockfileの検査のスクリプトは、書き換えられると検査をすり抜けて配信物に混ざる。
 * `asset-name.ts`は照合したビューアの書き込み先の名前を決め、`vite.config.ts`は
 * 組み立ての途中で任意のコードを動かして配信物に書ける。
 * `scripts/ci-scope.ts`は、CIがどのジョブを動かすかを決める。書き換えられると、検査のジョブを
 * 黙って飛ばせるので、固定を強制する側と同じ理由で守る。
 * `infra/Caddyfile`には、Consoleのscriptの許可と、draw.ioの図を隔離するCSPがある。
 * `infra/`全体は、pr_fixでは止めない。
 * 図を隔離して描くiframeの検査(`tests/lib/drawio_frame_isolation.test.ts`)も守る。
 * このテストは、`DrawioFrame.tsx`のsandboxとiframeの受け口のメッセージを固定値と照合する。
 * 書き換えられると、図を描くiframeにsandboxを外したり別のページを読ませたりしても、検査を通る。
 * sandboxは、HTTPのCSP(`infra/Caddyfile`)も後ろ盾になる。
 * scriptの定義の`lock`の契約テスト(`tests/lib/script_yaml_lock_contract.test.ts`)も守る。
 * `wmill sync push`は`lock: '!inline <パス>'`のパスを制限なしに読んでlockとして保存する。
 * このテストが、すべての定義の参照先を自分の`.script.lock`に固定している。
 * 書き換えられると、保護の外の定義から、workerやホストの任意のファイルをlockに載せられる。
 * `bunfig.toml`の`preload`が読む`tests/preload.ts`も守る。
 * libの`.script.yaml`は、引数を持たず変更がまれで、守る費用がほぼ無いので、外さない。
 * `wmill.yaml`も守る。`codebases`の`customBundler`は、`wmill sync push`が反映時にシェルで実行する。
 * `assets`の`from`は、`wmill sync push`が任意のパスのファイルを読んでワークスペースに載せる。
 * 書き換えられると、反映するworkerやホストで任意のコマンドが走り、任意のファイルがワークスペースに載る。
 * 設定として読まれる別名(`wmill.yml`)と、サブディレクトリの`wmill.yaml`も、ファイル名で守る。
 * wmillが読むかは確かめていないので、読むものとして安全側に倒す。
 * `wmill-lock.yaml`は、依存の変更のたびに書き換わるので守らない。
 * dependabotのセキュリティ更新PRを自動でマージするフローも守る。マージの判定(`lib/dependabot_support.ts`)、
 * 影響調査のプロンプト(`lib/dependabot_prompt.ts`)、npm registryの取得(`lib/dependabot_registry.ts`)、
 * ゲート入力の組み立て(`lib/dependabot_collect.ts`)、フローの支援関数(`lib/dependabot_flow_support.ts`)、
 * 取得(`poll_dependabot.ts`)とそのスケジュール、
 * 3つのステップ(`steps/dependabot_prepare.ts`、`dependabot_assess.ts`、`dependabot_finish.ts`)と、
 * それぞれのscript定義(`*.script.yaml`)である。フロー(`dependabot__flow/`)は、前方一致で守る。
 * 書き換えられると、人の確認なしに、許可していない更新をマージできる。
 * まだ存在しないファイルも先に守る。名前を先に押さえ、後から置かれたファイルが保護の外に出ないようにするためである。
 * 一方、窓口の`poll_dependabot.script.lock`と`steps/dependabot_*.script.lock`は守らない。
 * `windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わり、その変更を止めてしまうためである。
 * CIが出すメタデータのパッチを取得して検査する部品(`lib/metadata_patch_*.ts`の6つ)と、それぞれの`.script.yaml`も守る。
 * 6つのうち、`metadata_patch_manifest.script.lock`だけは守る。新しいscriptのlockを照合するときの空のlockの参照
 * (`metadata_patch_verify.ts`の`EMPTY_LOCK_REFERENCE`)で、壊されると新しいscriptの自動適用が断られ続けるためである。
 * 6つは、manifest、zip、yaml、verify、imports、downloadである。
 * パスの許可リスト、manifestの形、zipの読み方、yamlの許可するキー、importの読み方、適用の条件、
 * トークンの渡し先と取得先を決める。書き換えられると、パッチの受け取り側の検査が緩む。
 * `wmill-lock.yaml`のhashを自前で再計算する部品(`lib/metadata_hash.ts`、`lib/metadata_precheck.ts`、`lib/metadata_signature.ts`、
 * `lib/metadata_git_ports.ts`)と、それぞれの`.script.yaml`も守る。
 * hashの算法、再計算してよい条件、`main`の引数の比べ方、検査が読むgitのオブジェクトの取り方を決める。
 * 書き換えられると、依存が変わるPRや、入力のスキーマが変わるPRのlockを、人の確認なしに書き換えさせられる。
 * 再計算の出力を配線する`lib/ci_metadata_rehash.ts`と、その`.script.yaml`も守る。
 * `wmill-lock.yaml`だけの変更を許す条件(`confirmRehash`、`rehashPushStopReason`、`readStagedRootLock`)と、書き込み先を決める。
 * libのlockは入れない。上のlibは`main`を持たず、単独のjobとして動かない。importする側のscriptは
 * 自分の`.ts`と`.script.lock`で動くので、libのlockは実行の入力にならず、中身が変わっても動きは変わらない。
 * libの`.ts`と、`lock`の参照先を固定する`.script.yaml`は、守られている。
 * この前提(libが`main`、`preprocessor`、行頭の`export default`、再exportを持たない)は、
 * `tests/lib/protected_paths.test.ts`が固定する。
 * 一方、次のものは、このリストに入れない。
 * 例外を開くコールバックの本体(`steps/pr_fix_verify.ts`と`steps/pr_fix_finish.ts`)と、
 * 変更の形を判定する`isLockOnlyChange`と、それを呼ぶ`isRehashCandidate`、`inspectCiFixChanges`の`rehashCheck`の分岐、
 * 回の分類を読む`readCiFailure`と、ログを読んで整合のテストだけの失敗かを答える`isLockIntegrityOnlyFailure`(いずれも`lib/ci_fix_round.ts`)、
 * 失敗したジョブを分類する`classifyCiFailure`(`lib/ci_fix_classify.ts`)である。
 * 起動の判断の`decideFixClaim`(`lib/pr_ci_fix_claim.ts`)で、整合のテストだけの失敗を`metadata_only`に切り替える分岐(`upgradeToRehash`)も入れない。
 * `classifyCiFailure`の結果が、`metadata`だけが落ちた回(`metadata_only`)を決め、起動の判断の免除(予算とマーカーの確認)を決める。
 * ロックの整合のテストだけが落ちた回は、`readCiFailure`が、ログを読み、`isLockIntegrityOnlyLog`(`lib/ci_fix_classify.ts`)で決める。
 * その判定に使う`LOCK_INTEGRITY_TESTS`と`LOCK_INTEGRITY_ANCHOR`も、同じ理由で入れない。範囲を広げる変更は、人のレビューで差分を確かめて止める。
 * 再計算が読むgitの動き方を決める、`lib/workspace.ts`のgitの固定設定(`FIXED_GIT_CONFIG`、`GIT_NO_REPLACE_OBJECTS`、`GIT_ALLOW_PROTOCOL`)も入れない。
 * ほかのCI回の部品と同じく、日常的に直すファイルで、守るとその正当な変更をすべて止めるためである。
 * これらを書き換えて例外の条件を緩める変更は、マージ前の人のレビューで差分を確かめて止める。
 * ホストの実行役が実行するファイルも守る。実行役の入口(`scripts/host-apply.ts`、まだ存在しない`scripts/host-apply.sh`)、
 * 導入と診断と初期化のスクリプト(`host-install.sh`、`check-docker-version.sh`、`doctor.sh`、`bootstrap.sh`、
 * `custom-tags.ts`、`record-host-applied.sh`)は、ホストのユーザーの権限で、秘密値を渡して動く。
 * `check-idle.ts`(`mise run up`と`mise run deploy`が呼ぶ、実行中の仕事の確認)とそのテストも、同じく守る。
 * `infra/docker-compose.yml`は実行役が静的に検査して反映する定義で、`tests/infra/docker_compose.test.ts`は
 * その定義の境界を固定する。実行役のテスト(`tests/scripts/host_apply_*.test.ts`)と、それが使う
 * 一時リポジトリの補助(`tests/fixtures/host_apply_repo.ts`)も、実行役の判定を固定するので守る。
 * 実行役のテストは、グロブではなくファイル名で列挙する。名前を先に押さえ、足したテストを列挙し忘れると、
 * 保護パスの契約テスト(`tests/lib/protected_paths.test.ts`)が失敗する。
 * CI回のClaudeには、`ci_`と`pr_fix_`で始まるファイルを、CI回の拒否(`ci_fix_paths.ts`)が別に止める。
 * 保留の表(`factory.holds`)の読み書きを持つ`lib/holds.ts`と、その`.script.yaml`も守る。
 * 表を作るmigration2本(`20261023131355_holds.up.sql`と`.down.sql`)も守る。参照を検出するテストが、この2本を走査から外すためである。
 * 走査から外すのは保護したファイルだけにする。外したファイルを書き換えられると、検出も保護も働かないからである。
 * `.lock`は保護しないので、走査に含める。
 * 保留は、自動マージとIssueの取り込みを止める。表への参照を`holds.ts`だけに絞る検査
 * (`tests/scripts/hold_wiring.test.ts`)、`holds.ts`の振る舞いのテスト(`tests/lib/holds.test.ts`、
 * `tests/lib/holds_db.test.ts`)、実DBで表の制約を確かめる`scripts/test-db-holds.ts`も、同じ理由で守る。
 * 書き換えられると、参照の混入の検出が外れ、保留の期限の上限が外れる。
 * Consoleから保留と凍結を解除するscript(`hold_release.ts`、`freeze_release.ts`)とその部品(`lib/console_holds_support.ts`)、
 * そのテスト(`tests/scripts/hold_release.test.ts`、`tests/scripts/freeze_release.test.ts`)も守る。
 * 解除の書き手は、書き換えられると、他の主体の保留を無条件に外せるためである(CLIを守るのと同じ理由)。
 * 読み取りだけの`console_holds.ts`は守らない。置く操作を持たず、保留の表を書く名前を読み込めないことは
 * `tests/scripts/hold_wiring.test.ts`が固定する。
 * 保留のCLI(`scripts/hold.ts`)とpsqlの経路(`scripts/hold_psql.ts`)、そのテスト(`tests/scripts/hold.test.ts`、
 * `tests/scripts/hold_psql.test.ts`)も守る。CLIは保留を置く・解除する入口で、psqlの経路は接続先のデータベースと
 * 読み取り専用の設定を決める。書き換えられると、置く主体の確認や、実DBの検査が使い捨てのデータベースだけに書く保証が外れる。
 * CLIが実行時に読み込む`scripts/freeze.ts`と、それが読み込む`lib/freezes.ts`、`lib/freeze_apply.ts`も守る。
 * `hold:list`の凍結の件数を読むために、CLIが起動のたびに実行するコードで、書き換えられると、CLIの実行に任意の処理を足せる。
 * 読み込む先を足すと、`tests/lib/protected_paths.test.ts`が、CLIのimportの連鎖がすべて保護パスに入っているかを確かめて失敗する。
 * `scripts/ci-scope.ts`はすでに守っている。psqlの経路は、実DBの検査が読み込むファイルとして、そこに載せる。
 * 一方、`holds.script.lock`は守らない。依存の無いlibのlockと同じ扱いである。
 * `scripts/test-db-holds.ts`が使う`scripts/test-db-sql.ts`も守らない。ほかの実DBの検査も使う部品で、
 * 守ると日常の変更を止めるためである。制約の拒否は、失敗の文に制約名が含まれることまで照合するので、
 * 単純な誤りでは検査を通らない。
 * `scripts/test-db.sh`は、日常的に直すので守らない。代わりに、`hold_wiring.test.ts`が、
 * `scripts/test-db-holds.ts`を呼ぶ位置を固定する。
 * ジョブ、schedule、設定を読むscript(`console_jobs.ts`、`console_schedules.ts`、`console_config.ts`)と、
 * ログと結果の伏せ字の部品(`lib/console_redact.ts`)、リポジトリの定義から生成した既知pathの定数(`lib/console_known_paths.ts`)と
 * その生成の道具(`scripts/gen-console-known-paths.ts`)、操作の記録の部品(`lib/console_actions.ts`。保持の日数の定数を含む)、
 * 操作者を導く`lib/approver.ts`、それぞれの`.script.yaml`、記録の表を作るmigration2本も守る。
 * 返す項目の許可表、伏せ字の規則、記録の順序とfail-closedは、書き換えられるとConsoleに返す内容と、記録の信頼が変わる。
 * Console用workerの許可リスト(`console/src/api/windmill.ts`)と、その検査(`console/src/api/windmill.test.ts`、
 * `tests/scripts/console_write_contract.test.ts`、`console_jobs_contract.test.ts`、`console_worker_boundary.test.ts`、
 * `console_script_tags.test.ts`、`worker_boundary_scan.ts`)、各部品のテストも、同じ理由で守る。
 * ジョブの画面の出力の描き方を固定する検査(`tests/scripts/console_jobs_render_contract.test.ts`)と、
 * サーバー由来の文字列を無害化する部品(`console/src/lib/safeText.ts`)、そのテストと、全項目への適用を確かめるテスト
 * (`console/src/screens/jobs/safeTextCoverage.test.tsx`)も守る。これらを書き換えると、出力の描き方が変わるためである。
 * 設計の承認画面が全文を描く部品(`console/src/lib/visibleText.ts`)、そのテスト、全コードポイントの契約テスト
 * (`tests/scripts/console_design_visible_text_contract.test.ts`)も守る。
 * `visibleText.ts`は、実装に渡る全文の見えない文字を表記にする範囲と、承認を止める件数の数え方を持つ。
 * 承認を止める判定(`designApprovalBlock`)は、作業項目の状態などの判定と、人に見せる止める理由の文まで、同じ部品が持つ。
 * 止める判定の全体を守る意図なので、文言の手直しも人のレビューを経る。
 * 範囲は`safeText.ts`と同じく自前で持つ。契約テストは、バックエンドの整形の出力と1文字ずつ対応することを、
 * 0からU+10FFFFまで、漏れと余計な置き換えの両方向で確かめる。
 * 書き換えられると、範囲を狭める変更や判定を緩める変更が、人のレビューを経ずに入り、
 * 承認する人に見えない文字が、実装に渡ったまま承認される。
 * 承認画面(`console/src/screens/inbox/DesignReview.tsx`)と、承認画面から承認のボタンまでの配線を固定するテスト
 * (`console/src/designApprovalWiring.test.ts`)も守る。
 * 承認画面は、取得した全文を描く部分、止める判定への入力の渡し方、全文の外の行数と終わりの印を、1つのファイルに持つ。
 * 保護しないと、渡す全文を作り替える変更や、判定に別の値を渡す変更が、人のレビューを経ずに入る。
 * 判定を呼ぶ`designBlockedReason`(`console/src/lib/approvalDecision.ts`)と、確認文、トースト、型ガードは、
 * 日常的に直す部品なので守る一覧に入れない。判定の本体は`visibleText.ts`にある。
 * 保護しない祖先の部品や全体のCSSから、全文の一部を隠す手は、ファイル単位の保護では閉じられない。`docs/security.md`の残るリスクに書く。
 * ジョブを取り消すscript(`console_job_cancel.ts`)と、操作の記録を足した既存の書き込みのscript(`retry_work_item.ts`、
 * `manual_intake_submit.ts`。`hold_release.ts`と`freeze_release.ts`は上で守っている)も、それぞれの`.script.yaml`とともに守る。
 * 取消の許可表(取り消せるフローの名前)と、記録の順序は、書き換えられると、取り消せる対象が増えたり、記録なしで操作できたりする。
 * 記録の配線と取消の許可表を固定するテスト(`tests/scripts/console_write_audit.test.ts`、`console_cancel.test.ts`、
 * `cleanup_db_console_actions.test.ts`)も守る。拒否フックの一覧(`scripts/claude-hooks/console-scripts.ts`)とそのテストは、
 * `scripts/claude-hooks/`と`tests/scripts/claude-hooks/`の接頭辞で、すでに守っている。
 * 失敗した定期ジョブを再実行するscript(`console_job_rerun.ts`)と、設定を止める向きか下げる向きに変えるscript
 * (`console_config_update.ts`)も、それぞれの`.script.yaml`とともに守る。再実行の許可表(再実行できる定期処理)と、
 * 設定の許可表(変更できる項目と向きと下限)は、書き換えられると、再実行できる処理や変更できる設定が増えるためである。
 * 2つの許可表を固定するテスト(`tests/scripts/console_rerun.test.ts`、`console_config_update.test.ts`)も守る。
 * 保留と凍結を置くscript(`console_hold_place.ts`)と、凍結を置いたscheduleを止めるscript(`console_schedule_stop.ts`)も、
 * それぞれの`.script.yaml`とともに守る。置ける期限の上限と、止められるscheduleの許可表は、書き換えられると、
 * 長く止められたり、止めてはならないscheduleを止められたりするためである。
 * 2つのscriptのテスト(`tests/scripts/console_hold_place.test.ts`、`console_schedule_stop.test.ts`)も守る。
 * 凍結の変数を読み書きする部品は、`lib/freezes.ts`にあり、すでに守っている。
 * 置くscriptと止めるscriptの画面の部品(`console/src/lib/holdPlace.ts`、`console/src/screens/system/HoldPlaceDialog.tsx`など)は、
 * 取消などの画面の部品と同じ理由で守らない。
 * 取消の画面の部品(`console/src/lib/jobActions.ts`、`console/src/screens/jobs/JobActions.tsx`)とそのテストも守らない。
 * 再実行と設定変更の画面の部品(`console/src/lib/configChange.ts`、`console/src/screens/system/ConfigChangeDialog.tsx`など)も同じ理由で守らない。
 * 守ると毎回人の確認が要り、書き換えられた被害は、確認のダイアログを飛ばして呼ぶことに限られるためである。
 * 絞り込みと記録は守ったscript側にある(`docs/security.md`の「ジョブの取消」)。
 * 描画の部品(`JobDetailParts.tsx`、`ConfigSection.tsx`)も、同じ理由で守らない。
 * 契約テストが画面のソース全体を走査するので、守っても保証の上乗せが小さい。
 * これらのlock(`console_jobs.script.lock`など)は、`windmill-client`を含み、その版を上げる変更で全scriptのlockと
 * 一緒に書き換わるので守らない。
 * 共有の`lib/github.ts`は、ほかのフローも使うので守らない。
 * dependabotのフローが使うほかの共有モジュール(`lib/`の`dependabot_*`以外と`steps/pr_workflow_support.ts`)も守らない。
 * どれもほかのフローが日常的に直すファイルで、守るとその正当な変更をすべて止めるためである。
 * これらを書き換えてdependabotのフローの判断を変える変更は、PRのレビューで差分を確かめて止める。
 * 設計工程の門(`lib/design_gate.ts`とその`.script.yaml`)は守る。設定の`design_enabled`が真で、`design_enabled_since`が
 * 日時として読めるときだけ開く判定の1か所で、書き換えられると、人の確認なしに設計工程が開く。
 * 門を固定する2つのテスト(`tests/scripts/design_stage_closed.test.ts`、`design_entry_origins.test.ts`)も守る。
 * 門の呼び出しの形(設定の読み込みが門の結果だけから`design_enabled`を導くこと)と、設計フローを起動できる元の集合を
 * 固定しているので、書き換えられると、門が緩んでも黙って通るためである。
 * `lib/config.ts`は日常的に直すので守らない。門の呼び出しの形を保護されたテストが固定するので、守っても保証の上乗せが小さい。
 * 門の単体のテスト(`tests/lib/design_gate.test.ts`)も、保護されたテストが同じ判定を確かめるので守らない。
 * 進め方ごとの承認の要否の表(`lib/profile.ts`とその`.script.yaml`)は守る。受け付ける進め方の一覧と、承認を省く進め方の表が
 * この1か所にあり、書き換えられると、要件定義や設計の承認を、人の確認なしに省ける。
 * 表と、実装の関門が表を通すことを固定するテスト(`tests/scripts/profile_gate.test.ts`)も守る。
 * 承認を省く進め方の手動投入を通す3つのファイル(`steps/manual_intake_create_issue.ts`、`steps/manual_intake_register.ts`、
 * `lib/manual_intake_support.ts`)と、それぞれの`.script.yaml`、冪等キーの表を作るmigration2本も守る。
 * キー必須と実装の停止スイッチの断り、キーの表の行との照合、ラベルなしのIssueの作成、`picked`から`implementing`への起動が、この3つにある。
 * 書き換えられると、キー無しの投入や、キーの表と食い違う登録が通り、承認の行の無い作業項目が、人の確認なしにできる。
 * 一方、3つの`.script.lock`は守らない。`windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わるためである。
 * ConsoleからPRのレビューを投入する入口も守る。Console用workerの入口(`pr_review_submit.ts`)、GitHubを読んで作業項目を作る登録のステップ
 * (`steps/pr_review_intake_register.ts`)、投入のフロー(`pr_review_intake__flow/`、前方一致)、作業項目の作り方を`poll_prs`と共有する
 * `lib/pr_review_start.ts`、それぞれの`.script.yaml`、稼働中の`pr_review`をPRごとに1件にする一意インデックスのmigration2本である。
 * リポジトリの許可、オーナーIDの照合、fork headの断り、PRが開いていることの確認、同じPRの重なりの防止が、この中にある。
 * 書き換えられると、許可されていないリポジトリや閉じたPRのレビューが投入で通ったり、同じPRのレビューが重なったりする。
 * 一方、3つの`.script.lock`は守らない。`windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わるためである。
 * 調査のClaudeの隔離も守る。隔離の引数を定数で持つ包み関数(`lib/investigate_claude.ts`)、読み出しを塞ぐ固定の一覧と設定の書き出し
 * (`lib/claude_read_deny.ts`)、調査の入口を開ける門(`lib/investigate_gate.ts`)、調査のworktreeの置き場の検査と作成と掃除(`lib/investigate_workspace.ts`)、
 * 隔離の定数と隔離した実行の引数の組み立て(`lib/investigate_isolation.ts`)、合格の証拠の型(`lib/isolation_proof.ts`)、
 * 隔離の測定の結果を読む関門(`lib/investigate_isolation_gate.ts`)、隔離の観測でtranscriptから残す項目を取り出す純関数(`lib/investigate_isolation_observe.ts`)、
 * 隔離の合否を決める純関数(`lib/investigate_isolation_judge.ts`)、
 * それぞれの`.script.yaml`、10個を固定するテスト(`tests/lib/investigate_claude.test.ts`、`tests/lib/claude_read_deny.test.ts`、
 * `tests/scripts/investigate_gate.test.ts`、`tests/lib/investigate_workspace.test.ts`、`tests/lib/investigate_isolation.test.ts`、
 * `tests/lib/isolation_proof.test.ts`、`tests/lib/investigate_isolation_gate.test.ts`、`tests/lib/investigate_isolation_observe.test.ts`、
 * `tests/lib/investigate_isolation_judge.test.ts`、`tests/scripts/investigate_isolation_probe.test.ts`)である。
 * 判定のテストは、判定と観測と測定のscriptのsha256を、判定の版と対にして固定する。
 * 書き換えられると、調査のClaudeがworkerの秘密に届いたり、出力の本文が記録に残ったり、調査の入口が人の確認なしに開いたり、
 * 置き場の差し替えやsymlinkを含むリポジトリのworktreeが読まれたり、測定に合格していない隔離でClaudeが起動したり、
 * 観測の結果に読み出した本文や秘密が載ったり、隔離を破った測定が合格として記録されたりする。
 * `lib/claude.ts`も守る(下の「安全策を担うコード」)。隔離の引数と一覧は包み関数と専用のモジュールにあり、
 * 起動の呼び出し(argv、環境、実行の条件、起動の時点の設定)は、保護されたテストが固定する。
 * 3つの`.script.lock`は守らない。`windmill-client`を含みうるlockは、その版を上げる変更で全scriptのlockと一緒に書き換わるためである。
 * 稼働中の調査を全体で1件にする部分一意インデックスのmigration2本と、それを固定するテスト(`tests/scripts/investigate_singleton_migration.test.ts`)も守る。
 * 調査は置き場の自分以外の項目をすべて消すので、索引が外れると、調査が並行して互いのworktreeを消し合う。
 * 登録の挿入文(`lib/db.ts`)は守らない。日常的に直すファイルの中にあり、述語の一致をこのテストが固定するためである。
 * 調査の入口も守る。登録、準備、生成、投稿の4つのstep(`steps/investigate_*.ts`)、本文の無害化と秘密値の検査を持つ支援のlib(`lib/investigate_flow.ts`)、
 * それぞれの`.script.yaml`、6つの固定のテスト(`tests/scripts/investigate_{register,prepare,generate,post,flow}.test.ts`、`tests/lib/investigate_flow.test.ts`)、
 * テストが共有する部品(`tests/lib/investigateTestSupport.ts`)である。フロー(`investigate__flow/`)は前方一致で守る。
 * 調査の設定の再確認、排他の確認、関門、掃除、起動の順序は生成のstepにある。
 * 無害化と秘密値の検査は生成のstepと支援のlibにあり、投稿の直前の再検査は投稿のstepにある。
 * 書き換えられると、止めたはずの調査が動いたり、隔離の測定に合格していない隔離でClaudeが起動したり、
 * 調査の出力に紛れた秘密値が、検査を通らずにIssueへ投稿されたりする。
 * 一方、`lib/db.ts`の調査の関数と`on_error_flow.ts`の調査の分岐は守らない。日常的に直すファイルの中にあり、述語と分岐をテストが固定するためである。
 * 5つの`.script.lock`は守らない。`windmill-client`を含みうるlockは、その版を上げる変更で全scriptのlockと一緒に書き換わるためである。
 * 全体のカバレッジの下限を縛る検査(`scripts/check-coverage.ts`)とそのテスト(`tests/scripts/check_coverage.test.ts`)も守る。
 * 下限の定数と対象の定義がこの1か所にあり、書き換えられると、カバレッジが下がっても検査を通せる。
 * Factoryの安全策を担うコードも守る。headless Claudeの起動(`lib/claude.ts`。Bashの禁止、設定の出どころ、渡す環境変数)、
 * 検査コマンドの隔離(`lib/check_sandbox.ts`)と実行(`lib/check_runner.ts`)、実装の関門の判定(`lib/approval_gate.ts`)、
 * この一覧そのもの(`lib/protected_paths.ts`)、mainの自動反映(`self_update.ts`)と、それぞれの`.script.yaml`である。
 * 反映の判断の本体(ブランチの照合、wmillの環境と引数、反映の可否)は`lib/self_update_support.ts`にあり、`self_update.ts`はそれをつなぐだけなので、これも守る。
 * 書き換えられると、Claudeの隔離、検査の隔離、承認の関門、保護の範囲、反映の止め方が、人の確認なしに外れる。
 * ファイルは移さない。`lib/claude.ts`のパスは調査の隔離の測定が固定し、`self_update`のパスはscheduleとConsoleと凍結が固定するためである。
 * `lib/claude.script.lock`と`self_update.script.lock`は守らない。`windmill-client`を含み、その版を上げる変更で全scriptのlockと一緒に書き換わるためである。
 * ほかの4つのlibのlockは、依存の無いlibのlockと同じ扱いで守らない。
 * 全停止の部品も守る。実行中のClaudeと検査を止める監視(`lib/stop_check.ts`)と、全停止の判定(`lib/stop_all.ts`)と、それぞれの`.script.yaml`である。
 * 書き換えられると、全停止が置かれても実行中のClaudeと検査が止まらなくなる。
 * `lib/stop_check.script.lock`と`lib/stop_all.script.lock`と`lib/check_runner.script.lock`は、`windmill-client`を含むので守らない。
 * Consoleから全停止を置く・解除するscript(`console_stop_all.ts`、`console_stop_all_release.ts`)と、その`.script.yaml`も守る。
 * 3つの固定のテスト(`tests/lib/stop_all.test.ts`、`tests/scripts/console_stop_all.test.ts`、`tests/scripts/console_stop_all_release.test.ts`)と、
 * 変数のパスを名指しできるファイルを限る配線のテスト(`tests/scripts/stop_all_wiring.test.ts`)も守る。
 * 書き換えられると、全停止が置かれても設定やscheduleが止まらなくなるか、Consoleの確認と記録を経ずに解除でき、凍結中のscheduleが動き出す。
 * 2つの`.script.lock`は、`windmill-client`を含むので守らない。
 * 全停止のホストのCLI(`scripts/stop_all.ts`、`mise run stop`の入口)と、資格情報の期限の記録を組み立てる
 * `scripts/credential_expiry.ts`(`bootstrap.sh`が秘密値を環境に持たせて起動する)、その部品`lib/credential_expiry.ts`と`.script.yaml`も守る。
 * どれも、ホストのユーザーの権限と秘密値のある環境で動くため、書き換えられると任意の処理が秘密値の近くで動く。
 * 全停止が止めた設定を記録から戻す手順(`scripts/stop_all_restore.ts`、`mise run stop:restore`の本体)も守る。
 * 設定を有効にする向きに書くので、書き換えられると、検査と人の確認を経ずに機能が動き出す。
 * 手順が検査に使う`lib/config.ts`は、上に書いた理由で守らない。
 * 緩めると検査をすり抜けた設定が書かれうるが、書くには人が端末で`yes`を入力する。
 * `lib/credential_expiry.script.lock`は守らない。依存の無いlibのlockと同じ扱いである。
 * これらが読む`lib/log.ts`と`lib/types.ts`、`lib/cleanup_support.ts`は、多くのscriptが使う日常的に直す部品なので守らない。
 * 全停止の通知を変数に合わせる`lib/stop_all_notice.ts`と、ランナーの`lib/workspace.ts`は守らない。
 * 通知は止める働きを持たず、ランナーはほかのフローが日常的に直すファイルだからである。
 * 監視を呼ぶ`lib/claude.ts`、`lib/check_runner.ts`と、関門を持つ`self_update.ts`は、安全策を担うコードとして守っている。
 * Claudeの実行の費用の記録(`lib/claude_flow_failure.ts`)と、flowの再試行の判定(`lib/flow_retry_marker.ts`)と、それぞれの`.script.yaml`も守る。
 * 書き換えられると、費用が日次予算に数えられなくなり、費用だけがかかる再試行が走る。
 * 再試行の判定を各flowへ配線する`retry_if`のテスト(`tests/scripts/claude_flow_retry.test.ts`)も守る。
 * flowの定義(`*__flow/flow.yaml`)は日常的に直すので守らない。`retry_if`を消すと、保護されたこのテストが落ちるので、検査を通せず、人の承認に回る。
 * 2つのlibのlockは、上のlibのlockと同じ扱いで守らない。
 * 保護パスに触れた変更の反映を人の承認まで止める仕組みも守る。承認の表を作るmigration2本、表の唯一の読み書き(`lib/deploy_approvals.ts`)と
 * その`.script.yaml`、表の部品の単体テストと参照の検出(`tests/lib/deploy_approvals.test.ts`、`tests/scripts/deploy_approvals_wiring.test.ts`)、
 * 実DBの検査(`scripts/test-db-deploy-approvals.ts`)である。書き換えられると、承認の無い版が承認済みとして読まれ、保護パスの変更が人の確認なしに反映される。
 * `lib/deploy_approvals.script.lock`は、依存の無いlibのlockと同じ扱いで守らない。
 * 判定(`lib/deploy_gate.ts`)とその`.script.yaml`、単体テスト(`tests/lib/deploy_gate.test.ts`)も守る。判定のimportの連鎖は、すべて保護パスに入れる。
 * 判定を`self_update`に組み込む位置を固定するテスト(`tests/scripts/self_update_deploy_gate.test.ts`)も守る。
 * Consoleから反映を承認・却下するscript(`console_deploy_decide.ts`)と、その`.script.yaml`、テストも守る。
 * 書き換えられると、承認待ちでない版や、操作者の分からない判断が、承認として記録される。
 * `console_deploy_decide.script.lock`は、`windmill-client`を含みうるので守らない。
 * 判定が止めるのは、判定のコード自体の改変である。判定の入力(gitの実行と承認の行のDB接続)は、守らないモジュールから来る。
 * 守ると、全機能が使うモジュールを直すほぼすべてのPRが承認待ちになる。守っても、反映済みのscriptはDBに書けるので、承認の行を直接作る経路は閉じない。
 * この部分は、人のレビューとDBの権限に頼る。
 */
export const FORBIDDEN_EXACT_PATHS: readonly string[] = [
  "wmill.yaml",
  "console/index.html",
  "console/drawio-viewer.json",
  "f/factory/drawio_viewer_bump.ts",
  "f/factory/lib/drawio_viewer_bump.ts",
  "f/factory/lib/drawio_viewer_bump_github.ts",
  "f/factory/lib/drawio_viewer_observations.ts",
  "f/factory/lib/drawio_viewer_bump.script.yaml",
  "f/factory/lib/drawio_viewer_bump_github.script.yaml",
  "f/factory/lib/drawio_viewer_observations.script.yaml",
  "f/factory/drawio_viewer_bump.script.yaml",
  "f/factory/drawio_viewer_bump.schedule.yaml",
  "console/scripts/drawio-viewer.ts",
  "console/scripts/fetch-drawio-viewer.ts",
  "console/scripts/manifest.ts",
  "console/scripts/write-manifest.ts",
  "scripts/check-console-lockfile.ts",
  "scripts/ci-scope.ts",
  "scripts/check-coverage.ts",
  "tests/scripts/check_coverage.test.ts",
  "console/scripts/asset-name.ts",
  "console/vite.config.ts",
  "infra/Caddyfile",
  "tests/lib/drawio_frame_isolation.test.ts",
  "tests/lib/script_yaml_lock_contract.test.ts",
  "tests/preload.ts",
  "f/factory/lib/dependabot_support.ts",
  "f/factory/lib/dependabot_support.script.yaml",
  "f/factory/lib/dependabot_prompt.ts",
  "f/factory/lib/dependabot_prompt.script.yaml",
  "f/factory/lib/dependabot_registry.ts",
  "f/factory/lib/dependabot_registry.script.yaml",
  "f/factory/lib/dependabot_collect.ts",
  "f/factory/lib/dependabot_collect.script.yaml",
  "f/factory/lib/dependabot_flow_support.ts",
  "f/factory/lib/dependabot_flow_support.script.yaml",
  "f/factory/poll_dependabot.ts",
  "f/factory/poll_dependabot.script.yaml",
  "f/factory/poll_dependabot.schedule.yaml",
  "f/factory/steps/dependabot_prepare.ts",
  "f/factory/steps/dependabot_prepare.script.yaml",
  "f/factory/steps/dependabot_assess.ts",
  "f/factory/steps/dependabot_assess.script.yaml",
  "f/factory/steps/dependabot_finish.ts",
  "f/factory/steps/dependabot_finish.script.yaml",
  "f/factory/lib/metadata_patch_manifest.ts",
  "f/factory/lib/metadata_patch_manifest.script.yaml",
  "f/factory/lib/metadata_patch_manifest.script.lock",
  "f/factory/lib/metadata_patch_zip.ts",
  "f/factory/lib/metadata_patch_zip.script.yaml",
  "f/factory/lib/metadata_patch_yaml.ts",
  "f/factory/lib/metadata_patch_yaml.script.yaml",
  "f/factory/lib/metadata_patch_verify.ts",
  "f/factory/lib/metadata_patch_verify.script.yaml",
  "f/factory/lib/metadata_patch_imports.ts",
  "f/factory/lib/metadata_patch_imports.script.yaml",
  "f/factory/lib/metadata_patch_download.ts",
  "f/factory/lib/metadata_patch_download.script.yaml",
  "f/factory/lib/metadata_hash.ts",
  "f/factory/lib/metadata_hash.script.yaml",
  "f/factory/lib/metadata_precheck.ts",
  "f/factory/lib/metadata_precheck.script.yaml",
  "f/factory/lib/metadata_signature.ts",
  "f/factory/lib/metadata_signature.script.yaml",
  "f/factory/lib/metadata_git_ports.ts",
  "f/factory/lib/metadata_git_ports.script.yaml",
  "f/factory/lib/ci_metadata_rehash.ts",
  "f/factory/lib/ci_metadata_rehash.script.yaml",
  "f/factory/lib/holds.ts",
  "f/factory/lib/holds.script.yaml",
  "f/factory/hold_release.ts",
  "f/factory/hold_release.script.yaml",
  "f/factory/freeze_release.ts",
  "f/factory/freeze_release.script.yaml",
  "f/factory/lib/console_holds_support.ts",
  "f/factory/lib/console_holds_support.script.yaml",
  "tests/scripts/hold_release.test.ts",
  "tests/scripts/freeze_release.test.ts",
  "tests/lib/holds.test.ts",
  "tests/lib/holds_db.test.ts",
  "tests/scripts/hold_wiring.test.ts",
  "f/factory/lib/design_gate.ts",
  "f/factory/lib/design_gate.script.yaml",
  "tests/scripts/design_stage_closed.test.ts",
  "tests/scripts/design_entry_origins.test.ts",
  "f/factory/lib/profile.ts",
  "f/factory/lib/profile.script.yaml",
  "tests/scripts/profile_gate.test.ts",
  "f/factory/steps/manual_intake_create_issue.ts",
  "f/factory/steps/manual_intake_create_issue.script.yaml",
  "f/factory/steps/manual_intake_register.ts",
  "f/factory/steps/manual_intake_register.script.yaml",
  "f/factory/lib/manual_intake_support.ts",
  "f/factory/lib/manual_intake_support.script.yaml",
  "migrations/datatable/main/20261031110000_manual_intake_keys.up.sql",
  "migrations/datatable/main/20261031110000_manual_intake_keys.down.sql",
  "f/factory/pr_review_submit.ts",
  "f/factory/pr_review_submit.script.yaml",
  "f/factory/steps/pr_review_intake_register.ts",
  "f/factory/steps/pr_review_intake_register.script.yaml",
  "f/factory/lib/pr_review_start.ts",
  "f/factory/lib/pr_review_start.script.yaml",
  "migrations/datatable/main/20261102100000_active_pr_review_key.up.sql",
  "migrations/datatable/main/20261102100000_active_pr_review_key.down.sql",
  "migrations/datatable/main/20261102120000_investigate_work_items.up.sql",
  "migrations/datatable/main/20261102120000_investigate_work_items.down.sql",
  "migrations/datatable/main/20261104100000_investigate_singleton.up.sql",
  "migrations/datatable/main/20261104100000_investigate_singleton.down.sql",
  "tests/scripts/investigate_singleton_migration.test.ts",
  "f/factory/lib/investigate_claude.ts",
  "f/factory/lib/investigate_claude.script.yaml",
  "f/factory/lib/claude_read_deny.ts",
  "f/factory/lib/claude_read_deny.script.yaml",
  "f/factory/lib/investigate_gate.ts",
  "f/factory/lib/investigate_gate.script.yaml",
  "f/factory/lib/investigate_workspace.ts",
  "f/factory/lib/investigate_workspace.script.yaml",
  "tests/lib/investigate_claude.test.ts",
  "tests/lib/claude_read_deny.test.ts",
  "tests/scripts/investigate_gate.test.ts",
  "tests/lib/investigate_workspace.test.ts",
  "f/factory/lib/investigate_isolation.ts",
  "f/factory/lib/investigate_isolation.script.yaml",
  "f/factory/lib/isolation_proof.ts",
  "f/factory/lib/isolation_proof.script.yaml",
  "f/factory/lib/investigate_isolation_gate.ts",
  "f/factory/lib/investigate_isolation_gate.script.yaml",
  "tests/lib/investigate_isolation.test.ts",
  "tests/lib/isolation_proof.test.ts",
  "tests/lib/investigate_isolation_gate.test.ts",
  "f/factory/lib/investigate_isolation_observe.ts",
  "f/factory/lib/investigate_isolation_observe.script.yaml",
  "tests/lib/investigate_isolation_observe.test.ts",
  "f/factory/lib/investigate_isolation_judge.ts",
  "f/factory/lib/investigate_isolation_judge.script.yaml",
  "tests/lib/investigate_isolation_judge.test.ts",
  "tests/scripts/investigate_isolation_probe.test.ts",
  "f/factory/steps/investigate_register.ts",
  "f/factory/steps/investigate_register.script.yaml",
  "f/factory/steps/investigate_prepare.ts",
  "f/factory/steps/investigate_prepare.script.yaml",
  "f/factory/steps/investigate_generate.ts",
  "f/factory/steps/investigate_generate.script.yaml",
  "f/factory/steps/investigate_post.ts",
  "f/factory/steps/investigate_post.script.yaml",
  "f/factory/lib/investigate_flow.ts",
  "f/factory/lib/investigate_flow.script.yaml",
  "tests/lib/investigate_flow.test.ts",
  "tests/lib/investigateTestSupport.ts",
  "tests/scripts/investigate_register.test.ts",
  "tests/scripts/investigate_prepare.test.ts",
  "tests/scripts/investigate_generate.test.ts",
  "tests/scripts/investigate_post.test.ts",
  "tests/scripts/investigate_flow.test.ts",
  "scripts/test-db-holds.ts",
  "scripts/hold.ts",
  "scripts/hold_psql.ts",
  "scripts/freeze.ts",
  "f/factory/lib/freezes.ts",
  "f/factory/lib/freeze_apply.ts",
  "tests/scripts/hold.test.ts",
  "tests/scripts/hold_psql.test.ts",
  "migrations/datatable/main/20261023131355_holds.up.sql",
  "migrations/datatable/main/20261023131355_holds.down.sql",
  "f/factory/console_jobs.ts",
  "f/factory/console_jobs.script.yaml",
  "f/factory/console_schedules.ts",
  "f/factory/console_schedules.script.yaml",
  "f/factory/console_config.ts",
  "f/factory/console_config.script.yaml",
  "f/factory/lib/console_redact.ts",
  "f/factory/lib/console_redact.script.yaml",
  "f/factory/lib/console_known_paths.ts",
  "f/factory/lib/console_known_paths.script.yaml",
  "f/factory/lib/console_actions.ts",
  "f/factory/lib/console_actions.script.yaml",
  "f/factory/lib/approver.ts",
  "f/factory/lib/approver.script.yaml",
  "f/factory/console_job_cancel.ts",
  "f/factory/console_job_cancel.script.yaml",
  "f/factory/console_job_rerun.ts",
  "f/factory/console_job_rerun.script.yaml",
  "f/factory/console_config_update.ts",
  "f/factory/console_config_update.script.yaml",
  "f/factory/console_hold_place.ts",
  "f/factory/console_hold_place.script.yaml",
  "f/factory/console_schedule_stop.ts",
  "f/factory/console_schedule_stop.script.yaml",
  "f/factory/retry_work_item.ts",
  "f/factory/retry_work_item.script.yaml",
  "f/factory/manual_intake_submit.ts",
  "f/factory/manual_intake_submit.script.yaml",
  "tests/scripts/console_cancel.test.ts",
  "tests/scripts/console_rerun.test.ts",
  "tests/scripts/console_config_update.test.ts",
  "tests/scripts/console_hold_place.test.ts",
  "tests/scripts/console_schedule_stop.test.ts",
  "tests/lib/freezes.test.ts",
  "tests/scripts/console_write_audit.test.ts",
  "tests/scripts/cleanup_db_console_actions.test.ts",
  "scripts/gen-console-known-paths.ts",
  "scripts/test-db-console-actions.ts",
  "console/src/api/windmill.ts",
  "console/src/api/windmill.test.ts",
  "tests/lib/console_redact.test.ts",
  "tests/lib/console_actions.test.ts",
  "tests/scripts/console_jobs.test.ts",
  "tests/scripts/console_schedules.test.ts",
  "tests/scripts/console_config.test.ts",
  "tests/scripts/console_known_paths.test.ts",
  "tests/scripts/console_actions_migration.test.ts",
  "tests/scripts/console_jobs_contract.test.ts",
  "tests/scripts/console_jobs_render_contract.test.ts",
  "console/src/lib/safeText.ts",
  "console/src/lib/safeText.test.ts",
  "console/src/screens/jobs/safeTextCoverage.test.tsx",
  "console/src/lib/visibleText.ts",
  "console/src/lib/visibleText.test.ts",
  "tests/scripts/console_design_visible_text_contract.test.ts",
  "console/src/designApprovalWiring.test.ts",
  "console/src/screens/inbox/DesignReview.tsx",
  "tests/scripts/console_write_contract.test.ts",
  "tests/scripts/console_worker_boundary.test.ts",
  "tests/scripts/console_script_tags.test.ts",
  "tests/scripts/worker_boundary_scan.ts",
  "migrations/datatable/main/20261026140000_console_actions.up.sql",
  "migrations/datatable/main/20261026140000_console_actions.down.sql",
  "scripts/host-apply.ts",
  "scripts/host-apply.sh",
  "scripts/host-install.sh",
  "scripts/check-docker-version.sh",
  "scripts/doctor.sh",
  "scripts/bootstrap.sh",
  "scripts/custom-tags.ts",
  "scripts/record-host-applied.sh",
  "scripts/check-idle.ts",
  "tests/scripts/check-idle.test.ts",
  "infra/docker-compose.yml",
  "tests/infra/docker_compose.test.ts",
  "tests/fixtures/host_apply_repo.ts",
  "tests/scripts/host_apply_target.test.ts",
  "tests/scripts/host_apply_imports.test.ts",
  "tests/scripts/host_apply_ci.test.ts",
  "tests/scripts/host_apply_approval.test.ts",
  "tests/scripts/host_apply_mise_policy.test.ts",
  "tests/scripts/host_apply_env.test.ts",
  "tests/scripts/host_apply_compose_policy.test.ts",
  "tests/scripts/host_apply_dryrun.test.ts",
  "tests/scripts/host_apply_git.test.ts",
  "tests/scripts/host_apply_state.test.ts",
  "tests/scripts/host_apply_notify_text.test.ts",
  "tests/scripts/host_apply_mask.test.ts",
  "tests/scripts/host_apply_timeouts.test.ts",
  "tests/scripts/host_apply_plan.test.ts",
  "tests/scripts/host_apply_package_policy.test.ts",
  "tests/scripts/host_apply_staging.test.ts",
  "tests/scripts/host_apply_drain.test.ts",
  "tests/scripts/host_apply_converge.test.ts",
  "tests/scripts/host_apply_restore.test.ts",
  "tests/scripts/host_apply_marker.test.ts",
  "tests/scripts/host_apply_lock.test.ts",
  "tests/scripts/host_apply_heartbeat.test.ts",
  "tests/scripts/host_apply_manifest.test.ts",
  "tests/scripts/host_apply_notify.test.ts",
  "tests/scripts/host_apply_approved_store.test.ts",
  "tests/scripts/host_apply_approve.test.ts",
  "tests/scripts/host_apply_approved_io.test.ts",
  "tests/scripts/host_apply_code_origin.test.ts",
  "tests/scripts/host_apply_approve_cli.test.ts",
  "tests/scripts/host_apply_secure_file.test.ts",
  "tests/scripts/host_apply_drain_store.test.ts",
  "tests/scripts/host_apply_state_io.test.ts",
  "tests/scripts/host_apply_command.test.ts",
  "tests/scripts/host_apply_git_grammar.test.ts",
  "tests/scripts/host_apply_spawn_runner.test.ts",
  "tests/scripts/host_apply_run_git.test.ts",
  "tests/scripts/host_apply_run_fetch.test.ts",
  "tests/scripts/host_apply_host_probe.test.ts",
  "tests/scripts/host_apply_compose_tables.test.ts",
  "f/factory/lib/claude.ts",
  "f/factory/lib/claude.script.yaml",
  "f/factory/lib/claude_flow_failure.ts",
  "f/factory/lib/claude_flow_failure.script.yaml",
  "f/factory/lib/flow_retry_marker.ts",
  "f/factory/lib/flow_retry_marker.script.yaml",
  "tests/scripts/claude_flow_retry.test.ts",
  "f/factory/lib/check_sandbox.ts",
  "f/factory/lib/check_sandbox.script.yaml",
  "f/factory/lib/check_runner.ts",
  "f/factory/lib/check_runner.script.yaml",
  "f/factory/lib/approval_gate.ts",
  "f/factory/lib/approval_gate.script.yaml",
  "f/factory/lib/protected_paths.ts",
  "f/factory/lib/protected_paths.script.yaml",
  "f/factory/self_update.ts",
  "f/factory/self_update.script.yaml",
  "f/factory/lib/self_update_support.ts",
  "f/factory/lib/self_update_support.script.yaml",
  "f/factory/lib/stop_check.ts",
  "f/factory/lib/stop_check.script.yaml",
  "f/factory/lib/stop_all.ts",
  "f/factory/lib/stop_all.script.yaml",
  "f/factory/console_stop_all.ts",
  "f/factory/console_stop_all.script.yaml",
  "f/factory/console_stop_all_release.ts",
  "f/factory/console_stop_all_release.script.yaml",
  "tests/lib/stop_all.test.ts",
  "tests/scripts/console_stop_all.test.ts",
  "tests/scripts/console_stop_all_release.test.ts",
  "tests/scripts/stop_all_wiring.test.ts",
  "scripts/stop_all.ts",
  "scripts/stop_all_restore.ts",
  "scripts/credential_expiry.ts",
  "f/factory/lib/credential_expiry.ts",
  "f/factory/lib/credential_expiry.script.yaml",
  "migrations/datatable/main/20261105100000_deploy_approvals.up.sql",
  "migrations/datatable/main/20261105100000_deploy_approvals.down.sql",
  "f/factory/lib/deploy_approvals.ts",
  "f/factory/lib/deploy_approvals.script.yaml",
  "tests/lib/deploy_approvals.test.ts",
  "tests/scripts/deploy_approvals_wiring.test.ts",
  "scripts/test-db-deploy-approvals.ts",
  "f/factory/lib/deploy_gate.ts",
  "f/factory/lib/deploy_gate.script.yaml",
  "tests/lib/deploy_gate.test.ts",
  "tests/scripts/self_update_deploy_gate.test.ts",
  "f/factory/console_deploy_decide.ts",
  "f/factory/console_deploy_decide.script.yaml",
  "tests/scripts/console_deploy_decide.test.ts",
];

/**
 * pr_fixが保護するファイル名(ディレクトリを問わない)。
 * markdownlint-cli2とtextlintの設定も含める。どちらも設定から任意のモジュールを読み込めて、
 * pre-commitと`mise run check`が読むので、書き換えられるとコードを実行されるため。
 * ホストの実行役が動かすmise、bun、nodeの設定も含める(`.tool-versions`、`.node-version`、`.bun-version`、
 * `.env`系)。ツールの版と環境変数を変えると、実行役が動かす道具の中身が変わる。
 * wmillの設定(`wmill.yaml`と別名の`wmill.yml`)もどのディレクトリでも含める。
 * Factoryが扱う他のリポジトリのサブディレクトリの`wmill.yaml`も止まるが、安全側として受け入れる。
 * `wmill-lock.yaml`は一致しない。
 * implementの一覧は、この一覧を引き継ぐ。
 */
export const FORBIDDEN_BASENAME_PATTERNS: readonly RegExp[] = [
  /^wmill\.ya?ml$/,
  /^mise\.toml$/,
  /^mise\..*\.toml$/,
  /^\.mise\.toml$/,
  /^lefthook\.yml$/,
  /^lefthook-local\.yml$/,
  /^lefthook\.toml$/,
  /^lefthook\.json$/,
  /^bunfig\.toml$/,
  /^\.npmrc$/,
  /^\.gitattributes$/,
  /^\.gitmodules$/,
  /^\.markdownlint(-cli2)?\.(jsonc?|ya?ml|[cm]?js)$/,
  /^\.textlintrc(\..*)?$/,
  /^\.tool-versions$/,
  /^\.env(\..*)?$/,
  /^\.(node|bun)-version$/,
];

/**
 * implementフローが保護するディレクトリで、pr_fixの一覧に次を加えたもの。
 * - pr_fixの一覧の`.github/workflows/`を、`.github/`全体(actions、dependabot、CODEOWNERS)に広げる。
 * - `infra/**`: workerのイメージとcomposeの定義。変更は次にホスト側で
 *   `mise run up`するまで反映されないため、レビューする人が知る必要がある。
 * - gitフックのディレクトリ(`.husky/`、`.githooks/`)
 * - `.yarn/`: パッケージマネージャーが実行するプラグインとリリース
 * - `.devcontainer/`
 *
 * implementフローはClaudeの変更に対して検査コマンドを実行するため、
 * 検査コマンドが何を実行するかを決めるディレクトリを保護する。pr_fixの一覧は変えない。
 */
export const IMPLEMENT_PROTECTED_PATH_PREFIXES: readonly string[] = [
  ...FORBIDDEN_PATH_PREFIXES.filter(
    (prefix) => prefix !== ".github/actions/",
  ).map((prefix) => (prefix === ".github/workflows/" ? ".github/" : prefix)),
  "infra/",
  ".husky/",
  ".githooks/",
  ".yarn/",
  ".devcontainer/",
];

/** implementフローが保護する個別のファイル。pr_fixの一覧と同じ。 */
export const IMPLEMENT_PROTECTED_EXACT_PATHS: readonly string[] = [
  ...FORBIDDEN_EXACT_PATHS,
];

/**
 * implementフローが保護するファイル名。
 * pr_fixのリスト(envファイルと`.tool-versions`などのバージョン指定を含む)に、
 * 検査コマンドが何を実行し何を信頼するかを決めるファイルをすべて加える
 * (gitleaksの設定、ほかのランタイム・ツールチェーンのバージョン指定、
 * パッケージマネージャーの設定とロックファイル、ツールの設定モジュールとrcファイル、
 * タスクランナー、`scripts`に限らず`package.json`全体)。
 */
export const IMPLEMENT_PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_BASENAME_PATTERNS,
  /^\.gitleaks(ignore|\.toml)$/,
  /^\.python-version$/,
  /^\.nvmrc$/,
  /^rust-toolchain(\.toml)?$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.pnpmfile\.cjs$/,
  /^(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^[\w.-]+\.config\.[cm]?[jt]s$/,
  /^\.(eslintrc|babelrc|prettierrc)(\..*)?$/,
  /^(Makefile|[Jj]ustfile|Taskfile\.ya?ml|turbo\.json|nx\.json|deno\.jsonc?|CODEOWNERS|\.pre-commit-config\.yaml)$/,
  /^package\.json$/,
  // JS以外のロックファイルとマニフェスト。インストール時に、記載された
  // ビルドスクリプトや`setup.py`が実行され、固定したものが取得される。
  /^(uv|poetry)\.lock$/,
  /^Pipfile(\.lock)?$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
  /^requirements.*\.txt$/,
  /^Cargo\.(lock|toml)$/,
  /^go\.(sum|mod)$/,
  /^Gemfile(\.lock)?$/,
  /^composer\.(lock|json)$/,
];

// 無視される文字(ゼロ幅文字、異体字セレクタなど)。見た目では区別できない別名を、安全側に倒して潰す。
const IGNORABLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * パスを、大文字小文字とUnicodeの別名を区別しない形にそろえる。
 * ホストのファイルシステム(macOSのAPFSの既定)は、大文字小文字を区別せず、
 * 長いsやケルビン記号のような、大文字小文字の畳み込みで同じになる文字も同じ名前に潰す。
 * 全角文字や無視される文字の除去は、APFSが潰すとは限らないが、紛らわしい別名を安全側で止めるために行う。
 * 小文字、大文字、小文字の順に変換するのは、大文字のエスツェット(ẞ)のような、
 * 1回の往復では`ss`に畳まれない文字も畳み込んで、結果を冪等にするためである。
 * 最後にNFKCを掛け直して、変換で生じた分解形をそろえる。
 */
export function foldPath(path: string): string {
  return path
    .replace(IGNORABLE_CHARACTERS, "")
    .normalize("NFKC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");
}

const foldedListCache = new WeakMap<readonly string[], readonly string[]>();

function foldedList(list: readonly string[]): readonly string[] {
  const cached = foldedListCache.get(list);
  if (cached !== undefined) return cached;
  const folded = list.map(foldPath);
  foldedListCache.set(list, folded);
  return folded;
}

const insensitivePatternCache = new WeakMap<RegExp, RegExp>();

// 畳み込んだ名前に当てるので、大文字を含む正規表現も大文字小文字を区別しない形にする。
function insensitivePattern(pattern: RegExp): RegExp {
  const cached = insensitivePatternCache.get(pattern);
  if (cached !== undefined) return cached;
  const flags = pattern.flags.includes("i")
    ? pattern.flags
    : `${pattern.flags}i`;
  const insensitive = new RegExp(pattern.source, flags);
  insensitivePatternCache.set(pattern, insensitive);
  return insensitive;
}

function matchesPathLists(
  path: string,
  prefixes: readonly string[],
  exactPaths: readonly string[],
  basenamePatterns: readonly RegExp[],
): boolean {
  const normalized = foldPath(path).replace(/^\.\//, "");
  if (foldedList(exactPaths).includes(normalized)) return true;
  for (const prefix of foldedList(prefixes)) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  // 正規化は`/`を作ったり文字を合成したりして、ファイル名の切り出しを変えうる。
  // 畳み込み後のパスから切ったもの、元のパスから切ったもの、それを畳み込んだものの
  // どれかが当たれば一致とし、畳み込む前の判定より狭くならないようにする。
  const rawBasename = path.split("/").pop() ?? path;
  const candidates = [
    normalized.split("/").pop() ?? normalized,
    foldPath(rawBasename),
    rawBasename,
  ];
  return basenamePatterns.some((pattern) => {
    const insensitive = insensitivePattern(pattern);
    return candidates.some((candidate) => insensitive.test(candidate));
  });
}

/**
 * `path`がdocs/security.md「PR修正の安全策」の禁止パスに当たるかを返す。
 * 照合は、大文字小文字とUnicodeの別名を区別しない(`foldPath`)。
 * `prefixes`のディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する
 * (ディレクトリ名そのものも一致とみなす)。
 * `FORBIDDEN_EXACT_PATHS`とは完全一致で、`FORBIDDEN_BASENAME_PATTERNS`は
 * ディレクトリを問わずファイル名で判定する。
 * `prefixes`の既定はpr_fixのリスト。
 */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  return matchesPathLists(
    path,
    prefixes,
    FORBIDDEN_EXACT_PATHS,
    FORBIDDEN_BASENAME_PATTERNS,
  );
}

/**
 * `path`がimplementフローの保護パスに当たるかを返す。
 * 判定の規則は`matchesForbiddenPath`と同じで、リストに
 * `IMPLEMENT_PROTECTED_PATH_PREFIXES`と`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`を使う。
 * `IMPLEMENT_PROTECTED_EXACT_PATHS`とは完全一致で判定する。
 */
export function matchesImplementProtectedPath(path: string): boolean {
  return matchesPathLists(
    path,
    IMPLEMENT_PROTECTED_PATH_PREFIXES,
    IMPLEMENT_PROTECTED_EXACT_PATHS,
    IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  );
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
}
