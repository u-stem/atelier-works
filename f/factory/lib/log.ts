// 秘密情報をマスクする構造化ログ。
// エラーメッセージやサブプロセスの標準出力に紛れたトークンを、
// Windmillのジョブログに出さないため、すべてのログ行を`maskSecrets`に通す。

/**
 * 値を教わらなくても形式だけで判別できる秘密情報の正規表現。
 * 公開された形式を持つトークン(GitHubのPAT、Claude CodeのOAuthトークン、
 * DiscordのWebhook URL)はこれで常にマスクする。
 * Windmill APIトークンのように形式が公開されていないトークンは、
 * 完全一致でマスクするため`secrets`で明示的に渡す必要がある。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHubのfine-grained PAT。`github_pat_`の後に約82字の英数字と`_`が続く。
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // GitHubのclassic PAT、OAuth、app、refreshトークンの接頭辞。
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  // Claude CodeのOAuthトークン。
  /sk-ant-oat[A-Za-z0-9_-]{10,}/g,
  // 多層防御として、その他のAnthropic API形式の秘密鍵もマスクする。
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  // DiscordのWebhook URL。`/webhooks/`以降がすべて秘密情報にあたる。
  /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

/**
 * `text`の中の既知の形式の秘密情報と、`secrets`で渡した値を`***`に置き換える。
 * エラーメッセージやサブプロセスの標準出力・標準エラーなど、
 * 任意の文字列をログ出力や保存の前に通してよい。
 */
export function maskSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    masked = masked.split(secret).join("***");
  }
  return masked;
}

/**
 * 理由の文字列に埋め込む詳細の中の`"; "`を`", "`に置き換えて返す。
 * 理由は`"; "`でつないだ項目の一覧として訳され、次の操作も項目ごとに選ばれる。
 * Claudeや検査コマンドが書ける文(Claudeの結果の文、構造化出力、stderr、ファイル名、プロセスのコマンド)に
 * 区切りが入ると、別の理由の項目として表示されるため。
 */
export function escapeReasonSeparator(text: string): string {
  return text.replaceAll("; ", ", ");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogSink = (line: string) => void;

export type Logger = {
  /**
   * 毎回の実行で同じ内容が出うる、調査用のログ。
   * 既定では書き出さず、`LoggerOptions.debug`か環境変数`FACTORY_LOG_DEBUG=1`で有効にする。
   * 実装しない`Logger`(テストの偽物など)があるので、省略できる。
   */
  debug?(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type LoggerOptions = {
  /**
   * 組み込みの既知の形式に加えて、すべてのログ行でマスクする秘密情報の値。
   * Windmill APIトークンのように決まった形式を持たないものを渡す。
   */
  secrets?: readonly string[];
  /** 直列化したログ行の書き込み先。既定は`console.log`。 */
  sink?: LogSink;
  /** `debug`のログを書き出すか。既定は環境変数`FACTORY_LOG_DEBUG`が`1`のとき。 */
  debug?: boolean;
  /** テストで時刻を固定するための時計。既定は`() => new Date()`。 */
  now?: () => Date;
};

/**
 * パイプラインの1工程(`poll_issues`、`generate_requirements`など)用の
 * 構造化ロガーを作る。
 * 呼び出しごとにJSONを1行、`sink`へ書き出す。
 * 既定の`console.log`の出力は、Windmillがジョブログとして取り込む。
 *
 * マスクはフィールドごとではなく、直列化した行全体にかける。
 * `fields`は任意の深さに入れ子になったオブジェクトや配列
 * (取り込んだHTTPリクエストなど)になりうるため、
 * フィールドごとのマスクでは入れ子の奥にある秘密情報を見逃す。
 */
export function logger(stage: string, options: LoggerOptions = {}): Logger {
  const secrets = options.secrets ?? [];
  const sink = options.sink ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const debugEnabled = options.debug ?? process.env.FACTORY_LOG_DEBUG === "1";

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      stage,
      message,
    };
    if (fields !== undefined) {
      record.fields = fields;
    }
    sink(maskSecrets(JSON.stringify(record), secrets));
  }

  return {
    debug: (message, fields) => {
      if (debugEnabled) emit("debug", message, fields);
    },
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
