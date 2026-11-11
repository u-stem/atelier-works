// 保留(hold)を置く・解除する操作を見分ける。
// 保留は、Factoryの自動マージなどを止める印である。subagentは置かず、解除もしない。
// 主セッションか人に頼む。許すのは一覧(`list`)と、保留のコードの検査だけである。
// 呼び出し側(`bash-guard.ts`)は、主セッションにも同じ判定を当てる。
// 主セッションは、`mise run <タスク>`の単独の行1つだけを、この判定の前に免除する。
// 凍結のCLI(`freeze:place`、`freeze:release`、`freeze:reset`、`push:prune`、`scripts/freeze.ts`)も、
// 人の端末の確認を通る書き込みは同じ扱いにする。
// - deployの保留を置く操作(`place`の`--scope deploy`)。反映全体を止めるためである。
//   スケジュールの凍結を置く操作(`--scope`が無いか`schedule`)は許す。
// - 凍結の解除(`release`)。deployの保留を外せるためである。
// - 凍結の全消去(`reset`)。deployの保留も消えるためである。
// - 削除を確定する押し出し(`push --prune`)。
// 一覧と検査(`list`、`check`)と、削除を確定しない押し出し(`push`、`push --dry-run`)は許す。
// `--scope`の値が実行時に決まる形(変数、コマンド置換、glob)は、`deploy`かを判定できないので拒否する。
// 凍結のCLIを指す語は、直後の`--`を読み飛ばして副コマンドを決め、globは凍結のファイル名に当たるかで判定する。
// `-e`の直後の文字列と標準入力のコードは、凍結のCLIを指しながら`release`、`deploy`、`reset`、`prune`を含めば拒否する。
// 空白か、シェルが語を分けるか展開する字を含む語も、コードを取るオプションの種類を問わず同じに見る。凍結のCLIの理由の値は見ない。
// 標準入力へ流し込むファイル(`bun run - < scripts/freeze.ts`)が保留か凍結のコードなら拒否する。
//
// Consoleの書き込みのscript(`console-scripts.ts`の一覧。保留と凍結の解除、ジョブの取消など)を1コマンドで呼ぶ形は、
// 主セッションを含むすべてのセッションで拒否する(`findConsoleReleaseCall`)。ローカルの主セッションはCLIでは`session`として
// 扱われ、人の解除には端末での確認が要るが、Consoleのscriptはその確認を通らずに他の主体の保留を外せる。
// 取消などの書き込みも、運用者がConsoleの確認のダイアログを通す操作で、セッションが直接呼ぶと、その確認を通らないためである。
// 書き込みのscriptの名前を軸に、拒否を既定にする。プログラムの種類を問わず、語、変数代入の値、標準入力の文字列に、
// 名前、名前に当たりうるglob、ブレースの形があれば拒否する。標準入力の文字列は、パイプの連鎖の上流まで辿る。
// 読み取りなどのプログラム(`git`、`grep`、`cat`など)は、名前だけでは通す。同じコマンドに実行を表す語(`wmill`、`curl`、`npx`、`sh`など)が
// 並ぶとき、実行を委ねるオプション(一覧の外のキーの`git -c`、`rebase`、`gh alias set`、`rg --pre`)があるとき、変数代入の値に名前があるときは拒否する。
// `wmill`が解除scriptを実行せずに読む・配る副コマンド(`script get`、`job list`、`script push`など)は通す。
// パイプの上流の語にある名前は、`xargs`が受ける読み取りのプログラムと、`wmill`と、実行するプログラムに当てる。
// `wmill jobs push`は、待ち行列のファイルからジョブを積み、名前が語に現れないので、名前なしで拒否する。
// 凍結の変数`f/factory/freezes`、全停止の変数`f/factory/stop_all`、全停止が止めた名前の記録`f/factory/stop_all_record`は、
// `variable add/push`の語と、変数を書くURLの経路に、そのパスが当たるときに拒否する。
// 解除は、人がConsoleの画面で行うか、端末で確認を通るCLIで行う。
//
// 全停止のCLI(`scripts/stop_all.ts`)の実行と、`mise run stop`、`mise run stop:release`、`mise run stop:restore`は、
// 主セッションを含むすべてのセッションで拒否する(`findStopAllCall`)。
// CLIは`CLAUDECODE`があれば断るが、環境変数を外せば迂回できるので、ここでも止める。
// 全停止の入口は、プログラムの種類を問わず、どの語(`script -c`などのコマンド文字列の中も含む)に現れても拒否する。
// `script`、`unbuffer`、`caffeinate`のような前置きの後ろでも止める。
// 読み取りのプログラム(`NON_EXECUTING_PROGRAMS`)と検査の道具は、入口の名前が語にあっても通す。
// ただし、読み取りのプログラムでも、実行を委ねる形(`delegatesExecution`)は通さず、委ねる先を字面でも見る。
// 語と標準入力の文字列に、全停止のCLIを指す語か、`mise`と全停止のタスク名が並ぶ字面があれば拒否する。
// 語の値の部分(`--opt=<値>`、`<キー>=<値>`、ページャーの初期コマンド、`!<値>`)も、値を語として判定する。
//
// 保留と凍結の判定は、語の字面で行う。コマンドの語にオプションの値や実行の前置きが混ざる形は無数にあり、
// 値を取るオプションの一覧を読み飛ばす方式は、一覧に無いオプションで破られるためである。
// 先頭の語で、次の5つの規則のどれかに分ける。どれにも当たらない先頭の呼び出しは、判定の対象にしない。
//
// - 実行系(`bun`、`bunx`、`node`、`tsx`、`ts-node`、`deno`、`npx`、`npm`、`pnpm`、`pnpx`、`yarn`)と、
//   スクリプトを直接実行する形: 語のどれかが保留のコード(`hold`、`hold_psql`、`holds`。拡張子は省略できる)を指していれば拒否する。
//   `bun`は拡張子の無いパスを`hold.ts`に解決するので、拡張子の有無は区別しない。
//   引用符の外のglob(`scripts/hol?.ts`、`scripts/hol[d].ts`、`scripts/*`)は、ファイル名の部分が保留のコードの名前に当たりうれば拒否する。
//   ディレクトリは見ない。POSIXの文字クラス(`[[:lower:]]`)は読み解かず、当たりうるものとして扱う。
//   ブレース(`{hold.ts,place}`)は、展開した綴りと、空白に置き換えた綴りの両方で判定する。
//   カンマの無いブレースの範囲(`{o..o}`)は、展開される字の集合(英字は`[o-o]`、数は`[0-9]*`)に置き換えてglobと同じに照合する。
//   NULを含む`$'...'`の語は、切り詰めた綴りと、切り詰めない綴り(`variants`)の両方で判定する。
//   `-e`などの文字列と標準入力で渡すコードに含まれる場合も同じである。
//   許すのは次の2つだけである。
//   (a) `hold`を指す語の直後の語が`list`である。
//   (b) 最初のオペランドが検査の道具(`test`、`biome`、`@biomejs/biome`、`tsc`、`scripts/lint-*.ts`)である。
//       実行ではなく検査なので、`bunx biome check scripts/hold.ts`は止めない。
//       版付きの名前(`@biomejs/biome@1.9.4`)と、実行系のオプション(`--bun`、`--yes`、`-y`)の後ろも同じに扱う。
// - `mise`: 全体オプション(`-q`、`-C <dir>`など)を読み飛ばしたあとの、何かを実行するサブコマンド
//   (`run`、`r`、`tasks run`、`watch`、`w`、`exec`、`x`)かタスク名(コロンを含む語)があるコマンド行に、
//   `hold:place`か`hold:release`を指しうる語が1つでもあれば、位置を問わず拒否する。
//   `tasks`の後ろは、オプションとその値を読み飛ばした最初の語が、実行時に決まる語か、実行の語に当たりうるglobかブレースなら、実行として扱う。
//   `hold:`で始まる`hold:list`以外の語、globや文字クラスが当たる語、実行時に決まる語、ブレースを含む語が、これに当たる。
//   `--`より後ろはタスクへの引数なので、glob、ブレース、実行時に決まる語は見ない。`hold:`で名指しする語は見る。
//   一覧に無い長いオプション(`=`の無いもの)があれば、サブコマンドの位置が決まらないので、コマンド全体を拒否する。
//   `exec`か`x`が語にあれば、位置を問わず、その後ろを実行系のコマンドとして判定する。
//   `mise exec`の中のコマンドは、呼び出し側が前置きを外したあとの語として判定する。
//   タスク`push`に`--prune`を渡す形(`mise run push -- --prune`)は、`push:prune`と同じなので拒否する。
// - `docker`、`docker-compose`、`psql`: 語か標準入力の文字列に`holds`を含めば拒否する。
// - 前置き: 先頭が`script`、`unbuffer`、`caffeinate`、`/usr/bin/time`、`ssh`のどれかである。
//   前置きの後ろは、語、`script -c`と`ssh`の文字列の中身、標準入力の文字列(ヒアドキュメント、ヒアストリング、
//   `echo`と`printf`のパイプ)を、次の順で調べる。オプションの文法は追わない。
//   (a) 語を足すコマンド(`xargs`、`parallel`、`-exec`系の式を伴う`find`)、シェル、読めない標準入力があれば、
//       指す語の有無によらず拒否する。足される語やシェルの引数は、字面から読めないためである。
//       読めない標準入力は、`script`か`ssh`に、ファイルや、`echo`と`printf`以外のパイプや、実行時に決まる文字列が入る形である。
//       前置きの前の`xargs`が標準入力の語を足す形(`viaXargs`)も同じに扱う。
//   (b) 前置きの後ろの`mise`、実行系、`docker`、`psql`は、その位置から先頭のときと同じ分岐で判定し直す。
//       起動語は16個まで見て、超えたら拒否する。
//       保留と凍結のCLIの直接実行(`script -q /dev/null ./scripts/hold.ts release 1`)は、(c)の共起で見る。
//   (c) 起動語の外にある語は、共起で見る。指す語(保留か凍結のコードを指す語、書き込みのタスク名)と、
//       書き込みの語(`place`、`release`、`reset`、`prune`、`--prune`、`deploy`)が、同じコマンドの語とパイプの上流の語の和にあれば拒否する。
//       語の綴り(ブレースの展開を含む)の完全一致で数え、位置は見ない。
//       指す語があり、ほかに実行時に決まる語、glob、ブレースがあれば、拒否する。
//       凍結の`place`と`deploy`は共起の語に数えず、`--scope`の値を別に判定する。
//       スケジュールの凍結を置く形(`freeze:place -- --target a/b`)と、`list --scope deploy`は通す。
//   (d) 空白か、シェルが語を分けるか展開する字を含む語(`script -c`や`ssh`の文字列など)と標準入力の文字列は、コマンドとして読み、内側のコマンドごとに判定し直す。
//       結果は足し合わせない。内側が読み取りの道具(`rg -n release scripts/hold.ts`)なら通す。
//       内側の先頭が`mise`、実行系、`docker`、`psql`でも、語を足すコマンドとシェルの規則は重ねて当てる。
//       内側の先頭の変数代入は前置きとして外れるが、値がコマンドとして実行されうるので、値を先頭の語として判定する。
//       値が保留か凍結のコードを指すときと、起動語(実行系、`mise`、`docker`と`psql`、前置き、シェル)のときに、後ろの語を引数として付ける。全停止も同じである。
//       内側の`xargs`が足す語は、先頭が何でも読めないので拒否する。
//       標準入力の文字列は、最上位でも入れ子でも同じに判定する。
//       コマンド文字列は4段の入れ子まで読む。段を超えた文字列と読めない文字列は、字面で判定する。
//       標準入力の文字列の字面は、保留か凍結のコードを指す字面と書き込みの語が並ぶときだけ拒否する。
//       読む文字列の数と長さの合計にも上限を置き、超えたら拒否する。フックのタイムアウトの中で終えるためである。
//       語の値の部分(`--opt=<値>`、`<キー>=<値>`、ページャーの初期コマンド、シェルの別名の`!<値>`)も、語が同じ字を含めばコマンドとして読む。
//       字は、空白、`$`、バッククォート、`;`、`|`、`&`、`<`、`>`と、`{`と`}`の間に`,`か`..`がある形である。
//       起動語が前の部分に隠れると、(b)が当たらないためである。
//   前置きの後ろでは、実行の字面が引数にある形(`git commit -m "… hold.ts release …"`)や、シェルを使う正当な作業も拒否する。
//   実行と区別できないためである。
// - 実行を委ねる呼び出し: 先頭が読み取りの道具で、別のコマンドの実行を委ねる副コマンド、設定、オプションを持つ形(`delegatesExecution`)。
//   前置きと同じ規則で、先頭の次の語から調べる。実行の字面が引数にある形を拒否するのも、前置きと同じである。
//   `git -c`は、値がコマンドとして実行されないキーの閉じた一覧だけを委ねない形とし、一覧の外のキーは委ねる形とする。
//   gitの副コマンドとグローバルのオプションも、委ねないと分かっている閉じた一覧の外は委ねる形とする。オプションは省略形を前方一致で見る。
//   委ねる形でも、語を足すコマンドやシェルの名前で終わる語が無く、保留と凍結を指す語が無ければ通す。
//   前置きの無い形は、上の4つの規則と、次の2つの規則に当たらない限り、判定の対象にしない。
//
// 前置きの無い形に当てる2つの規則は、先頭のプログラムが何でも当てる。
// 語を足す文脈は、指す語の有無を見ずに拒否する。代入の値は、値の字面だけを見る。
// - 語を足す文脈: `xargs`、`find`の実行系の式(各式の`;`か`+`までの区間)、先頭の`parallel`、`watch`、`strace`。
//   足される語は字面から読めないので、実行される側が読み取りの閉じた集合(`WORD_ADDER_SAFE_PROGRAMS`)に入らなければ拒否する。
//   指す語、glob、パイプの上流は見ない。
//   実行される側は、`xargs`では`stripWrappers`の後の先頭の語、`find`では各式の先頭の語である。
//   `xargs`のオプションに知らないものがあるとき、置換のオプションかGNUの省略できる値を取るオプションがあるとき、後ろに前置きが続くときは、
//   実行される側が先頭の語に決まらないので拒否する。
//   `parallel`、`watch`、`strace`は例外を作らず、常に拒否する。
//   `xargs`の後ろでは、標準入力からオプションが届くので、検査の道具を通さない。
//   `find`の後ろに限り、プログラム自身が検査の道具である形(`tsc`、`biome`)と、その実行系を通す。
//   実行系の最初のオペランドが、リポジトリの検査用スクリプト(`scripts/lint-*.ts`)の形でも通す。
//   `node`、`tsx`、`ts-node`、`deno`は最初のオペランドをファイルとして実行するので、
//   探索先に検査の道具と同じ名前のファイルがあると、それが実行される。新しいファイルを書いて実行する形として受け入れる。
//   `find`が探索で見つけたパスは、起点を前に付けて渡すので`-`から始まらない。
//   コマンド行に書いた起点は綴りのまま渡り、道具のオプションとして読まれうる。
//   `tsc`と`biome`のオプションは、実行や保留の操作に届かないので受け入れる。
//   テストのファイルを読み込んで実行する形(`test`を最初のオペランドとする実行系)は、`find`の後ろでも通さない。
//   集合は、引数で実行を委ねる機能を持たない道具だけに閉じる。要素から実行に届く経路が見つかったら、その要素を外す。
// - 変数代入の値: 先頭の代入の値が、保留か凍結のコードを指す字面か、書き込みのタスク名を含めば、実行する側によらず拒否する。
//   値に、2度目のシェルが語を変える字(引用符、バックスラッシュ、globの字、ブレース)が残っていても、読めない値として拒否する。
//   ページャーなどの環境変数は、値をコマンドとして実行できるためである。
//
// 判定には締め切りがあり、`evaluateBashGuard`の開始から数える。超えたら`dynamic`で拒否する。
// 同期の判定は途中で止められず、フックのタイムアウトを超えると拒否にならないためである。時計は注入できる。
//
// ベストエフォートの規則で、境界ではない。次は止めない。
// - Consoleの解除scriptを、名前を直接書かない呼び出しで呼ぶ形(別の識別子、符号化した綴り、実行時に組み立てた名前)。
// - 別名の呼び出しと、保留のコードを書き換えてから起動する形。
// - 実行時に組み立てたパス、動的なimport、docker経由でpsqlに渡す語を組み立てる形。
// - シェルの`-c`と標準入力、起動語の一覧に無いインタプリタが受け取る文字列。ストリームエディタの実行の命令も同じである。
// - subagentが新しいファイルを書いて実行する形。
// 次は誤検知として受け入れ、拒否する。
// - 語を足す文脈の後ろの、集合の外のプログラム。編集の道具、権限や形式を変える道具、gitなどである。読み取りだけの呼び出しでも拒否する。
// - 代入の値に、保留や凍結を指す語や、引用符などの字を含む形。後ろのプログラムが実行しなくても拒否する。
// - 置換のオプション、GNUの`-e`と`-l`、知らないオプションを付けた`xargs`と、`xargs`の後ろに前置きが続く形。
// Bashとdockerを持つ主体は、psqlで保留を直接書ける。ここで止めるのは、誤操作と、拒否を知らない呼び出しである。

import { posix } from "node:path";
import { CONSOLE_WRITE_SCRIPTS } from "./console-scripts.ts";
import {
  baseName,
  literalShellInputs,
  parseCommandLine,
  readShellLaunch,
  SHELLS,
  type SimpleCommand,
  scanMiseGlobalOptions,
  shellInvocation,
  stripWrappers,
  type Word,
} from "./shell-words.ts";

/**
 * 拒否の種類。
 * `dynamic`は、実行時に決まる語のせいで判定できないこと。
 * `option`は、`mise`の知らないオプションのせいで、サブコマンドの位置が決まらないこと。
 * `prefix`は、前置きの後ろの語を足すコマンド、シェル、読めない標準入力のせいで、何が実行されるか読めないこと。
 * `context`は、前置きの無い語を足す文脈(`xargs`、`find`の実行系の式、`parallel`、`watch`、`strace`)で、
 * 実行される側が読み取りの閉じた集合に入らないこと。
 * `assignment`は、先頭の変数代入の値が、保留か凍結のコードか書き込みのタスク名を指すこと。
 */
export type HoldFinding =
  | "operation"
  | "prefix"
  | "context"
  | "assignment"
  | "dynamic"
  | "option";

/** スクリプトを実行するプログラム。 */
const RUNNERS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "node",
  "tsx",
  "ts-node",
  "deno",
  "npx",
  "npm",
  "pnpm",
  "pnpx",
  "yarn",
]);

/**
 * 保留のコードを指すパスの末尾。区切り(行頭、`/`、引用符、バッククォート、空白、括弧、`=`、`,`、`[`、`{`)の直後の
 * `hold`、`hold_psql`、`holds`で、拡張子は省略できる。
 * `hold.test.ts`、`holds_db.test.ts`、`hold-guard.ts`、`holds.md`のような別のファイルには当たらない。
 * 区切りを閉じた集合にするのは、`:`や`@`や`+`の後ろの、タスク名やパッケージ名の一部を指す語に数えないためである。
 */
const HOLD_MENTION =
  /(?:^|[/'"`\s(=,[{])(?:hold|hold_psql|holds)(?:\.[cm]?[jt]sx?)?(?![A-Za-z0-9_.-])/i;

/**
 * 凍結のCLIを指すパスの末尾。保留のコードと同じ区切りの直後の`freeze`で、拡張子は省略できる。
 * `freeze.test.ts`、`freezes.ts`、`freeze_apply.ts`のような別のファイルには当たらない。
 */
const FREEZE_MENTION =
  /(?:^|[/'"`\s(=,[{])freeze(?:\.[cm]?[jt]sx?)?(?![A-Za-z0-9_.-])/i;

/** `hold`だけを指すパス(`hold_psql`と`holds`は含まない)。 */
const HOLD_CLI = /^(?:.*\/)?hold(?:\.[cm]?[jt]sx?)?$/i;

/** 保留のコードのファイル名。globが当たるかを見る対象である。 */
const HOLD_FILE_NAMES: readonly string[] = [
  "hold",
  "hold.ts",
  "hold_psql",
  "hold_psql.ts",
  "holds",
  "holds.ts",
];

const GLOB_CHARACTERS = /[*?[]/;

/** 版の接尾辞(`@1.9.4`)。先頭の`@`(スコープ)には当たらない。 */
const VERSION_SUFFIX = /(?<=.)@[^@/]*$/;

/** 検査の道具の前に置ける、実行系のオプション。 */
const RUNNER_FLAGS: ReadonlySet<string> = new Set(["--bun", "--yes", "-y"]);

/** 最初のオペランドとして許す、検査の道具。 */
const INSPECTION_TOOLS: ReadonlySet<string> = new Set([
  "test",
  "biome",
  "@biomejs/biome",
  "tsc",
]);

/** 実行系の、検査の道具の前に置ける実行の語。 */
const RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "run",
  "x",
  "exec",
  "dlx",
]);

/** 検査の道具として許すリポジトリのlintスクリプト。 */
const LINT_SCRIPT = /^(?:\.\/)?scripts\/lint-[a-z-]+\.ts$/;

/** 置く・解除するmiseのタスク。 */
const HOLD_WRITE_TASKS: readonly string[] = ["hold:place", "hold:release"];

/**
 * 凍結を置くmiseのタスク(`--scope deploy`のときだけ拒否する)と、
 * 端末の確認を通る書き込みのタスク(解除、全消去、削除を確定する押し出し。常に拒否する)。
 */
const FREEZE_PLACE_TASK = "freeze:place";
const FREEZE_RELEASE_TASK = "freeze:release";
const FREEZE_RESET_TASK = "freeze:reset";
const PUSH_PRUNE_TASK = "push:prune";

/** 押し出しのタスク。`--prune`を付けると、削除を確定する`push:prune`と同じ操作になる。 */
const PUSH_TASK = "push";

/** 常に拒否する、凍結と押し出しの書き込みのタスク。 */
const FREEZE_WRITE_TASKS: readonly string[] = [
  FREEZE_RELEASE_TASK,
  FREEZE_RESET_TASK,
  PUSH_PRUNE_TASK,
];

/** `mise`で何かを実行するサブコマンドとその別名。 */
const MISE_RUNNING_WORDS: ReadonlySet<string> = new Set([
  "run",
  "r",
  "watch",
  "w",
  "exec",
  "x",
]);

/** `mise tasks`とその別名。`run`が付かない限り、タスクの一覧や情報を出すだけである。 */
const MISE_TASKS_WORDS: ReadonlySet<string> = new Set(["tasks", "task", "t"]);

/**
 * `args`の先頭が`mise tasks`の語のとき、後ろのmiseのオプションとその値を読み飛ばした最初の語が、
 * 実行時に決まる語か、実行の語(`MISE_RUNNING_WORDS`)に当たりうるglobかブレースなら真。
 * 字のままの語は、呼び出し側が実行の語との完全一致で見る。`mise tasks <タスク名>`は定義を表示するだけなので、実行に数えない。
 */
function miseTasksRunsUnreadably(args: readonly Word[]): boolean {
  const first = args[scanMiseGlobalOptions(args, 1).next];
  if (first === undefined || !isUnreadable(first)) return false;
  if (first.dynamic) return true;
  const forms = spellings(first).flatMap((text) => [
    text,
    ...(rangeAsGlob(text) ?? []),
  ]);
  return forms.some((form) =>
    [...MISE_RUNNING_WORDS].some((running) => globMatches(form, running)),
  );
}

/** `docker`と`psql`の呼び出しとして、語に`holds`を含むかを見るプログラム。 */
const SQL_PROGRAMS: ReadonlySet<string> = new Set([
  "docker",
  "docker-compose",
  "psql",
]);

/**
 * シェルのglob(`*`、`?`、`[...]`)を、正規表現にする。
 * 閉じていない`[`は、その文字そのものとして扱う。
 */
function globToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern.charAt(at);
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[") {
      const end = classEnd(pattern, at);
      if (end === -1) {
        source += "\\[";
      } else {
        source += classSource(pattern.slice(at + 1, end));
        at = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

/** `[`の位置から、対応する`]`の位置を返す。無ければ-1を返す。先頭の`!`、`^`と、その直後の`]`は文字として読む。 */
function classEnd(pattern: string, open: number): number {
  let at = open + 1;
  if (pattern.charAt(at) === "!" || pattern.charAt(at) === "^") at += 1;
  if (pattern.charAt(at) === "]") at += 1;
  return pattern.indexOf("]", at);
}

function classSource(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = (negated ? body.slice(1) : body).replace(/[\\\]^[]/g, "\\$&");
  return `[${negated ? "^" : ""}${members}]`;
}

/** globが候補に当たるなら真。正規表現にできない書き方は、当たりうるものとして真を返す。 */
function globMatches(
  pattern: string,
  candidate: string,
  ignoreCase = false,
): boolean {
  // `[:lower:]`、`[=o=]`、`[.o.]`のPOSIX文字クラスは、括弧の中のどこにあっても読み解かず、当たりうるものとして扱う。
  if (/\[[:=.]/.test(pattern)) return true;
  try {
    return globToRegExp(pattern, ignoreCase).test(candidate);
  } catch {
    return true;
  }
}

/** `{a,b}`の最初の組を、`{`の位置、`}`の位置、候補に分ける。カンマの無い組は展開されないので、飛ばす。 */
function findBraceGroup(
  text: string,
): { start: number; end: number; parts: string[] } | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text.charAt(start) !== "{") continue;
    let depth = 0;
    let from = start + 1;
    const parts: string[] = [];
    for (let at = start; at < text.length; at += 1) {
      const char = text.charAt(at);
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          if (parts.length === 0) break;
          parts.push(text.slice(from, at));
          return { start, end: at, parts };
        }
      } else if (char === "," && depth === 1) {
        parts.push(text.slice(from, at));
        from = at + 1;
      }
    }
  }
  return null;
}

/** ブレース展開した綴りを返す。数が増えすぎないよう、上限で切る。 */
function expandBraces(text: string, limit = 64): string[] {
  const group = findBraceGroup(text);
  if (group === null) return [text];
  const out: string[] = [];
  for (const part of group.parts) {
    const replaced =
      text.slice(0, group.start) + part + text.slice(group.end + 1);
    for (const expanded of expandBraces(replaced, limit)) {
      out.push(expanded);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * 語が取りうる綴りをすべて返す。
 * NULを含んでいた語の別の綴り(`variants`)と、ブレースを含む語の展開した綴りを足す。
 * ブレースは、`{`、`}`、`,`を空白に置き換えた形も足す。語を分けるシェルの展開があるためである。
 */
function spellings(word: Word): readonly string[] {
  const cached = SPELLINGS.get(word);
  if (cached !== undefined) return cached;
  const base = [word.text, ...(word.variants ?? [])];
  const braced = base
    .filter((text) => text.includes("{"))
    .flatMap((text) => [text.replace(/[{},]/g, " "), ...expandBraces(text)]);
  const all = [...base, ...braced];
  SPELLINGS.set(word, all);
  return all;
}

/** 語ごとの綴りの記録。同じ語を前置きの判定と起動語の判定で何度も見るので、ブレースの展開は1回にする。 */
const SPELLINGS = new WeakMap<Word, readonly string[]>();

/** カンマの無いブレースの範囲(`{a..c}`、`{1..9..2}`)。括弧の中を取り出す。シェルは字や数の並びに展開する。 */
const BRACE_RANGES = /\{([^{},\s]*\.\.[^{},\s]*)\}/g;

/**
 * 範囲の括弧の中を、展開される字の集合のglobにする。英字の範囲は`[x-y]`、数の範囲は桁数が決まらないので`[0-9]*`である。
 * 増分(`..2`)は読まず、端点の間の字を全部含める。シェルが範囲として展開しない形はnullを返す。
 */
function rangeGlob(inner: string): string | null {
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.[-+]?\d+)?$/.exec(inner);
  if (letters?.[1] !== undefined && letters[2] !== undefined) {
    const [low, high] = [letters[1], letters[2]].sort();
    return `[${low}-${high}]`;
  }
  return /^[-+]?\d+\.\.[-+]?\d+(?:\.\.[-+]?\d+)?$/.test(inner)
    ? "[0-9]*"
    : null;
}

/**
 * 範囲を展開される字の集合(`rangeGlob`)に置き換えた綴りを返す。置き換える範囲が無ければnullを返す。
 * 置き換えた綴りは、globと同じ照合に通す。
 */
function rangeAsGlob(text: string): string | null {
  let replaced = false;
  const glob = text.replace(BRACE_RANGES, (whole: string, inner: string) => {
    const set = rangeGlob(inner);
    if (set === null) return whole;
    replaced = true;
    return set;
  });
  return replaced ? glob : null;
}

/**
 * 語が`mention`に当たるか、引用符の外のglobかブレースの範囲が`names`に当たりうるなら真。ディレクトリは問わない。
 * 範囲は展開される字の集合に置き換えるので、数の範囲(`{1..3}`)は英字の名前に当たらない。
 */
function pointsAtCode(
  word: Word,
  mention: RegExp,
  names: readonly string[],
): boolean {
  const all = spellings(word);
  if (all.some((text) => mention.test(text))) return true;
  const fileOf = (text: string) => text.slice(text.lastIndexOf("/") + 1);
  if (
    word.glob &&
    all.some((text) =>
      names.some((name) => globMatches(fileOf(text), name, true)),
    )
  ) {
    return true;
  }
  return all.some((text) => {
    const ranged = rangeAsGlob(text);
    if (ranged === null) return false;
    const file = fileOf(ranged);
    return names.some((name) => globMatches(file, name, true));
  });
}

/** 語が保留のコードを指すか、引用符の外のglobかブレースの範囲が保留のコードの名前に当たりうるなら真。ディレクトリは問わない。 */
function pointsAtHoldCode(word: Word): boolean {
  return pointsAtCode(word, HOLD_MENTION, HOLD_FILE_NAMES);
}

/** miseのコマンド行の語が、置く・解除するタスクを名前で指すなら真。 */
function namesHoldTask(word: Word): boolean {
  return spellings(word).some(
    (text) => text.startsWith("hold:") && text !== "hold:list",
  );
}

/** miseのコマンド行の語が、置く・解除するタスクを指しうるなら真。 */
function namesHoldWriteTask(word: Word): boolean {
  const all = spellings(word);
  if (word.dynamic || all.some((text) => text.includes("{"))) return true;
  return all.some((text) =>
    GLOB_CHARACTERS.test(text)
      ? HOLD_WRITE_TASKS.some((task) => globMatches(text, task))
      : text.startsWith("hold:") && text !== "hold:list",
  );
}

/**
 * 最初のオペランドが検査の道具なら真。
 * 実行系のオプション(`--bun`、`--yes`、`-y`)と、`run`や`x`などの語は読み飛ばす。
 * `@biomejs/biome@1.9.4`のような版の付いた名前は、版を落として比べる。
 */
function startsWithInspectionTool(args: readonly Word[]): boolean {
  return inspectionOperand(args) !== null;
}

/**
 * `startsWithInspectionTool`が見る最初のオペランドが検査の道具なら、版を落とした名前を返す。そうでなければnullを返す。
 * `subcommands`は、検査の道具の前に読み飛ばす実行の語である。
 */
function inspectionOperand(
  args: readonly Word[],
  subcommands: ReadonlySet<string> = RUNNER_SUBCOMMANDS,
): string | null {
  let index = 0;
  while (index < 4) {
    const text = args[index]?.text ?? "";
    if (!RUNNER_FLAGS.has(text) && !subcommands.has(text)) break;
    index += 1;
  }
  const first = (args[index]?.text ?? "").replace(VERSION_SUFFIX, "");
  return INSPECTION_TOOLS.has(first) || LINT_SCRIPT.test(first) ? first : null;
}

/** 保留のコードを指す語が、すべて`hold`の直後に`list`を置く形なら真。 */
function mentionsOnlyList(args: readonly Word[]): boolean {
  return args.every(
    (word, index) =>
      !pointsAtHoldCode(word) ||
      (HOLD_CLI.test(word.text) && args[index + 1]?.text === "list"),
  );
}

function runnerTouchesHolds(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const literal = inputs();
  const inInput = literal?.some((text) => HOLD_MENTION.test(text)) ?? false;
  const inArgs = args.some(pointsAtHoldCode);
  if (!inInput && !inArgs) return false;
  if (!inInput && startsWithInspectionTool(args)) return false;
  return inInput || !mentionsOnlyList(args);
}

/** 語がちょうど`deploy`(大文字小文字を問わない)なら真。 */
function isDeployWord(word: Word): boolean {
  return spellings(word).some((text) => /^deploy$/i.test(text));
}

/**
 * `freeze:place`か`freeze.ts place`に渡す語が、deployの保留を置く形なら`operation`を返す。
 * `--scope`の値(`--scope=deploy`の形も)が`deploy`のときである。
 * 語が実行時に決まるか引用符の外のglobを含むと、`--scope`の値かを判定できないので`dynamic`を返す。
 */
function deployScopeFinding(words: readonly Word[]): HoldFinding | null {
  if (words.some((word) => word.dynamic || word.glob)) return "dynamic";
  for (const [index, word] of words.entries()) {
    const all = spellings(word);
    const inline = all.find((text) => text.startsWith("--scope="));
    if (inline !== undefined) {
      if (/^deploy$/i.test(inline.slice("--scope=".length))) return "operation";
      continue;
    }
    const next = words[index + 1];
    if (all.includes("--scope") && next !== undefined && isDeployWord(next)) {
      return "operation";
    }
  }
  return null;
}

/** miseのタスク名の語が、`task`を指しうる(綴りが同じか、globが当たる)なら真。 */
function namesTask(word: Word, task: string): boolean {
  return spellings(word).some((text) =>
    GLOB_CHARACTERS.test(text) ? globMatches(text, task) : text === task,
  );
}

/**
 * miseのコマンド行のうち、凍結の解除、全消去、削除を確定する押し出しのタスクか、deployの保留を置くタスクの呼び出しを見分ける。
 * `taskWords`は`--`より前の語、`args`はmiseの全体オプションの後ろの全部の語である。
 */
function miseFreezeFinding(
  taskWords: readonly Word[],
  args: readonly Word[],
): HoldFinding | null {
  if (
    taskWords.some((word) =>
      FREEZE_WRITE_TASKS.some((task) => namesTask(word, task)),
    )
  ) {
    return "operation";
  }
  const place = taskWords.find((word) => namesTask(word, FREEZE_PLACE_TASK));
  const push = taskWords.find((word) => namesTask(word, PUSH_TASK));
  const afterPlace =
    place === undefined
      ? null
      : deployScopeFinding(
          args
            .slice(args.indexOf(place) + 1)
            .filter((word) => word.text !== "--"),
        );
  if (afterPlace === "operation" || push === undefined) return afterPlace;
  const afterPush = pushPruneFinding(
    args.slice(args.indexOf(push) + 1).filter((word) => word.text !== "--"),
  );
  return stronger(afterPlace, afterPush);
}

/** 凍結のCLIのファイル名。globが当たるかを見る対象である。 */
const FREEZE_FILE_NAMES: readonly string[] = [
  "freeze",
  "freeze.ts",
  "freezes",
  "freezes.ts",
  "freeze_apply",
  "freeze_apply.ts",
];

/**
 * 語が凍結のCLIを指すか、引用符の外のglobかブレースの範囲が凍結のコードの名前に当たりうるなら真。
 * 保留のコードと同じく、ファイル名の部分だけを見て、ディレクトリは問わない。
 */
function pointsAtFreezeCode(word: Word): boolean {
  return pointsAtCode(word, FREEZE_MENTION, FREEZE_FILE_NAMES);
}

/** 次の語をコードとして実行する実行系のオプションと副コマンド。 */
const CODE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
  "--command",
  "eval",
]);

/**
 * 実行系の引数のうち、コードとして実行される文字列。
 * `-e`などの直後の語と、`--eval=<コード>`の値である。
 * `-t`の値や凍結のCLIの`--reason`の値のように、コードでない文字列は読まない。
 */
function codeStrings(args: readonly Word[]): string[] {
  const codes: string[] = [];
  for (const [index, word] of args.entries()) {
    for (const text of spellings(word)) {
      const inline = /^--(?:eval|print|command)=([\s\S]*)$/.exec(text);
      if (inline?.[1] !== undefined) codes.push(inline[1]);
    }
    if (CODE_FLAGS.has(word.text)) {
      const next = args[index + 1];
      if (next !== undefined) codes.push(...spellings(next));
    }
  }
  return codes;
}

/** コードの文字列が、凍結のCLIを指しながら、端末の確認を通る書き込みかdeployの保留を書いているなら真。 */
function codeTouchesFreezeRelease(text: string): boolean {
  return (
    FREEZE_MENTION.test(text) &&
    /\b(?:release|deploy|reset|prune)\b/i.test(text)
  );
}

/**
 * 凍結のCLIの`push`に渡す語が、削除を確定する`--prune`か、`--prune`かを判定できない語を含むなら、拒否の種類を返す。
 * `--dry-run`だけの`push`は読み取りなので通す。
 */
function pushPruneFinding(args: readonly Word[]): HoldFinding | null {
  if (args.some((word) => spellings(word).includes("--prune"))) {
    return "operation";
  }
  const unreadable = args.some(
    (word) =>
      word.dynamic ||
      word.glob ||
      spellings(word).some((text) => text.includes("{")),
  );
  return unreadable ? "dynamic" : null;
}

/**
 * 凍結のCLIを指す語の後ろの語から、副コマンドを決めて判定する。
 * CLIの直後の`--`は、任意個数を読み飛ばす。
 * 端末の確認を通る書き込み(`release`、`reset`、`place --scope deploy`、`push --prune`)を拒否する。
 */
function freezeSubcommandFinding(rest: readonly Word[]): HoldFinding | null {
  return freezeSubcommandAt(rest, 0);
}

/** `words`の`from`番目から後ろを、凍結のCLIの後ろの語として`freezeSubcommandFinding`と同じに判定する。 */
function freezeSubcommandAt(
  words: readonly Word[],
  from: number,
): HoldFinding | null {
  const start = firstOperandAt(words, from);
  const subcommand = words[start];
  if (subcommand === undefined) return null;
  if (isUnreadable(subcommand)) return "dynamic";
  if (subcommand.text === "release" || subcommand.text === "reset") {
    return "operation";
  }
  if (subcommand.text === "place") {
    return deployScopeFinding(words.slice(start + 1));
  }
  if (subcommand.text === "push") {
    return pushPruneFinding(words.slice(start + 1));
  }
  return null;
}

/** `from`番目以降で、`--`でない最初の語の添字を返す。無ければ語の数を返す。 */
function firstOperandAt(words: readonly Word[], from: number): number {
  let at = from;
  while (at < words.length && words[at]?.text === "--") at += 1;
  return at;
}

/**
 * 実行系の引数が、凍結のCLI(`scripts/freeze.ts`)で、端末の確認を通る書き込みか、deployの保留を置く形なら拒否の種類を返す。
 * 凍結のCLIを指す語は、すべて調べる。直後の語が副コマンドである。凍結のCLIは、副コマンドを最初の引数として読むためである。
 * 実行時に決まるときは判定できないので`dynamic`を返す。
 * 標準入力のコード、`-e`などの直後の文字列、空白かシェルが語を分けるか展開する字を含む語は、
 * 凍結のCLIを指しながら`release`、`deploy`、`reset`、`prune`を含めば拒否する。
 * 最後の種類の語は、コードを取るオプションの一覧に無いオプションの値を読むためである。凍結のCLIの理由の値は読まない。
 * 最初のオペランドが検査の道具なら、標準入力のコードと`-e`などの直後の文字列のほかは見ない。
 */
function freezeCliFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): HoldFinding | null {
  const codes = [...(inputs() ?? []), ...codeStrings(args)];
  if (codes.some(codeTouchesFreezeRelease)) return "operation";
  if (startsWithInspectionTool(args)) return null;
  if (
    args.some(
      (word, index) =>
        splitsIntoWords(word.text) &&
        !isReasonValue(args, index) &&
        spellings(word).some(codeTouchesFreezeRelease),
    )
  ) {
    return "operation";
  }
  let found: HoldFinding | null = null;
  for (const [at, word] of args.entries()) {
    if (!pointsAtFreezeCode(word)) continue;
    const finding = freezeSubcommandAt(args, at + 1);
    if (finding === "operation") return finding;
    found = found ?? finding;
  }
  return found;
}

/**
 * `index`番目の語が、凍結のCLIを指す語より後ろにある`--reason`の値(直後の語か、`--reason=`の形)なら真。
 * 理由の文字列はコードとして実行されないので、CLIを指す字面と書き込みの語が並ぶ文字列の判定から外す。
 * ほかのプログラムの同じ名前のオプションの値は、コードとして読まれうるので外さない。
 */
function isReasonValue(args: readonly Word[], index: number): boolean {
  const word = args[index];
  if (word === undefined) return false;
  const inline = word.text.startsWith("--reason=");
  if (!inline && args[index - 1]?.text !== "--reason") return false;
  const optionAt = inline ? index : index - 1;
  return args.slice(0, optionAt).some(pointsAtFreezeCode);
}

/** 先頭の語が凍結のコードを指すなら真。 */
function direct0IsFreezeCli(words: readonly Word[]): boolean {
  const first = words[0];
  return first !== undefined && pointsAtFreezeCode(first);
}

/**
 * 実行系の標準入力に流れ込むものの出どころ。
 * `redirects`はリダイレクトの先の語、`inputFiles`はそのうち入力(`<`)の先の語、
 * `upstream`はパイプの前のコマンドの語(直前から順に)、
 * `dynamicInput`はヒアストリングやリダイレクトの先が実行時に決まることを表す。
 */
export type HoldStdin = {
  readonly redirects: readonly Word[];
  readonly inputFiles: readonly Word[];
  readonly upstream: readonly HoldUpstream[];
  readonly dynamicInput: boolean;
};

/** パイプの前のコマンド。語に加えて、そのコマンド自身の標準入力の出どころを持つ。 */
export type HoldUpstream = {
  readonly words: readonly Word[];
  readonly redirects: readonly Word[];
  readonly inputs: readonly Word[];
};

const NO_STDIN: HoldStdin = {
  redirects: [],
  inputFiles: [],
  upstream: [],
  dynamicInput: false,
};

/** 単純コマンドの標準入力に流れ込むものの出どころ。保留と凍結のコードを実行系へ流し込む形を見分けるために渡す。 */
export function holdStdin(command: SimpleCommand): HoldStdin {
  const upstream: HoldUpstream[] = [];
  for (
    let source = command.pipedFrom;
    source !== null;
    source = source.pipedFrom
  ) {
    upstream.push({
      words: [...stripWrappers(source.words).words],
      redirects: source.redirects,
      inputs: source.inputs,
    });
  }
  return {
    redirects: command.redirects,
    // 語が`1`、`2`、`-`だけのものを外す。`2>&1`と`1>&2`の出力の複製と、`<&-`の閉じる指定を、入力に数えないためである。
    // `<&3`の入力の複製と`>&3`の出力の複製は、番号が`3`という名前のファイルと字面で区別せず、読めない入力として残す。
    // `/dev/null`を入力にする形も、中身を読めないファイルとして同じに残す。
    // 名前が`1`、`2`、`-`のファイルと、読み書きの両方で開く`<>`の先は、読めない入力に数えない。
    inputFiles: command.redirects.filter(
      (word) =>
        !command.writeTargets.includes(word) && !/^(?:[12]|-)$/.test(word.text),
    ),
    upstream,
    dynamicInput:
      command.inputs.some((word) => word.dynamic) ||
      command.redirects.some((word) => word.dynamic),
  };
}

/** 外側のコマンドの標準入力に、コマンド文字列の中のコマンドの標準入力を足す。 */
function chainStdin(outer: HoldStdin, inner: HoldStdin): HoldStdin {
  return {
    redirects: [...inner.redirects, ...outer.redirects],
    inputFiles: [...inner.inputFiles, ...outer.inputFiles],
    upstream: [...inner.upstream, ...outer.upstream],
    dynamicInput: outer.dynamicInput || inner.dynamicInput,
  };
}

/** 外側のコマンドの標準入力の文字列に、中のコマンドの文字列を足す。どちらかが読めなければ読めない。 */
function chainInputs(
  outer: () => readonly string[] | null,
  inner: () => readonly string[] | null,
): () => readonly string[] | null {
  return () => {
    const first = outer();
    const second = inner();
    return first === null || second === null ? null : [...first, ...second];
  };
}

/** 標準入力をコードとして読む形のオペランド。globとブレースの範囲が当たりうるかを見る対象である。 */
const STDIN_OPERANDS: readonly string[] = [
  "-",
  "/dev/stdin",
  "/dev/fd/0",
  "/proc/self/fd/0",
];

/** まとめた綴りが標準入力を指すパス。記述子の番号は、前に0を重ねた綴りも当たる。 */
const STDIN_PATH = /^\/(?:dev\/stdin|dev\/fd\/0+|proc\/self\/fd\/0+)$/;

/**
 * オペランドの綴りを、重ねたスラッシュ、`/./`、`/../`をまとめた絶対パスの形にする。`-`は変えない。
 * 相対パスは、先頭の`..`を除いて根からのパスとみなす。`..`を重ねれば根に届くためである。
 */
function stdinOperandForm(text: string): string {
  if (text === "-") return text;
  const normal = posix.normalize(text);
  if (text.startsWith("/")) return normal;
  return `/${normal.replace(/^(?:\.\.(?:\/|$))+/, "")}`;
}

/**
 * 語が、標準入力をコードとして読む形のオペランドなら真。
 * まとめた綴りが標準入力を指す語、実行時に決まる語、標準入力の綴りに当たりうるglobとブレースの語である。
 */
function readsStdinOperand(word: Word): boolean {
  if (word.dynamic) return true;
  return spellings(word).some((text) => {
    const form = stdinOperandForm(text);
    if (form === "-" || STDIN_PATH.test(form)) return true;
    const ranged = rangeAsGlob(text);
    const globs = [
      ...(word.glob ? [text] : []),
      ...(ranged === null ? [] : [ranged]),
    ];
    return globs.some((glob) =>
      [glob, stdinOperandForm(glob)].some((pattern) =>
        STDIN_OPERANDS.some((operand) => globMatches(pattern, operand)),
      ),
    );
  });
}

function readsCodeFromStdin(args: readonly Word[]): boolean {
  return args.some(readsStdinOperand);
}

/** パイプの前に置いてよい、中身を語から読めるプログラム。 */
const PLAIN_UPSTREAM: ReadonlySet<string> = new Set(["cat"]);

/** 語が保留か凍結のコードを指す、実行時に決まる、またはglobなら真。 */
function opaqueOrHoldCode(word: Word): boolean {
  return (
    word.dynamic ||
    word.glob ||
    pointsAtHoldCode(word) ||
    pointsAtFreezeCode(word)
  );
}

/**
 * 実行系が標準入力をコードとして読む形(`bun run -`)の入力元を調べる。
 * 保留や凍結のコードを流し込むファイル、実行時に決まる入力、中身を読めないパイプの前のコマンドは拒否する。
 * 中身を読めるのは、`echo`と`printf`(`inputs`が文字列を返す)と、静的なファイルだけを渡す`cat`である。
 * 入力が凍結のCLIを指すときは、`-`の後ろを副コマンドとして判定する。
 */
function stdinCodeFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin,
): HoldFinding | null {
  if (startsWithInspectionTool(args)) return null;
  // `<(...)`は入力元が実行時に決まる。`-`が無くても、`/dev/fd/N`などで読めるので拒否に倒す。
  if (stdin.redirects.some((word) => word.text === "<(")) return "dynamic";
  if (!readsCodeFromStdin(args)) return null;
  if (stdin.dynamicInput) return "dynamic";
  const literal = inputs();
  if (literal === null) return "dynamic";
  for (const command of stdin.upstream) {
    const program = baseName(command.words[0]?.text ?? "");
    if (program === "echo" || program === "printf") continue;
    if (
      !PLAIN_UPSTREAM.has(program) ||
      command.words.slice(1).some(opaqueOrHoldCode) ||
      // `cat < scripts/freeze.ts`や`cat <<< "$(...)"`のように、catも標準入力から読める。
      command.redirects.some(opaqueOrHoldCode) ||
      command.inputs.some(
        (word) =>
          word.dynamic ||
          FREEZE_MENTION.test(word.text) ||
          HOLD_MENTION.test(word.text),
      )
    ) {
      return "operation";
    }
  }
  if (literal.some((text) => FREEZE_MENTION.test(text))) {
    // 標準入力とみなすオペランドが複数あるときは、どれが標準入力かを決めないので、それぞれの後ろを副コマンドとして判定する。
    let found: HoldFinding | null = null;
    for (const [at, word] of args.entries()) {
      if (!readsStdinOperand(word)) continue;
      found = stronger(found, freezeSubcommandFinding(args.slice(at + 1)));
    }
    return found;
  }
  return null;
}

/** 実行系の引数が、保留か凍結のCLIを呼ぶ拒否の対象なら、その種類を返す。 */
function runnerFinding(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
): HoldFinding | null {
  // `bun run - < scripts/freeze.ts`のように、標準入力で流し込んだコードも実行される。
  if (
    stdin.redirects.some(
      (word) => pointsAtHoldCode(word) || pointsAtFreezeCode(word),
    )
  ) {
    return "operation";
  }
  if (runnerTouchesHolds(args, inputs)) return "operation";
  const fromStdin = stdinCodeFinding(args, inputs, stdin);
  if (fromStdin !== null) return fromStdin;
  return freezeCliFinding(args, inputs);
}

function miseFinding(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
): HoldFinding | null {
  const scan = scanMiseGlobalOptions(words, 1);
  // 知らないオプションが値を取ると、サブコマンドの位置が決まらない。コマンド全体を拒否する。
  if (scan.unknown) return "option";
  const args = words.slice(scan.next);
  const subcommand = args[0];
  if (subcommand === undefined) return null;
  // `exec`と`x`があれば、位置を問わず、その後ろをコマンドとして判定する。
  const execAt = args.findIndex(
    (word) => word.text === "exec" || word.text === "x",
  );
  if (execAt !== -1) {
    const finding = runnerFinding(args.slice(execAt + 1), inputs, stdin);
    if (finding !== null) return finding;
  }
  const inTasks = MISE_TASKS_WORDS.has(subcommand.text);
  const running =
    args.some((word) => MISE_RUNNING_WORDS.has(word.text)) ||
    (inTasks && miseTasksRunsUnreadably(args)) ||
    subcommand.dynamic ||
    namesHoldWriteTask(subcommand) ||
    subcommand.text === PUSH_TASK ||
    (!inTasks && args.some((word) => word.text.includes(":")));
  if (!running) return null;
  // `--`より後ろはタスクへの引数なので、globや実行時に決まる語は見ない。`hold:`で名指しする語だけ見る。
  const dashAt = args.findIndex((word) => word.text === "--");
  const taskWords = dashAt === -1 ? args : args.slice(0, dashAt);
  const argWords = dashAt === -1 ? [] : args.slice(dashAt + 1);
  const named = [
    ...taskWords.filter(namesHoldWriteTask),
    ...argWords.filter(namesHoldTask),
  ];
  if (named.length === 0) return miseFreezeFinding(taskWords, args);
  return named.some((word) => !word.dynamic) ? "operation" : "dynamic";
}

function sqlTouchesHolds(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  if (words.slice(1).some((word) => /holds/i.test(word.text))) return true;
  const literal = inputs();
  return literal?.some((text) => /holds/i.test(text)) ?? false;
}

/** コマンド文字列を入れ子に読む深さの上限。深すぎる入力で処理が止まらないようにする。保留と凍結、全停止の判定で共通である。 */
const COMMAND_TEXT_MAX_DEPTH = 4;

/**
 * 前置きの後ろから判定し直す起動語の名前なら真。`mise`と実行系が対象である。
 * 全停止の判定と共通である。
 */
function isLauncherName(name: string): boolean {
  return name === "mise" || RUNNERS.has(name);
}

/** 前置きの後ろで調べる起動語(`mise`と実行系)の数の上限。超えたら判定できないものとして拒否する。 */
const HOLD_MAX_LAUNCHERS = 16;

/** 1回の判定で読むコマンド文字列の数と、その長さの合計の上限。フックのタイムアウト(10秒)の中で終えるためである。 */
const HOLD_MAX_PARSES = 256;
const HOLD_MAX_TEXT = 1_000_000;

/**
 * 判定の締め切りまでの残りを測る時計。`evaluateBashGuard`が開始のときに作り、入れ子の判定とも共有する。
 * 時計は注入できる。テストが偽の時計で締め切りを固定するためである。
 */
export type HoldClock = {
  readonly now: () => number;
  /** この時刻(ミリ秒)を超えたら、判定できないものとして拒否する。 */
  readonly deadline: number;
};

/**
 * 判定の開始から数える締め切り(ミリ秒)。
 * フックのタイムアウトは10秒で、超えると判定が拒否にならず、通常の権限の流れに進む。
 * 同期の判定は途中で止められないので、各所で締め切りを見て、超えたら`dynamic`で拒否して早く終える。
 * 超えた時点で拒否が決まり、続くコマンドは判定しないので、残る処理は出力だけである。起動と出力の余裕として4秒を残す。
 * 予算(語の数、解析の回数)の中に収まる入力は、実測で1秒未満(最も遅い256段×100語で約0.8秒)で、
 * テストは3000段のパイプなどを3秒未満、幅のある256段を8秒未満で固定している。
 * 締め切りの6秒は、最も遅い実測の約7倍なので、CIの負荷で数倍遅くなっても、通常の入力では働かない。
 * 保留の判定より前の検査(前置きの無い数千段のパイプで約4.5秒)は、この締め切りでは止められない。
 */
export const HOLD_DEADLINE_MS = 6000;

/**
 * `now`の時刻から数える締め切りの時計を作る。
 * 既定は単調な時計(`performance.now`)で、時刻の補正で時計が飛んでも締め切りを誤らない。
 */
export function holdClock(
  now: () => number = () => performance.now(),
): HoldClock {
  return { now, deadline: now() + HOLD_DEADLINE_MS };
}

/** 締め切りを超えていれば真。 */
function deadlineExceeded(budget: HoldBudget): boolean {
  return budget.clock.now() > budget.clock.deadline;
}

/** 1回の判定で、コマンド文字列を読んだ回数と文字数。`clock`は締め切りの時計である。 */
type HoldBudget = {
  parses: number;
  chars: number;
  words: number;
  readonly clock: HoldClock;
};

/**
 * 前置きのコマンドの上流にたどるパイプのコマンドの数の上限。超えたら判定できないものとして拒否する。
 * 上流は前置きのコマンドごとにたどり直すので、長いパイプラインの処理が数の2乗で増えるためである。
 */
const HOLD_MAX_UPSTREAM = 256;

/**
 * 共起で走査した語の数の合計の上限。パイプの上流の語は、読むたびに走査し直すので、合計に数える。
 * 数えるのは最上位の単純コマンドごとで、上流の段の数の上限と合わせて、1つの入力の処理量を抑える。
 */
const HOLD_MAX_WORDS = 30_000;

function newBudget(clock: HoldClock): HoldBudget {
  return { parses: 0, chars: 0, words: 0, clock };
}

const FINDING_RANK: Record<HoldFinding, number> = {
  operation: 6,
  prefix: 5,
  context: 4,
  assignment: 3,
  dynamic: 2,
  option: 1,
};

/** 2つの判定のうち、強い方(`operation`、`prefix`、`context`、`assignment`、`dynamic`、`option`、null の順)を返す。 */
function stronger(
  first: HoldFinding | null,
  second: HoldFinding | null,
): HoldFinding | null {
  if (first === null) return second;
  if (second === null) return first;
  return FINDING_RANK[second] > FINDING_RANK[first] ? second : first;
}

/** 書き込みの副コマンドの語。読めない標準入力の文字列の判定に使う。 */
const WRITE_WORD = /\b(?:place|release|reset|prune|deploy)\b/i;

/** 削除を確定する押し出しの字面。タスク名か、`push`と`--prune`が並ぶ形である。 */
const PUSH_PRUNE_WORDING =
  /(?:^|[^\w:-])push:prune(?![\w-])|(?:^|[^\w:-])push(?![\w:-])[^;|&\n]*\s--prune(?![\w-])/;

/** 文字列が、書き込みのタスク名(`hold:`で始まる`hold:list`以外、`freeze:`の書き込み、`push:prune`)の字面を含むなら真。 */
function mentionsWriteTask(text: string): boolean {
  return (
    /(?:^|[^\w:-])hold:(?!list(?![\w-]))/i.test(text) ||
    /(?:^|[^\w:-])freeze:(?:place|release|reset)(?![\w-])/i.test(text) ||
    PUSH_PRUNE_WORDING.test(text)
  );
}

/** 文字列が、保留か凍結のコードを指す字面か、書き込みのタスク名の字面を含むなら真。読めない文字列と、深すぎる文字列の判定に使う。 */
function mentionsHoldOrFreeze(text: string): boolean {
  return (
    HOLD_MENTION.test(text) ||
    FREEZE_MENTION.test(text) ||
    mentionsWriteTask(text)
  );
}

/** 文字列が、保留か凍結のコードを指す字面と書き込みの語が並ぶか、書き込みのタスク名の字面を含むなら真。 */
function mentionsCodeWrite(text: string): boolean {
  return (
    ((HOLD_MENTION.test(text) || FREEZE_MENTION.test(text)) &&
      WRITE_WORD.test(text)) ||
    mentionsWriteTask(text)
  );
}

/**
 * 引用符とバックスラッシュを除いた綴り。読めない文字列の中で、語の途中の空の引用で名前を分けた形を照合するためである。
 * 引用符の直前の`$`も除く。`$''`と`$""`の空の引用も、シェルは名前をつなげて読むためである。
 */
function unquotedText(text: string): string {
  return text.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");
}

/** 語に、実行時に決まる部分、glob、ブレースのどれかがあり、綴りが決まらないなら真。 */
function isUnreadable(word: Word): boolean {
  return (
    word.dynamic ||
    word.glob ||
    spellings(word).some((text) => text.includes("{"))
  );
}

/**
 * 前置きとして扱うプログラム。後ろのコマンドを起動する。
 * `stripWrappers`が外さないもので、`/usr/bin/time`は名前の部分の`time`で数える。
 */
const PREFIX_PROGRAMS: ReadonlySet<string> = new Set([
  "script",
  "unbuffer",
  "caffeinate",
  "time",
  "ssh",
]);

/** 標準入力を子のコマンドへ渡す前置き。標準入力の中身が読めないと、何が実行されるか分からない。 */
const STDIN_PREFIX_PROGRAMS: ReadonlySet<string> = new Set(["script", "ssh"]);

/** 保留のコードを指す語と並んだとき、書き込みになる語。 */
const HOLD_WRITE_WORDS: readonly string[] = [
  "place",
  "release",
  "reset",
  "prune",
  "--prune",
  "deploy",
];

/** 凍結のコードを指す語と並んだとき、書き込みになる語。`place`と`deploy`は、`--scope`の値を見て別に判定する。 */
const FREEZE_WRITE_WORDS: readonly string[] = [
  "release",
  "reset",
  "prune",
  "--prune",
];

/**
 * 1つのコマンドを判定するときの、周りの状態。
 * `inputs`は標準入力に渡る文字列(外側のコマンドの文字列をつなぐ)、`own`はそのコマンド自身の標準入力の文字列である。
 * `inString`は、前置きの後ろの文字列から読んだコマンドのとき真になる。
 * `viaXargs`は、前置きの`xargs`が標準入力の語を末尾に足すことを表す。
 * `xargsUnknown`は、その`xargs`が実行するコマンドが先頭の語に決まらないことを表す(知らないオプション、置換のオプション、後ろの前置き)。
 */
type HoldContext = {
  readonly inputs: () => readonly string[] | null;
  readonly own: () => readonly string[] | null;
  readonly stdin: HoldStdin;
  readonly depth: number;
  readonly budget: HoldBudget;
  readonly viaXargs: boolean;
  readonly xargsUnknown: boolean;
  readonly inString: boolean;
};

/**
 * 語を実行時に足すコマンド(`xargs`、`parallel`、`-exec`系の式を伴う`find`)か、シェルがあれば真。
 * 足される語やシェルの引数は、字面から読めない。オプションの文法は追わず、あれば指す語の有無によらず拒否する。
 */
function addsWordsOrRunsShell(words: readonly Word[]): boolean {
  return words.some((word) => {
    const name = baseName(word.text);
    return (
      name === "xargs" ||
      name === "parallel" ||
      FIND_EXECUTION.test(word.text) ||
      SHELLS.has(name)
    );
  });
}

/** 標準入力の出どころが読めないなら真。ファイル、実行時に決まる入力、`echo`と`printf`以外のパイプである。 */
function hasUnreadableStdin(context: HoldContext): boolean {
  const { stdin } = context;
  if (stdin.dynamicInput || stdin.inputFiles.length > 0) return true;
  const unreadablePipe = stdin.upstream.some((command) => {
    const program = baseName(command.words[0]?.text ?? "");
    return program !== "echo" && program !== "printf";
  });
  return unreadablePipe || context.inputs() === null;
}

/**
 * 語が、書き込みのタスク名(`hold:release`、`freeze:reset`など)なら、拒否の種類を返す。
 * `freeze:place`は、`--scope deploy`のときだけ拒否する。globは、起動語の後ろで`mise`の判定が見る。
 */
function taskNameFinding(
  words: readonly Word[],
  at: number,
): HoldFinding | null {
  const word = words[at];
  if (word === undefined) return null;
  const all = spellings(word);
  if (all.some((text) => text.startsWith("hold:") && text !== "hold:list")) {
    return "operation";
  }
  if (all.some((text) => FREEZE_WRITE_TASKS.includes(text))) return "operation";
  if (all.includes(FREEZE_PLACE_TASK)) {
    return deployScopeFinding(
      words.slice(at + 1).filter((next) => next.text !== "--"),
    );
  }
  return null;
}

/** 語の綴りのどれかが、`target`と完全に一致するなら真。 */
function hasSpelling(word: Word, target: string): boolean {
  return spellings(word).includes(target);
}

/**
 * 起動語の外にある語を、共起で見る。指す語と書き込みの語が、同じコマンドの語とパイプの上流の語の和にあれば拒否する。
 * 指す語は、保留か凍結のコードを指す語と、書き込みのタスク名である。書き込みの語は、綴りの完全一致で数える。
 * 位置は見ない。語の並びを変えても、語を足しても、同じ結果になる。
 * 指す語があり、ほかに実行時に決まる語、glob、ブレースがあれば、書き込みの語かを判定できないので`dynamic`にする。
 * 凍結の`place`は、`--scope`の値を`deployScopeFinding`で別に判定する。
 */
function cooccurrenceFinding(
  words: readonly Word[],
  from: number,
  context: HoldContext,
): HoldFinding | null {
  const upstreamSize = context.stdin.upstream.reduce(
    (sum, command) => sum + command.words.length,
    0,
  );
  context.budget.words += words.length - from + upstreamSize;
  if (
    context.budget.words > HOLD_MAX_WORDS ||
    deadlineExceeded(context.budget)
  ) {
    return "dynamic";
  }
  const own = words.slice(from).filter((word) => !/\s/.test(word.text));
  const upstream = context.stdin.upstream.flatMap((command) =>
    command.words.filter((word) => !/\s/.test(word.text)),
  );
  const all = [...own, ...upstream];
  let found: HoldFinding | null = null;
  for (let at = 0; at < all.length; at += 1) {
    found = stronger(found, taskNameFinding(all, at));
    if (found === "operation") return found;
  }
  const holdPoints = all.filter(pointsAtHoldCode);
  const freezePoints = all.filter(pointsAtFreezeCode);
  if (holdPoints.length === 0 && freezePoints.length === 0) return found;
  const writes = (targets: readonly string[]) =>
    all.some((word) => targets.some((target) => hasSpelling(word, target)));
  if (holdPoints.length > 0 && writes(HOLD_WRITE_WORDS)) return "operation";
  if (freezePoints.length > 0 && writes(FREEZE_WRITE_WORDS)) return "operation";
  const placeAt = all.findIndex((word) => hasSpelling(word, "place"));
  if (freezePoints.length > 0 && placeAt !== -1) {
    found = stronger(
      found,
      deployScopeFinding(
        all.slice(placeAt + 1).filter((word) => word.text !== "--"),
      ),
    );
  }
  const pointing = new Set([...holdPoints, ...freezePoints]);
  const unreadable = all.some(
    (word) => !pointing.has(word) && isUnreadable(word),
  );
  return unreadable ? stronger(found, "dynamic") : found;
}

/**
 * コマンド文字列(`script -c`の文字列、`ssh`の引数、`script`の標準入力の文字列)を、コマンドとして読んで判定する。
 * 中のコマンドごとに`holdOperationAt`で判定し直す。結果を足し合わせて、語の共起を文字列をまたいで数えることはしない。
 * `kind`が`string`のとき、外側の標準入力は中のコマンドにも流れるものとして渡す。`stdin`のとき、文字列自体が標準入力なので渡さない。
 * 深さの上限を超えた文字列と、コマンドとして読めない文字列は、字面で判定する。
 * 読む回数と長さの合計の上限を超えたときも、判定できないものとして拒否する。
 */
function textFinding(
  text: string,
  context: HoldContext,
  kind: "string" | "stdin",
): HoldFinding | null {
  const base = kind === "stdin" ? mentionsCodeWrite : mentionsHoldOrFreeze;
  // 読めない文字列は、語の途中の空の引用で名前を分けた形も見るため、引用符とバックスラッシュを除いた綴りでも判定する。
  const literal = (t: string) => base(t) || base(unquotedText(t));
  if (context.depth >= COMMAND_TEXT_MAX_DEPTH) {
    return literal(text) ? "operation" : null;
  }
  const { budget } = context;
  budget.parses += 1;
  budget.chars += text.length;
  if (
    budget.parses > HOLD_MAX_PARSES ||
    budget.chars > HOLD_MAX_TEXT ||
    deadlineExceeded(budget)
  ) {
    return "dynamic";
  }
  const parsed = parseCommandLine(text);
  if (!parsed.ok) return literal(text) ? "operation" : null;
  let found: HoldFinding | null = null;
  for (const command of parsed.commands) {
    const stripped = stripWrappers(command.words);
    if (stripped.opaque) return "dynamic";
    if (stripped.words.length === 0) continue;
    const own = () => literalShellInputs(command);
    const inner: HoldContext = {
      inputs: kind === "stdin" ? own : chainInputs(context.inputs, own),
      own,
      stdin:
        kind === "stdin"
          ? holdStdin(command)
          : chainStdin(context.stdin, holdStdin(command)),
      depth: context.depth + 1,
      budget,
      viaXargs: stripped.wrappers.includes("xargs"),
      xargsUnknown: stripped.xargsCommandUnknown,
      inString: true,
    };
    found = stronger(found, holdOperationAt(stripped.words, inner));
    // 先頭の変数代入は前置きとして外れるが、値がコマンドとして実行されうる(`ProxyCommand=…`、`LESSOPEN=…`)。値を先頭の語として判定する。
    // 値が保留や凍結のCLIを指すときと、起動語のときに、後ろの語を引数として付ける。実際に実行される語は上で判定している。
    // 代入ごとの判定は、解析の回数に数える。
    for (const assignment of stripped.assignments) {
      budget.parses += 1;
      if (budget.parses > HOLD_MAX_PARSES) return "dynamic";
      const value = assignmentValue(assignment);
      const pointing =
        pointsAtHoldCode(value) ||
        pointsAtFreezeCode(value) ||
        launchesWithArguments(value);
      found = stronger(
        found,
        holdOperationAt(pointing ? [value, ...stripped.words] : [value], inner),
      );
      if (/\s/.test(value.text)) {
        found = stronger(found, textFinding(value.text, inner, "string"));
      }
    }
    if (found === "operation") return found;
  }
  return found;
}

/** 変数代入の語`NAME=値`から、`=`より後ろの値を語として取り出す。 */
function assignmentValue(assignment: Word): Word {
  const cut = (text: string) => text.slice(text.indexOf("=") + 1);
  return {
    text: cut(assignment.text),
    dynamic: assignment.dynamic,
    glob: assignment.glob,
    ...(assignment.variants === undefined
      ? {}
      : { variants: assignment.variants.map(cut) }),
  };
}

/**
 * 値の先頭の語が、後ろの語を引数として受ける起動語なら真。
 * 実行系と`mise`、`docker`と`psql`、前置き、シェルの閉じた集合である。
 * 名前だけの代入の形で始まる文字列(リモートの道具のオプションの値)は、値と後ろの語の組がコマンドとして実行されるためである。
 */
function launchesWithArguments(value: Word): boolean {
  const name = baseName(value.text);
  return (
    isLauncherName(name) ||
    SQL_PROGRAMS.has(name) ||
    PREFIX_PROGRAMS.has(name) ||
    SHELLS.has(name)
  );
}

/**
 * 語の中で、コマンドとして実行されうる値の前に付く部分。
 * `--opt=`、`<キー>=`(`-c`の値と`-c<キー>=`を含む)、シェルの別名の`!`と、ページャーの初期コマンドの前の部分である。
 * ページャーの初期コマンドは、`+`の後ろの`!`(シェルのコマンド)か`|`と印の1字(パイプのコマンド)までを外す。
 * `+`と`!`の間の空白と、短いオプションのまとめ書きの後ろの`+`も含める。`!`と`|`は、先に現れた方で切る。
 * キーは、空白と`=`以外の字の並びとする。設定のキーのサブセクションは、`/`や`:`を含みうる。
 * 短いオプションのまとめ書きの、コマンドを値にくっつけて取る文字(`git grep`の`O`と`git ls-remote`の`u`)までも、前の部分として外す。
 * どの文字が値を取るかはプログラムで決まるので、最初に現れた文字までを外す。外しすぎても、判定する値が増えるだけである。
 */
const COMMAND_VALUE_PREFIX =
  /^(?:(?:-[A-Za-z0-9]*)?\+[^!|]*(?:!|\|.)|!|[^\s=]+=|-[A-Za-z0-9]*?O|-[A-Za-z0-9]*?u)/s;

/** シェルの変数代入の形の前の部分。 */
const SHELL_ASSIGNMENT_PREFIX = /^[A-Za-z_]\w*=/;

/** シェルが語を分けるか展開する字。空白、`$`、バッククォート、`;`、`|`、`&`、`<`、`>`である。 */
const SHELL_SPLITTING_CHARACTERS = /[\s$`;|&<>]/;

/**
 * 文字列が、シェルが語を分けるか展開する字を含むか、`{`と`}`の間に`,`か`..`を持つ(ブレースの並びの形)なら真。
 * ブレースの並びは、最初の`{`と最後の`}`の間で見る。どの組の間にあっても、その範囲に入るためである。
 */
function splitsIntoWords(text: string): boolean {
  if (SHELL_SPLITTING_CHARACTERS.test(text)) return true;
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open === -1 || close <= open) return false;
  const inner = text.slice(open + 1, close);
  return inner.includes(",") || inner.includes("..");
}

/**
 * 語に値の部分があり、語がシェルの語を分けるか展開する字を含めば(`splitsIntoWords`)、前の部分を外した値を語として返す。そうでなければnullを返す。
 * そうした字の無い値は、1語のまま渡り引数を渡せず、起動語を判定しても日常の値(`--reporter=watch`など)を拒否するだけなので、取り出さない。
 * `assignmentValue`と同じく、NULを除いた綴りからも前の部分を外し、`dynamic`と`glob`を引き継ぐ。
 * シェルの変数代入の形で始まる語(`LANG=C rg …`)は、nullを返す。
 * その語はコマンドとして読むときに代入として外れ、値は代入の判定が空白までを見るので、後ろのコマンドまで値に含めない。
 */
function commandValue(word: Word): Word | null {
  if (!splitsIntoWords(word.text)) return null;
  const prefix = COMMAND_VALUE_PREFIX.exec(word.text)?.[0];
  if (prefix === undefined || prefix.length === word.text.length) return null;
  if (SHELL_ASSIGNMENT_PREFIX.test(prefix)) return null;
  const cut = (text: string) =>
    text.slice(COMMAND_VALUE_PREFIX.exec(text)?.[0].length ?? 0);
  return {
    text: word.text.slice(prefix.length),
    dynamic: word.dynamic,
    glob: word.glob,
    ...(word.variants === undefined
      ? {}
      : { variants: word.variants.map(cut) }),
  };
}

/**
 * 前置きの後ろの起動語(`mise`、実行系、`docker`と`psql`)を、その位置から先頭のときと同じ規則で判定し直す。
 * 起動語が複数あれば、すべて調べる。数に上限を置き、超えたら拒否する。
 */
function launchersFinding(
  words: readonly Word[],
  context: HoldContext,
): HoldFinding | null {
  let found: HoldFinding | null = null;
  let count = 0;
  for (let at = 1; at < words.length; at += 1) {
    const name = baseName(words[at]?.text ?? "");
    const sql = SQL_PROGRAMS.has(name);
    if (!isLauncherName(name) && !sql) continue;
    count += 1;
    if (count > HOLD_MAX_LAUNCHERS) return "dynamic";
    let finding: HoldFinding | null;
    if (sql) {
      finding = sqlTouchesHolds(words.slice(at), context.inputs)
        ? "operation"
        : null;
    } else if (name === "mise") {
      finding = miseFinding(words.slice(at), context.inputs, context.stdin);
    } else {
      finding = runnerFinding(
        words.slice(at + 1),
        context.inputs,
        context.stdin,
      );
    }
    found = stronger(found, finding);
    if (found === "operation") return found;
  }
  return found;
}

/**
 * 何も実行しないはずの読み取りや検査の道具で、別のコマンドを実行する形でもないなら真。
 * `sed`や`bat`のように、パスの形の語だけを読む道具は、パスの形でない語があれば、文字列をコマンドとして実行しうるので通さない。
 */
function isReadOnlyProgram(program: string, words: readonly Word[]): boolean {
  const kind = readerKind(program, words);
  const reads = kind !== null || INSPECTION_TOOLS.has(program);
  if (!reads || delegatesExecution(program, words.slice(1))) return false;
  return (
    kind !== "path-only" || words.every((word) => PATH_LIKE.test(word.text))
  );
}

/**
 * 前置きの後ろの判定。`words`の`from`番目から後ろを見る。
 * 前置き自身が先頭のときは1、前置きの後ろの文字列から読んだコマンドは0である。
 * 1. 語を足すコマンド、シェル、読めない標準入力があれば、指す語の有無によらず`dynamic`で拒否する。
 * 2. 空白か、シェルが語を分けるか展開する字を含む語(`script -c`や`ssh`の文字列など)と、標準入力の文字列は、コマンドとして読んで判定し直す。
 *    語の値の部分(`--opt=<値>`、`<キー>=<値>`、ページャーの初期コマンド、`!<値>`)も、語が同じ字を含めばコマンドとして読む。
 * 3. 前置きの後ろの起動語は、既存の分岐で判定し直す。
 * 4. 語は、共起で見る。
 * 文字列から読んだコマンドが読み取りの道具なら、通す。
 * 読み取りの道具が別のコマンドの実行を委ねる呼び出し(`delegatesExecution`)も、`from`を1にしてこの判定に通す。
 */
function underPrefixFinding(
  words: readonly Word[],
  from: number,
  context: HoldContext,
): HoldFinding | null {
  if (context.viaXargs || addsWordsOrRunsShell(words)) return "prefix";
  if (context.stdin.upstream.length > HOLD_MAX_UPSTREAM) return "dynamic";
  if (from === 0 && isReadOnlyProgram(baseName(words[0]?.text ?? ""), words)) {
    return null;
  }
  const readsStdin = words.some((word) =>
    STDIN_PREFIX_PROGRAMS.has(baseName(word.text)),
  );
  if (readsStdin && hasUnreadableStdin(context)) return "prefix";
  let found: HoldFinding | null = null;
  // 語を分けるか展開する字を含む語は、受け取った側が文字列としてシェルに渡すと複数の語になるので、コマンドとして読む。
  for (let at = from; at < words.length; at += 1) {
    const word = words[at];
    if (word === undefined || !splitsIntoWords(word.text)) continue;
    found = stronger(found, textFinding(word.text, context, "string"));
    if (found === "operation") return found;
  }
  // 語の`=`より後ろと、ページャーの初期コマンドや`!`の後ろは、コマンドとして実行されうる。起動語が前の部分に隠れないよう、値をコマンドとして読む。
  // 解析の回数は、値を読む`textFinding`が数える。
  for (const word of words.slice(from)) {
    const value = commandValue(word);
    if (value === null) continue;
    found = stronger(found, textFinding(value.text, context, "string"));
    if (found === "operation") return found;
  }
  for (const text of context.own() ?? []) {
    found = stronger(found, textFinding(text, context, "stdin"));
    if (found === "operation") return found;
  }
  found = stronger(found, launchersFinding(words, context));
  if (found === "operation") return found;
  return stronger(found, cooccurrenceFinding(words, from, context));
}

/**
 * 語を足す文脈の後ろで通す、読み取りの道具の閉じた集合。
 * 引数やオプションで別のプログラムの実行を委ねる機能を持たない道具だけを置く。
 * `NON_EXECUTING_PROGRAMS`は他の検査と共有し、`git`、`rg`、`sort`、`sed`、`tee`のような、
 * オプションで実行を委ねうる道具を含むので、ここでは使わない。
 * 要素から実行に届く経路が見つかったら、安全策を足さずに、その要素を外す。
 */
const WORD_ADDER_SAFE_PROGRAMS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "stat",
  "file",
  "basename",
  "dirname",
  "realpath",
  "echo",
  "printf",
]);

/** 先頭にあれば、後ろの語を実行する仕組みが集合の中の道具にも及ぶので、例外を作らないプログラム。 */
const WORD_ADDING_PROGRAMS: ReadonlySet<string> = new Set([
  "parallel",
  "watch",
  "strace",
]);

/**
 * プログラムの語が、名前そのものか絶対パスなら真。
 * `./cat`のようにリポジトリの中のファイルを指す相対パスは、同じ名前でも別のプログラムである。
 */
function isBareOrAbsolute(text: string): boolean {
  return !text.includes("/") || text.startsWith("/");
}

/** 語が、名前そのものか絶対パスで書かれ、実行時に決まる部分を持たないなら、プログラムの名前を返す。そうでなければnullを返す。 */
function programNameOf(word: Word | undefined): string | null {
  if (word === undefined || word.dynamic || word.glob) return null;
  const texts = [word.text, ...(word.variants ?? [])];
  const names = texts.map(baseName);
  const [name] = names;
  if (name === undefined || !names.every((other) => other === name)) {
    return null;
  }
  return texts.every(isBareOrAbsolute) ? name : null;
}

/** 実行される側の語が、読み取りの閉じた集合の道具なら真。 */
function isWordAdderSafe(word: Word | undefined): boolean {
  const name = programNameOf(word);
  return name !== null && WORD_ADDER_SAFE_PROGRAMS.has(name);
}

/** `startsWithInspectionTool`が先頭から読む語の数の上限。`find`の区間の後ろを、コピーせずに有限の長さで切り出すために使う。 */
const INSPECTION_LOOKAHEAD = 6;

/**
 * `find`の後ろで、検査の道具の前に読み飛ばす実行の語は`run`だけである。
 * `exec`は文字列をシェルのコードとして実行しうる。`x`は`exec`の別名にもなり(`npm x`)、
 * `dlx`は取得して実行する。実行系によっては、ツール名の後ろの語も自分のオプションとして読む。
 */
const FIND_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["run"]);

/**
 * `find`の実行系の式の後ろの、`start`番目の語から始まるコマンドが、検査の道具なら真。
 * `tsc`と`biome`自身か、実行系の最初のオペランドが検査の道具(`tsc`、`biome`、リポジトリの検査用スクリプト)である形を通す。
 * `node`、`tsx`、`ts-node`、`deno`は最初のオペランドをファイルとして実行するので、
 * 探索先に検査の道具と同じ名前のファイルがあると、それが実行される。新しいファイルを書いて実行する形として受け入れる。
 * `test`を最初のオペランドとする実行系(`bun test`、`deno test`、`npm test`)は、テストのファイルを読み込んで実行するので通さない。
 * `exec`、`x`、`dlx`を読み飛ばさない(`bun exec`は文字列をシェルのコードとして実行する)。
 * `find`が探索で見つけたパスは、起点を前に付けて渡すので`-`から始まらない。そのため、`find`の後ろに限って通す。
 * コマンド行に書いた起点は綴りのまま渡り、道具のオプションとして読まれうるが、
 * `tsc`と`biome`のオプションは、実行や保留の操作に届かないので受け入れる。
 */
function isInspectionCommandAt(words: readonly Word[], start: number): boolean {
  const name = programNameOf(words[start]);
  if (name === null) return false;
  if (name === "tsc" || name === "biome") return true;
  if (!RUNNERS.has(name)) return false;
  const operand = inspectionOperand(
    words.slice(start + 1, start + 1 + INSPECTION_LOOKAHEAD),
    FIND_RUNNER_SUBCOMMANDS,
  );
  return operand !== null && operand !== "test";
}

/**
 * `find`の実行系の式(`-exec`、`-execdir`、`-ok`、`-okdir`)のうち、実行される側が通す道具でないものがあれば真。
 * 式は`;`か`+`で閉じる。閉じるまでの`-exec`は、その式の引数である。
 * 語を1回だけ走査するので、閉じない式を多数並べても処理は語の数に比例する。
 */
function hasUnsafeFindExecution(words: readonly Word[]): boolean {
  let at = 0;
  while (at < words.length) {
    if (!FIND_EXECUTION.test(words[at]?.text ?? "")) {
      at += 1;
      continue;
    }
    const start = at + 1;
    if (
      !isWordAdderSafe(words[start]) &&
      !isInspectionCommandAt(words, start)
    ) {
      return true;
    }
    at = start;
    while (
      at < words.length &&
      words[at]?.text !== ";" &&
      words[at]?.text !== "+"
    ) {
      at += 1;
    }
    at += 1;
  }
  return false;
}

/**
 * 前置きの無い語を足す文脈で、実行される側が読み取りの閉じた集合に入らなければ`context`を返す。
 * 文脈は、`xargs`、`find`の実行系の式、先頭の`parallel`、`watch`、`strace`である。
 * 指す語、glob、パイプの上流は見ない。足される語は字面から読めないので、指す語の有無によらず拒否する。
 * - `xargs`: `stripWrappers`の後の先頭の語が実行される側である。`xargs`のオプションに知らないものがあるときと、
 *   置換のオプションや後ろの前置きで先頭の語が実行される側と決まらないときは、拒否する。
 *   標準入力からオプションが届くので、検査の道具は通さない。
 * - `find`: 実行系の式ごとの先頭の語が実行される側である。集合の道具か検査の道具だけを通す。`{}`自身が先頭の形は通さない。
 * - `parallel`、`watch`、`strace`: 例外を作らない。
 */
function wordAdderFinding(
  words: readonly Word[],
  context: HoldContext,
): HoldFinding | null {
  const program = baseName(words[0]?.text ?? "");
  if (WORD_ADDING_PROGRAMS.has(program)) return "context";
  // 実行される側の語が無い`xargs`は、`echo`を実行する。
  if (
    context.viaXargs &&
    (context.xargsUnknown || (words.length > 0 && !isWordAdderSafe(words[0])))
  ) {
    return "context";
  }
  if (program !== "find") return null;
  return hasUnsafeFindExecution(words) ? "context" : null;
}

/**
 * 値の中で、2度目のシェルが語を変える字。引用符、バックスラッシュ、globの字、ブレース。
 * 値は環境変数として別のプログラムに渡り、そのプログラムがシェルで再び読むことがある。
 * 残っていれば、字面で保留のコードを指していなくても、再び読んだ結果は決まらない。
 * `$`とバッククォートは、組み立てる形の分類として残す。
 */
const SECOND_SHELL_RESHAPES = /['"\\*?[{]/;

/**
 * 先頭の変数代入の値が、保留か凍結のコードか書き込みのタスク名を指すか、2度目のシェルで語が変わる字を含むなら`assignment`を返す。
 * 実行する側は問わない。
 */
function assignmentFinding(assignments: readonly Word[]): HoldFinding | null {
  const flagged = assignments.some((assignment) =>
    spellings(assignmentValue(assignment)).some(
      (text) => SECOND_SHELL_RESHAPES.test(text) || mentionsHoldOrFreeze(text),
    ),
  );
  return flagged ? "assignment" : null;
}

function holdOperationAt(
  words: readonly Word[],
  context: HoldContext,
): HoldFinding | null {
  if (deadlineExceeded(context.budget)) return "dynamic";
  // 前置きの後ろの文字列の中で、`xargs`が足す語は、先頭が何でも読めない。
  if (context.inString && context.viaXargs) return "prefix";
  const first = words[0]?.text ?? "";
  const program = baseName(first);
  if (PREFIX_PROGRAMS.has(program)) {
    return underPrefixFinding(words, 1, context);
  }
  const launched = launchedFinding(words, program, context);
  // 前置きの後ろの文字列の中のコマンドは、先頭が起動語でも、前置きの規則を重ねて当てる。
  // 起動語の判定は先頭の語から後ろしか見ず、語を足すコマンドやシェルを見ないためである。
  if (context.inString) {
    if (launched === "operation") return launched;
    return stronger(launched, underPrefixFinding(words, 0, context));
  }
  return stronger(launched, wordAdderFinding(words, context));
}

/**
 * 先頭が`mise`、実行系、`docker`と`psql`、保留や凍結のCLIの直接実行のとき、その分岐の判定を返す。
 * 先頭が読み取りの道具で、別のコマンドの実行を委ねる形(`delegatesExecution`)なら、前置きの後ろと同じ規則で判定する。
 * どれでもなければnullを返す。
 */
function launchedFinding(
  words: readonly Word[],
  program: string,
  context: HoldContext,
): HoldFinding | null {
  const first = words[0]?.text ?? "";
  const { inputs, stdin } = context;
  if (program === "mise") return miseFinding(words, inputs, stdin);
  if (RUNNERS.has(program)) return runnerFinding(words.slice(1), inputs, stdin);
  if (SQL_PROGRAMS.has(program)) {
    return sqlTouchesHolds(words, inputs) ? "operation" : null;
  }
  // `./scripts/freeze.ts release`のように、凍結のCLIを直接実行する形。
  if (direct0IsFreezeCli(words)) return freezeCliFinding(words, inputs);
  // `./scripts/hold.ts place`のように、スクリプトを直接実行する形。
  const direct = words[0];
  if (direct !== undefined && pointsAtHoldCode(direct)) {
    return HOLD_CLI.test(first) && words[1]?.text === "list"
      ? null
      : "operation";
  }
  // 読み取りの道具が別のコマンドの実行を委ねる形は、前置きの後ろと同じ規則で、次の語から調べる。
  if (delegatesExecution(program, words.slice(1))) {
    return underPrefixFinding(words, 1, context);
  }
  return null;
}

/**
 * 単純コマンドが、保留を置く・解除する操作、または端末の確認を通る凍結の書き込みなら、拒否の種類を返す。そうでなければnullを返す。
 * `words`は、変数代入と前置き(`env`、`timeout`、`mise exec --`など)を外した語である。
 * `inputs`は、標準入力に渡る文字列(ヒアドキュメントと、パイプの前の`echo`など)を返す。
 * `stdin`は、標準入力に流れ込むものの出どころ(リダイレクト、パイプの前のコマンド、動的な入力)である。
 * `viaXargs`は、前置きの`xargs`が標準入力の語を末尾に足すことを表す。
 * 実行系が標準入力をコードとして読む形で、出どころが保留か凍結のコード、または読めないものなら拒否する。
 * 先頭が`mise`、実行系、`docker`と`psql`、保留や凍結のCLIの直接実行なら、その引数を調べる。
 * 先頭が前置き(`script`、`unbuffer`、`caffeinate`、`/usr/bin/time`、`ssh`)なら、前置きの規則で調べる。
 * 先頭が読み取りの道具で、別のコマンドの実行を委ねる形(`git rebase`、`gh alias set`など)も、前置きの規則で調べる。
 * 前置きの無い語を足す文脈(`xargs`、`find`の実行系の式、`parallel`、`watch`、`strace`)は、
 * 実行される側が読み取りの閉じた集合に入らなければ拒否する。
 * 先頭の変数代入(`assignments`)の値が保留や凍結のコードを指していれば、実行する側によらず拒否する。
 * それ以外の先頭は調べず、nullを返す。
 * 読めないときはnullを返す。呼ばれるのは、必要になったときだけである。
 * `xargsUnknown`は`xargs`が実行するコマンドが先頭の語に決まらないこと、`clock`は判定の締め切りの時計である。
 * 時計を渡さないときは、呼び出しの時点から数える。
 */
export function findHoldOperation(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  stdin: HoldStdin = NO_STDIN,
  viaXargs = false,
  extras: {
    readonly assignments?: readonly Word[];
    readonly xargsUnknown?: boolean;
    readonly clock?: HoldClock;
  } = {},
): HoldFinding | null {
  // 代入の値の拒否と後ろの判定は合わせ、強い方(`operation`が最上位)を返す。
  const assigned = assignmentFinding(extras.assignments ?? []);
  const found = holdOperationAt(words, {
    inputs,
    own: inputs,
    stdin,
    depth: 0,
    budget: newBudget(extras.clock ?? holdClock()),
    viaXargs,
    xargsUnknown: extras.xargsUnknown ?? false,
    inString: false,
  });
  return stronger(assigned, found);
}

/**
 * Consoleの書き込みのscript(`console-scripts.ts`の一覧)の名前。解除のscriptと取消のscriptなどである。
 * 前後が英数字と`_`でないときだけ数え、通知の種類`hold_released`や、読み取りのscript`console_jobs`は取り違えない。
 */
const RELEASE_SCRIPT_NAME = new RegExp(
  `(?<![A-Za-z0-9_])(?:${CONSOLE_WRITE_SCRIPTS.join("|")})(?![A-Za-z0-9_])`,
);

/** 書き込みのscriptのファイル名。globが当たるかを見る対象である。 */
const RELEASE_FILE_NAMES: readonly string[] = CONSOLE_WRITE_SCRIPTS.flatMap(
  (name) => [name, `${name}.ts`, `${name}.script.yaml`, `${name}.script.lock`],
);

/**
 * 書き込みを拒む変数。凍結の変数、全停止の変数、全停止が止めた名前の記録である。globが当たるかを見る対象でもある。
 * 記録は、`mise run stop:restore`が有効に戻す名前の出どころなので、書き換えると戻す名前を変えられる。
 */
const GUARDED_VARIABLES: readonly string[] = [
  "f/factory/freezes",
  "f/factory/stop_all",
  "f/factory/stop_all_record",
];

/** 書き込みを拒む変数のパス。スラッシュはパーセント符号化でも数える。ほかの文字の符号化は、照合の前に`decodedForms`が解く。 */
const GUARDED_VARIABLE_PATH =
  /f(?:\/|%2[Ff])factory(?:\/|%2[Ff])(?:freezes|stop_all|stop_all_record)(?![A-Za-z0-9_])/;

/** 変数を書くURLの経路。読み取り(`get_value`など)は数えない。 */
const VARIABLE_WRITE_URL =
  /\/variables\/(?:update|create|delete)(?![A-Za-z0-9_])/i;

/** 変数を書くURLの経路の末尾の語。globが当たるかを見る対象である。 */
const VARIABLE_WRITE_ROUTES: readonly string[] = ["update", "create", "delete"];

/**
 * 解除scriptの名前が語にあっても、それだけでは何も実行しないプログラム。
 * 読み取り、検索、gitとgh、ファイルの整理、シェルの`for`と`select`の見出しである。
 * 名前と実行を表す語が並んだときは、このプログラムでも拒否する(`namesAndExecutes`)。
 * シェルは中身を別に調べるので、ここには置かない。
 */
const NON_EXECUTING_PROGRAMS: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "tree",
  "wc",
  "nl",
  "diff",
  "file",
  "stat",
  "du",
  "echo",
  "printf",
  "tee",
  "test",
  "[",
  "[[",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "cp",
  "mv",
  "rm",
  "touch",
  "mkdir",
  "realpath",
  "basename",
  "dirname",
  "for",
  "select",
]);

/**
 * 名前が、ファイルのパスの形の語にあるときだけ通すプログラム。
 * `sed`の`e`コマンドと、`bat`と`ag`の`--pager`は、文字列をコマンドとして実行できる。
 * `--pager`は、パスの形によらず、実行を委ねる形(`delegatesExecution`)としても扱う。
 */
const PATH_ONLY_PROGRAMS: ReadonlySet<string> = new Set(["sed", "bat", "ag"]);

/** ファイルのパスの形の語。空白、引用符、`;`、`|`、`#`などの文字を含まない。 */
const PATH_LIKE = /^[A-Za-z0-9_./@~+*?[\]{},-]+$/;

/** 実行を表す語。コマンドの語、コマンド文字列、標準入力の文字列を空白などで分けた1語として当てる。 */
const EXECUTION_TOKENS: ReadonlySet<string> = new Set([
  "wmill",
  "curl",
  "wget",
  "http",
  "xh",
  "httpie",
  "npx",
  "bunx",
  "pnpm",
  "pnpx",
  "yarn",
  "deno",
  "bun",
  "node",
  "python",
  "python3",
  "sh",
  "bash",
  "zsh",
  "dash",
]);

/** 実行を表す部分文字列。URLの経路の一部として現れる。 */
const EXECUTION_FRAGMENTS: readonly string[] = [
  "windmill-cli",
  "run_wait_result",
  "/jobs/run",
];

/**
 * `git`の、別のコマンドの実行を委ねないと分かっている副コマンド。一覧の外の副コマンドと別名は、実行を委ねる形として扱う。
 * 別のコマンドを実行する副コマンド、設定を書く副コマンド、引数を別のリポジトリのgitへ渡す副コマンドは、版ごとに増える開いた集合なので、許す側を閉じた一覧にする。
 * 一覧の中の副コマンドでも、実行を委ねるオプション(`GIT_DELEGATING_LONG_OPTIONS`など)があれば委ねる形として扱う。
 */
const GIT_INERT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "blame",
  "branch",
  "cat-file",
  "check-ignore",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "describe",
  "diff",
  "diff-tree",
  "fetch",
  "for-each-ref",
  "grep",
  "help",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge",
  "merge-base",
  "mv",
  "name-rev",
  "pull",
  "push",
  "reflog",
  "remote",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "rm",
  "shortlog",
  "show",
  "show-ref",
  "stash",
  "status",
  "switch",
  "symbolic-ref",
  "tag",
  "version",
  "worktree",
]);

/** `git`の、値を取らず、別のコマンドの実行を委ねないグローバルのオプション。一覧の外のオプションは、実行を委ねる形として扱う。 */
const GIT_INERT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--version",
  "--help",
  "-h",
]);

/** `git`の、値を次の語に取り、別のコマンドの実行を委ねないグローバルのオプション。 */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

/** `git`の、値を`=`でくっつけて取り、別のコマンドの実行を委ねないグローバルのオプションの前の部分。 */
const GIT_OPTIONS_WITH_ATTACHED_VALUE: readonly string[] = [
  "--git-dir=",
  "--work-tree=",
  "--namespace=",
];

/**
 * 副コマンドの後ろで、実行するコマンドを受け取るか、設定のコマンドを起動する`git`の長いオプションの名前。
 * gitは長いオプションの一意な省略形を受け付けるので、名前の前方一致で見る(`isDelegatingLongOption`)。
 * 委ねない副コマンドの一覧(`GIT_INERT_SUBCOMMANDS`)の中の副コマンドが受け付けるものだけを置く。
 * 一覧の外の副コマンドだけが受け付けるもの(送信の副コマンドのオプションなど)は、副コマンドの判定で委ねる形になるので置かない。
 * 置くと、前方が重なる読み取りのオプションまで委ねる形にするためである。
 */
const GIT_DELEGATING_LONG_OPTIONS: readonly string[] = [
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--ext-diff",
  "--open-files-in-pager",
  "--textconv",
];

/**
 * 語が、`options`のどれかの長いオプションか、その省略形なら真。
 * 語の`=`より前を名前とし、`--`の後ろに`minimum`字以上あって、どれかのオプションの名前がその名前で始まるか、その名前がオプションの名前で始まるときである。
 * 一意かは確かめない。ほかのオプションの省略形と重なっても、委ねる側に倒れるだけである。
 */
function isDelegatingLongOption(
  text: string,
  options: readonly string[],
  minimum: number,
): boolean {
  if (!text.startsWith("--")) return false;
  const equals = text.indexOf("=");
  const name = equals === -1 ? text : text.slice(0, equals);
  if (name.length < 2 + minimum) return false;
  return options.some(
    (option) => option.startsWith(name) || name.startsWith(option),
  );
}

/** 語が、`-`で始まり`--`で始まらない短いオプションのまとめ書きで、`letter`を含むなら真。 */
function hasShortOption(text: string, letter: string): boolean {
  return (
    text.startsWith("-") && !text.startsWith("--") && text.includes(letter)
  );
}

/** 短いオプションの文字で、実行するコマンドを受け取る`git`の副コマンド。`grep`のページャーと、`ls-remote`の送信側のプログラムである。 */
const GIT_DELEGATING_SHORT_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["grep", "O"],
  ["ls-remote", "u"],
]);

/**
 * `git -c`で付けても、値がコマンドとして実行されないキー(小文字で比べる)。一覧の外のキーは、実行を委ねる形として扱う。
 * 値が実行されるキーは、版ごとに増える開いた集合なので、拒否する側ではなく許す側を閉じた一覧にする。
 * 値が実行されなくても、他の所有者のリポジトリの設定を有効にするキーは入れない。その設定の中の、値が実行されるキーが効くためである。
 */
const GIT_INERT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "user.name",
  "user.email",
  "core.quotepath",
  "core.autocrlf",
  "core.safecrlf",
  "core.abbrev",
  "core.filemode",
  "init.defaultbranch",
  "commit.gpgsign",
  "tag.gpgsign",
]);

/** 下の名前を問わず、値がコマンドとして実行されないキーの接頭辞。 */
const GIT_INERT_CONFIG_PREFIXES: readonly string[] = ["color.", "advice."];

/** `<キー>=<値>`か`<キー>`の文字列のキーが、値を実行しない一覧にあるなら真。 */
function isInertGitConfigText(text: string): boolean {
  const equals = text.indexOf("=");
  const key = (equals === -1 ? text : text.slice(0, equals)).toLowerCase();
  return (
    GIT_INERT_CONFIG_KEYS.has(key) ||
    GIT_INERT_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * `git -c`の値の語の、先頭の`skip`文字より後ろのキーが、値を実行しない一覧にあるなら真。
 * `skip`は、くっついた形(`-c<キー>=<値>`)の`-c`を外すために使う。
 * 語が無いか、実行時に決まるかglobなら、キーが決まらないので偽にする。
 * NULを除いた綴りも、すべて一覧に当たるときだけ真にする。
 */
function isInertGitConfig(word: Word | undefined, skip = 0): boolean {
  if (word === undefined || word.dynamic || word.glob) return false;
  return [word.text, ...(word.variants ?? [])].every((text) =>
    isInertGitConfigText(text.slice(skip)),
  );
}

/** `find`が別のコマンドを実行する式。 */
const FIND_EXECUTION = /^-(?:exec|execdir|ok|okdir)$/;

/** `wmill`のうち、実行や投入を起こす語。 */
const WMILL_EXECUTION_WORDS: ReadonlySet<string> = new Set([
  "run",
  "preview",
  "rerun",
  "restart",
]);

/** `wmill`のうち、解除scriptを実行せずに読む・配る副コマンド。 */
const WMILL_READ_WORDS: ReadonlySet<string> = new Set([
  "get",
  "show",
  "list",
  "ls",
  "logs",
  "result",
  "history",
  "push",
  "pull",
  "generate-metadata",
  "lint",
  "status",
]);

/** `wmill variable`で変数を書く副コマンド。 */
const VARIABLE_WRITE_WORDS: ReadonlySet<string> = new Set(["add", "push"]);

/** `mise`でリポジトリのタスクを走らせる語。 */
const MISE_TASK_WORDS: ReadonlySet<string> = new Set(["run", "r"]);

/**
 * Consoleの解除を1コマンドで起こす形の種類。
 * `script`は解除scriptの名前が当たる実行、`variable`は凍結の変数への書き込みである。
 */
export type ConsoleReleaseFinding = "script" | "variable";

/**
 * 判定に使う、コマンドの外にある入力。
 * `inputs`は標準入力に渡る文字列(ヒアドキュメント、ヒアストリング、パイプの連鎖の`echo`)。
 * `assignments`は変数代入の語、`upstream`はパイプの上流のコマンドの語(すべて)である。
 */
export type ReleaseCallContext = {
  readonly inputs: () => readonly string[] | null;
  readonly assignments: readonly Word[];
  readonly upstream: readonly Word[];
  /** `xargs`が前置きにあり、標準入力の語を引数に足して実行する。 */
  readonly viaXargs: boolean;
};

/**
 * 文字列の綴り。ブレースは、展開した形に加えて、括弧だけを外した形も足す。
 * カンマの無い`{x}`は、シェルは展開しないが、curlは外して読むためである。
 * ブレースの範囲は、展開される字の集合(`rangeAsGlob`)に置き換えた形も足す。globと同じに照合するためである。
 */
function releaseForms(text: string): string[] {
  const forms = [text, ...expandBraces(text)];
  const ranged = forms.flatMap((form) => rangeAsGlob(form) ?? []);
  const all = [...forms, ...ranged];
  return [...all, ...all.map((form) => form.replace(/[{}]/g, ""))];
}

/** 語の綴りをすべて返す。NULを除いた綴りとブレースの形を含む。 */
function wordForms(word: Word): string[] {
  return spellings(word).flatMap(releaseForms);
}

/**
 * globを判定する単位。文字列を空白と引用符で分け、URLの`?`と`#`より後ろを切った形も足す。
 * 後ろに`?x=1`や`#x`が続いても、パスの部分のglobが名前に当たるかを見るためである。
 */
function patternTokens(text: string): string[] {
  const tokens = text.split(/[\s"']+/).filter((token) => token !== "");
  return tokens.flatMap((token) => {
    const cut = token.split(/[?#]/)[0] ?? token;
    return cut === token || cut === "" ? [token] : [token, cut];
  });
}

/**
 * globの語が、名前を狙った書き方に見えるなら真。
 * `*`だけの語(`docker compose config --hash '*'`、`for f in scripts/*`)は数えない。
 * 括弧の外に英字と`_`が3文字以上あれば、名前を狙ったものとして数える。
 */
function aimsAtName(file: string): boolean {
  return file.replace(/\[[^\]]*\]/g, "").replace(/[^A-Za-z_]/g, "").length >= 3;
}

/** 文字列が、解除scriptの名前を含むか、globがファイル名に当たりうるなら真。 */
function mentionsRelease(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      RELEASE_SCRIPT_NAME.test(form) ||
      patternTokens(form).some((token) => {
        const file = token.slice(token.lastIndexOf("/") + 1);
        return (
          GLOB_CHARACTERS.test(file) &&
          aimsAtName(file) &&
          RELEASE_FILE_NAMES.some((name) => globMatches(file, name))
        );
      }),
  );
}

/**
 * 語と、パーセント符号化を解いた語。`stop%5Fall`のように符号化した名前も照合するためである。
 * 解けない語(不正な`%`の並び)は、元の語だけにする。
 */
function decodedForms(text: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    return [text];
  }
  return decoded === text ? [text] : [text, decoded];
}

/** 文字列が、書き込みを拒む変数のパスか、それに当たりうるglobを含むなら真。 */
function mentionsGuardedVariable(text: string): boolean {
  return decodedForms(text).some(mentionsGuardedVariableForm);
}

function mentionsGuardedVariableForm(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      GUARDED_VARIABLE_PATH.test(form) ||
      patternTokens(form).some((token) => {
        const tail = token.split("/").slice(-3).join("/");
        return (
          GLOB_CHARACTERS.test(tail) &&
          aimsAtName(tail) &&
          GUARDED_VARIABLES.some((variable) => globMatches(tail, variable))
        );
      }),
  );
}

/** 文字列が、変数を書くURLの経路か、それに当たりうるglobを含むなら真。 */
function mentionsVariableWriteUrl(text: string): boolean {
  return decodedForms(text).some(mentionsVariableWriteUrlForm);
}

function mentionsVariableWriteUrlForm(text: string): boolean {
  return releaseForms(text).some(
    (form) =>
      VARIABLE_WRITE_URL.test(form) ||
      patternTokens(form).some((token) => {
        const parts = token.split("/");
        return parts.some((part, index) => {
          const route = parts[index + 1] ?? "";
          return (
            GLOB_CHARACTERS.test(`${part}${route}`) &&
            (part === "variables" || globMatches(part, "variables")) &&
            aimsAtName(route) &&
            VARIABLE_WRITE_ROUTES.some((name) => globMatches(route, name))
          );
        });
      }),
  );
}

/**
 * 語の綴りのどれかが`test`に当たるかの記録。パイプの上流の語は、続くコマンドごとに読み直されるので、
 * 語と判定の組ごとに1回だけ調べる。長いパイプラインで、処理が語の数の2乗に増えないようにするためである。
 */
const WORD_MATCHES = new WeakMap<
  Word,
  Map<(text: string) => boolean, boolean>
>();

function wordMatches(word: Word, test: (text: string) => boolean): boolean {
  let tests = WORD_MATCHES.get(word);
  if (tests === undefined) {
    tests = new Map();
    WORD_MATCHES.set(word, tests);
  }
  const cached = tests.get(test);
  if (cached !== undefined) return cached;
  const matched = wordForms(word).some(test);
  tests.set(test, matched);
  return matched;
}

function anyWord(words: readonly Word[], test: (text: string) => boolean) {
  return words.some((word) => wordMatches(word, test));
}

/** 文字列に、実行を表す語が1つでもあれば真。 */
function hasExecutionToken(text: string): boolean {
  if (EXECUTION_FRAGMENTS.some((fragment) => text.includes(fragment))) {
    return true;
  }
  return text.split(/[\s"'`;|&()<>=:,]+/).some((raw) => {
    const token = baseName(raw).replace(VERSION_SUFFIX, "");
    return EXECUTION_TOKENS.has(token);
  });
}

/** 語に、変数を書く副コマンドと、書き込みを拒む変数のパスがそろっているなら真。 */
function writesGuardedVariable(words: readonly Word[]): boolean {
  const texts = words.map((word) => word.text);
  return (
    texts.includes("variable") &&
    texts.some((text) => VARIABLE_WRITE_WORDS.has(text)) &&
    anyWord(words, mentionsGuardedVariable)
  );
}

function wmillPositional(args: readonly Word[]): string[] {
  return args
    .filter((word) => !word.text.startsWith("-"))
    .map((word) => word.text);
}

/**
 * `wmill jobs push`なら真。
 * 待ち行列のファイルからジョブを積むので、解除scriptの名前が語に現れない。
 */
function pushesJobs(positional: readonly string[]): boolean {
  return (
    positional.some((text) => text === "job" || text === "jobs") &&
    positional.includes("push")
  );
}

/** `wmill`の位置引数が、解除scriptを実行せずに読む・配る形なら真。 */
function wmillReadsOnly(positional: readonly string[]): boolean {
  return (
    !pushesJobs(positional) &&
    !positional.some((text) => WMILL_EXECUTION_WORDS.has(text)) &&
    positional.some((text) => WMILL_READ_WORDS.has(text))
  );
}

/**
 * シェルの語から、起動オプションを読んで決まった`-c`のコマンド文字列を除いた語を返す。
 * コマンド文字列は再帰で別に調べるので、位置引数と`$0`、スクリプトのオペランドだけを残す。
 * 文字列の位置で外し、綴りでは外さない。起動オプションを読み切れないときは、どの語も外さない。
 * 標準入力の有無は文字列の位置に効かないので、偽を渡す。
 */
function shellOperands(shell: string, args: readonly Word[]): readonly Word[] {
  const launch = readShellLaunch(shell, args, false);
  if (!launch.ok || launch.scriptIndex === null) return args;
  const at = launch.scriptIndex;
  return args.filter((_, index) => index !== at);
}

type ReaderKind = "plain" | "path-only";

/** 名前が語にあっても、それだけでは何も実行しないと言えるコマンドの種類。そうでなければnull。 */
function readerKind(
  program: string,
  words: readonly Word[],
): ReaderKind | null {
  if (NON_EXECUTING_PROGRAMS.has(program)) return "plain";
  if (PATH_ONLY_PROGRAMS.has(program)) return "path-only";
  if (program === "find") {
    return words.some((word) => FIND_EXECUTION.test(word.text))
      ? null
      : "plain";
  }
  if (program === "mise") {
    return words.slice(1, 5).some((word) => MISE_TASK_WORDS.has(word.text))
      ? "plain"
      : null;
  }
  return RUNNERS.has(program) && startsWithInspectionTool(words.slice(1))
    ? "plain"
    : null;
}

/**
 * 副コマンドより前の語(グローバルのオプション)を読む。
 * 副コマンドの位置を返す。実行を委ねる形か、閉じた一覧の外のオプションがあれば`delegates`を返す。副コマンドが無ければnullを返す。
 * `-c`のキーは、値がコマンドとして実行されないキーの一覧だけを通す。
 */
function gitSubcommandAt(args: readonly Word[]): number | "delegates" | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    const { text } = word;
    if (text === "-c") {
      index += 1;
      if (!isInertGitConfig(args[index])) return "delegates";
    } else if (text.startsWith("-c")) {
      if (!isInertGitConfig(word, 2)) return "delegates";
    } else if (GIT_OPTIONS_WITH_VALUE.has(text)) {
      index += 1;
    } else if (
      GIT_INERT_GLOBAL_FLAGS.has(text) ||
      GIT_OPTIONS_WITH_ATTACHED_VALUE.some((prefix) => text.startsWith(prefix))
    ) {
      // 値を取らないか、値を`=`でくっつけた、委ねないオプション。
    } else if (text.startsWith("-")) {
      // 環境変数から読む設定、副コマンドの実体の置き場所、知らないオプションは、委ねる形に倒す。
      return "delegates";
    } else {
      return index;
    }
  }
  return null;
}

/**
 * `git`の呼び出しが、別のコマンドを実行する設定、副コマンド、オプションを持つなら真。
 * 副コマンドは閉じた一覧(`GIT_INERT_SUBCOMMANDS`)の中だけを委ねない形とし、一覧の外と、実行時に決まる語とglobは委ねる形とする。
 * 一覧の中の副コマンドでも、後ろの語に実行を委ねるオプションか、その省略形があれば委ねる形とする。
 */
function gitExecutes(args: readonly Word[]): boolean {
  const at = gitSubcommandAt(args);
  if (at === null) return false;
  if (at === "delegates") return true;
  const subcommand = args[at];
  if (
    subcommand === undefined ||
    subcommand.dynamic ||
    subcommand.glob ||
    !GIT_INERT_SUBCOMMANDS.has(subcommand.text)
  ) {
    return true;
  }
  const letter = GIT_DELEGATING_SHORT_OPTIONS.get(subcommand.text);
  return args
    .slice(at + 1)
    .some(
      (word) =>
        isDelegatingLongOption(word.text, GIT_DELEGATING_LONG_OPTIONS, 1) ||
        (letter !== undefined && hasShortOption(word.text, letter)),
    );
}

/** `gh`の、extensionを扱うグループの名前。 */
const GH_EXTENSION_GROUPS: ReadonlySet<string> = new Set([
  "extension",
  "extensions",
  "ext",
]);

/**
 * `gh`の、読み取りと日常の操作のグループ。別名、設定、extension、codespace、秘密値と変数のグループは入れない。
 * 位置引数に実行時に決まる語があっても、最初の位置引数がこの一覧にあれば、グループが決まったものとして扱う。
 */
const GH_INERT_GROUPS: ReadonlySet<string> = new Set([
  "pr",
  "issue",
  "api",
  "run",
  "repo",
  "release",
  "workflow",
  "search",
  "label",
  "status",
  "browse",
  "cache",
  "gist",
  "auth",
  "ruleset",
  "project",
  "org",
]);

/**
 * `gh`の呼び出しが、別名、extension、設定の書き込み、gitへ渡す引数で、コマンドを足すか実行するものなら真。
 * 値を取るフラグが副コマンドの前にも置けるので、位置引数の位置は見ず、語の有無で見る。
 * 設定は、キーを問わず書き込みを委ねる形にする。後から別のコマンドが値を実行するキーがあるためである。
 * `--`の後ろは、`repo clone`や`repo fork`がgitへ渡すので、グループを問わず委ねる形にする。
 * 位置引数に実行時に決まる語かglobがあれば、その語が別名や設定を表しうる。
 * 最初の位置引数が読み取りと日常の操作のグループ(`GH_INERT_GROUPS`)に無いか、設定する語か取り込む語があるときは、委ねる形にする。
 * 最初の位置引数は値を取るフラグの値のこともあるが、そのときも設定する語か取り込む語があれば委ねる形になる。
 */
function ghExecutes(args: readonly Word[]): boolean {
  const positional = args.filter((word) => !word.text.startsWith("-"));
  const texts = new Set(positional.map((word) => word.text));
  const writes = texts.has("set") || texts.has("import");
  if (positional.some((word) => word.dynamic || word.glob)) {
    const first = positional[0];
    const inertGroup =
      first !== undefined &&
      !first.dynamic &&
      !first.glob &&
      GH_INERT_GROUPS.has(first.text);
    if (!inertGroup || writes) return true;
  }
  return (
    (texts.has("alias") && writes) ||
    (texts.has("config") && texts.has("set")) ||
    [...GH_EXTENSION_GROUPS].some((group) => texts.has(group)) ||
    args.some((word) => word.text === "--")
  );
}

/**
 * `+`で始まる語を、起動したときに実行する初期コマンドとして受け取るページャー。
 * 初期コマンドの`!`は、シェルのコマンドを実行する。macOSの`more`は`less`である。
 */
const INITIAL_COMMAND_PROGRAMS: ReadonlySet<string> = new Set(["less", "more"]);

/** 語のどれかが、オプション`name`そのものか、`name=`で始まるなら真。 */
function hasOption(args: readonly Word[], name: string): boolean {
  return args.some(
    (word) => word.text === name || word.text.startsWith(`${name}=`),
  );
}

/**
 * 何も実行しないはずのプログラムが、副コマンド、設定、オプションで別のコマンドの実行を委ねる形なら真。
 * gitとghの副コマンドと設定、`rg`の前処理、`ag`と`bat`のページャー、`less`と`more`の初期コマンドである。
 * `ag`は長いオプションの一意な省略形を受け付けるので、ページャーのオプションを前方一致で見る。`bat`は省略形を受け付けない。
 * `less`と`more`の初期コマンドは、短いオプションのまとめ書きの中の`+`も数える。
 * 保留・凍結、全停止、Consoleのscriptの判定が、この関数で委ねる形を見分ける。
 */
function delegatesExecution(program: string, args: readonly Word[]): boolean {
  if (program === "git") return gitExecutes(args);
  if (program === "gh") return ghExecutes(args);
  if (program === "rg") return hasOption(args, "--pre");
  if (program === "bat") return hasOption(args, "--pager");
  if (program === "ag") {
    // `--pa`は、ほかのオプションと重なって一意にならない。
    return args.some((word) =>
      isDelegatingLongOption(word.text, ["--pager"], 3),
    );
  }
  if (INITIAL_COMMAND_PROGRAMS.has(program)) {
    return args.some(
      (word) => word.text.startsWith("+") || hasShortOption(word.text, "+"),
    );
  }
  return false;
}

/**
 * 何も実行しないはずのコマンドの語に名前が当たるとき、拒否する理由があるなら真。
 * 名前と実行を表す語が並ぶとき、実行を委ねるオプションがあるとき、
 * ファイルのパスの形だけを通すプログラムで、名前がパスの形でない語にあるときである。
 * 実行を表す語は、先頭の語(プログラム自身)を除いて探す。
 */
function readerRefuses(
  kind: ReaderKind,
  program: string,
  words: readonly Word[],
  context: ReleaseCallContext,
  texts: readonly string[],
): boolean {
  const args = words.slice(1);
  if (delegatesExecution(program, args)) return true;
  if (
    kind === "path-only" &&
    words.some(
      (word) =>
        wordForms(word).some(mentionsRelease) && !PATH_LIKE.test(word.text),
    )
  ) {
    return true;
  }
  const sources = [
    ...args.map((word) => word.text),
    ...context.assignments.map((word) => word.text),
    ...texts,
  ];
  return sources.some(hasExecutionToken);
}

/**
 * 単純コマンドが、Consoleの解除scriptを実行しうるか、凍結の変数を書く形なら、その種類を返す。そうでなければnullを返す。
 * セッションの種類は問わない。`words`は、変数代入と前置きを外した語である。
 * 解除scriptの名前を軸にして、拒否を既定にする。プログラムの種類を問わず、語、変数代入の値、標準入力の文字列に、
 * 名前、名前に当たりうるglob、ブレースの形があれば`script`を返す。名前を標準入力で受ける`xargs`も同じである。
 * 例外は次のとおりである。
 * - 読み取りなどのプログラム(`NON_EXECUTING_PROGRAMS`と、`bun test`などの検査の道具)。名前と実行を表す語が並ぶとき、
 *   実行を委ねるオプション(一覧の外のキーの`git -c`、`rebase`、`gh alias set`、`rg --pre`など)があるとき、変数代入の値に名前があるときは拒否する。
 * - `sed`、`bat`、`ag`。名前がファイルのパスの形の語にあるときだけ通す。
 * - シェル。起動オプションを読んで決まった`-c`の文字列は再帰で別に調べるので、それ以外の語と標準入力の文字列に名前があるときだけ拒否する。
 * - `wmill`が解除scriptを実行せずに読む・配る副コマンド(`script get`、`job list`、`script push`など)。
 * `wmill jobs push`は名前なしで`script`を返す。
 * 凍結の変数は、`variable add/push`の語と、変数を書くURLの経路に、凍結の変数のパスが当たるときに`variable`を返す。
 */
export function findConsoleReleaseCall(
  words: readonly Word[],
  context: ReleaseCallContext,
): ConsoleReleaseFinding | null {
  const program = baseName(words[0]?.text ?? "");
  const literal = context.inputs() ?? [];
  if (anyWord(context.assignments, mentionsRelease)) return "script";
  const invocation = shellInvocation(words);
  if (invocation !== null) {
    return anyWord(
      shellOperands(invocation.shell, invocation.args),
      mentionsRelease,
    ) ||
      anyWord(context.upstream, mentionsRelease) ||
      literal.some(mentionsRelease)
      ? "script"
      : null;
  }
  if (program === "wmill") {
    if (writesGuardedVariable(words)) return "variable";
    const args = words.slice(1);
    const positional = wmillPositional(args);
    if (pushesJobs(positional)) return "script";
    const named =
      anyWord(args, mentionsRelease) ||
      anyWord(context.upstream, mentionsRelease) ||
      literal.some(mentionsRelease);
    return named && !wmillReadsOnly(positional) ? "script" : null;
  }
  const kind = readerKind(program, words);
  const named =
    anyWord(words, mentionsRelease) ||
    literal.some(mentionsRelease) ||
    (context.viaXargs && anyWord(context.upstream, mentionsRelease));
  if (kind !== null) {
    return named && readerRefuses(kind, program, words, context, literal)
      ? "script"
      : null;
  }
  if (named || anyWord(context.upstream, mentionsRelease)) return "script";
  if (writesGuardedVariable(words)) return "variable";
  const writesUrl =
    anyWord(words, mentionsVariableWriteUrl) ||
    literal.some(mentionsVariableWriteUrl);
  const namesGuarded =
    anyWord(words, mentionsGuardedVariable) ||
    literal.some(mentionsGuardedVariable);
  return writesUrl && namesGuarded ? "variable" : null;
}

/**
 * 全停止のCLIを指すパスの末尾。保留のコードと同じ区切りの直後の`stop_all`で、拡張子は省略できる。
 * `stop_all.test.ts`、`stop_all_excludes.ts`のような別のファイルには当たらない。
 */
const STOP_ALL_MENTION =
  /(?:^|[/'"`\s(=,[{])stop_all(?:\.[cm]?[jt]sx?)?(?![A-Za-z0-9_.-])/i;

/** 全停止のCLIのファイル名。globが当たるかを見る対象である。 */
const STOP_ALL_FILE_NAMES: readonly string[] = ["stop_all", "stop_all.ts"];

/** 全停止を置く・解除するmiseのタスクと、全停止が止めた設定を記録から戻すタスク。 */
const STOP_ALL_TASKS: readonly string[] = [
  "stop",
  "stop:release",
  "stop:restore",
];

/** 語が全停止のCLIを指すか、引用符の外のglobかブレースの範囲が全停止のCLIの名前に当たりうるなら真。ディレクトリは問わない。 */
function pointsAtStopAllCode(word: Word): boolean {
  return pointsAtCode(word, STOP_ALL_MENTION, STOP_ALL_FILE_NAMES);
}

/** 実行系の引数が、全停止のCLIを実行する形なら真。検査の道具が最初のオペランドなら、実行ではないので通す。 */
function runnerStopAllCall(
  args: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const inInput =
    inputs()?.some((text) => STOP_ALL_MENTION.test(text)) ?? false;
  if (inInput) return true;
  return args.some(pointsAtStopAllCode) && !startsWithInspectionTool(args);
}

/** `mise`のコマンド行が、全停止を置く・解除するタスクを走らせる形なら真。 */
function miseStopAllCall(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
): boolean {
  const scan = scanMiseGlobalOptions(words, 1);
  const args = words.slice(scan.next);
  const subcommand = args[0];
  if (subcommand === undefined) return false;
  const execAt = args.findIndex(
    (word) => word.text === "exec" || word.text === "x",
  );
  if (execAt !== -1 && runnerStopAllCall(args.slice(execAt + 1), inputs)) {
    return true;
  }
  // `mise tasks`は、`run`が付かず、後ろの最初の語が実行の語に当たりうる読めない語でない限り、タスクの一覧や情報を出すだけである。
  const listsOnly =
    MISE_TASKS_WORDS.has(subcommand.text) &&
    !args.some((word) => MISE_RUNNING_WORDS.has(word.text)) &&
    !miseTasksRunsUnreadably(args);
  if (listsOnly) return false;
  // `--`より後ろはタスクへの引数なので、タスクの名前としては見ない。
  const dashAt = args.findIndex((word) => word.text === "--");
  const taskWords = dashAt === -1 ? args : args.slice(0, dashAt);
  return taskWords.some((word) =>
    STOP_ALL_TASKS.some((task) => namesTask(word, task)),
  );
}

/** 全停止の変数のパス(`f/factory/stop_all`と`f/factory/stop_all_record`)。CLIのファイル名とは別のものである。 */
const STOP_ALL_VARIABLE_PATH = /(?:^|[^A-Za-z0-9_])f\/factory\/stop_/;

/** 全停止のタスク名を、区切られた語として含む字面。 */
const STOP_ALL_TASK_WORDING = new RegExp(
  `(?:^|[^\\w:-])(?:${STOP_ALL_TASKS.join("|")})(?![\\w:-])`,
);

/** `mise`を、区切られた語として含む字面。 */
const MISE_WORDING = /(?:^|[^\w-])mise(?![\w-])/;

/** 文字列が、全停止のCLIを指す字面か、`mise`と全停止のタスク名が並ぶ字面を持つなら真。 */
function stopAllWording(text: string): boolean {
  return (
    STOP_ALL_MENTION.test(text) ||
    (MISE_WORDING.test(text) && STOP_ALL_TASK_WORDING.test(text))
  );
}

/**
 * 読めない文字列と、入れ子が深さの上限を超えた文字列の字面が、全停止を指すなら真。
 * 全停止のCLIを指す語か、`mise`と全停止のタスク名が並ぶ字面である。
 * 読めない文字列を一律に拒否すると、SQLやJSONの引数のような読み取りまで止まるので、字面で絞る。
 * 引用符とバックスラッシュを除いた綴りでも判定する。語の途中の空の引用で名前を分けた形を見落とさないためである。
 */
function unreadableTextStopAll(word: Word): boolean {
  if (pointsAtStopAllCode(word)) return true;
  return spellings(word).some(
    (text) => stopAllWording(text) || stopAllWording(unquotedText(text)),
  );
}

/** 空白を含む語が、中に全停止の入口を実行する形を持つか。読めない文字列は、字面で判定する。 */
function textStopAllCall(
  word: Word,
  inputs: () => readonly string[] | null,
  depth: number,
): boolean {
  const parsed =
    depth >= COMMAND_TEXT_MAX_DEPTH ? null : parseCommandLine(word.text);
  if (parsed === null || !parsed.ok) return unreadableTextStopAll(word);
  return parsed.commands.some((command) => {
    const stripped = stripWrappers(command.words);
    const inner = stripped.words;
    // 起動語を値に持つ代入の形の語は、値と後ろの語の組がコマンドとして実行されうる。
    const launched = stripped.assignments
      .map(assignmentValue)
      .filter(launchesWithArguments)
      .some((value) => stopAllCallAt([value, ...inner], inputs, depth + 1));
    return (
      launched || (inner.length > 0 && stopAllCallAt(inner, inputs, depth + 1))
    );
  });
}

/**
 * 語が全停止のCLIを指すか、空白を含む語なら中のコマンドが全停止の入口を実行する形なら真。
 * 語の値の部分(`commandValue`)も、入れ子を1段深くして同じ規則で判定する。
 * 深さの上限に達したら、値を取り出さずに語の字面で判定する。値の中の値を重ねた語でも、上限の段数で終わる。
 */
function wordStopAllCall(
  word: Word,
  inputs: () => readonly string[] | null,
  depth: number,
): boolean {
  // 語の`=`より後ろと、ページャーの初期コマンドや`!`の後ろは、コマンドとして実行されうるので、値も判定する。
  const value = commandValue(word);
  if (value !== null) {
    if (depth >= COMMAND_TEXT_MAX_DEPTH) {
      if (unreadableTextStopAll(word)) return true;
    } else if (wordStopAllCall(value, inputs, depth + 1)) {
      return true;
    }
  }
  if (/\s/.test(word.text)) return textStopAllCall(word, inputs, depth);
  // 全停止の変数のパスは、読み取りの引数にも現れる。書き込みは変数の判定(`findConsoleReleaseCall`)が止める。
  return pointsAtStopAllCode(word) && !STOP_ALL_VARIABLE_PATH.test(word.text);
}

function stopAllCallAt(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  depth: number,
): boolean {
  const program = baseName(words[0]?.text ?? "");
  if (program === "mise") return miseStopAllCall(words, inputs);
  if (RUNNERS.has(program)) return runnerStopAllCall(words.slice(1), inputs);
  // 読み取りのプログラムでも、別のコマンドの実行を委ねる形は免除しない。
  // 免除をパスの形だけを通す規則(`isReadOnlyProgram`)に置き換えないのは、`bat -r 1:10 <パス>`のような読み取りを止めないためである。
  const delegates = delegatesExecution(program, words.slice(1));
  if (
    !delegates &&
    (readerKind(program, words) !== null || INSPECTION_TOOLS.has(program))
  ) {
    return false;
  }
  // 委ねる先は読めない形が多いので、語と標準入力の文字列に全停止を指す字面があれば拒否する。
  if (
    delegates &&
    (words.some(unreadableTextStopAll) || (inputs() ?? []).some(stopAllWording))
  ) {
    return true;
  }
  // `script`や`caffeinate`のような前置きの後ろに`mise`か実行系が続く形は、その位置から判定する。
  const launcherAt = words.findIndex((word, index) => {
    return index > 0 && isLauncherName(baseName(word.text));
  });
  if (launcherAt === -1) {
    return words.some((word) => wordStopAllCall(word, inputs, depth));
  }
  if (
    words
      .slice(0, launcherAt)
      .some((word) => wordStopAllCall(word, inputs, depth))
  ) {
    return true;
  }
  const rest = words.slice(launcherAt);
  return baseName(rest[0]?.text ?? "") === "mise"
    ? miseStopAllCall(rest, inputs)
    : runnerStopAllCall(rest.slice(1), inputs);
}

/**
 * 単純コマンドが、全停止を置く・解除する操作か、止めた設定を戻す操作なら真を返す。
 * 全停止のCLI(`scripts/stop_all.ts`)の実行と、`mise run stop`、`mise run stop:release`、`mise run stop:restore`である。
 * CLIは`CLAUDECODE`があれば断るが、環境変数を外せば迂回できるので、すべてのセッションでここでも止める。
 * プログラムの種類は問わない。`script`、`unbuffer`、`caffeinate`のような前置きの後ろの語と、
 * `script -c`のようなコマンド文字列の中も、同じ規則で見る。
 * 検査の道具(`bun test`、`biome`など)の引数と、読み取りのプログラム(`cat`、`git`、`rg`など)は、実行ではないので通す。
 * 読み取りのプログラムでも、別のコマンドの実行を委ねる形(`delegatesExecution`)は通さず、委ねる先を字面でも見る。
 * 先頭の代入の値(`assignments`)のうち、空白か、シェルが語を分けるか展開する字を含む値も、字面で判定する。
 * 全停止のCLIを指す字面か、`mise`と全停止のタスク名が並ぶ字面があれば真を返す。
 * 値が1語の代入は判定しない。引数を渡せず、ファイルのパスを変数に入れて読む日常の形を止めないためである。
 * ベストエフォートの規則で、変数や連結で組み立てた名前と、別名の呼び出しは止めない。
 */
export function findStopAllCall(
  words: readonly Word[],
  inputs: () => readonly string[] | null,
  assignments: readonly Word[] = [],
): boolean {
  // 先頭の代入の値は、ページャーなどの環境変数としてコマンドに実行されうる。実行する側によらず、字面で判定する。
  const assigned = assignments
    .map(assignmentValue)
    .filter((value) => splitsIntoWords(value.text))
    .some((value) =>
      spellings(value).some(
        (text) => stopAllWording(text) || stopAllWording(unquotedText(text)),
      ),
    );
  return assigned || stopAllCallAt(words, inputs, 0);
}
