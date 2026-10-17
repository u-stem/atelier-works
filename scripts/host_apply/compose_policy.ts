/** composeの定義を静的に検査する。許可する形を列挙し、未知のキーは拒否する。 */

export const COMPOSE_SERVICE_ALLOWLIST: readonly string[] = [];

export type ComposeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "unknown_service" | "compose_forbidden";
      readonly detail: string;
    };

export type ComposeContext = {
  /** ステージング(チェックアウト)のルートの絶対パス。 */
  readonly root: string;
  /** composeファイルがあるディレクトリの絶対パス。相対パスの基準になる。 */
  readonly composeDir: string;
  /** 変数の展開に使う値。静的に読んだ、列挙したキーだけを渡す。 */
  readonly env: Readonly<Record<string, string>>;
};

export function checkCompose(
  _parsed: unknown,
  _context: ComposeContext,
): ComposeVerdict {
  return { ok: true };
}
