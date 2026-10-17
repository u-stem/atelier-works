/** ログに書く外部コマンドの出力から、秘密値を伏せる。 */

/** これより短い値は伏せない。短い値を伏せると、無関係な文字列まで潰すため。 */
export const MASK_MIN_LENGTH = 8;

/**
 * `mise.local.toml`の`[env]`の、すべてのキーの文字列の値を集める。
 * 読めない内容と、`MASK_MIN_LENGTH`に満たない値は、空の結果にする。
 */
export function collectMaskValues(miseLocalToml: string): string[] {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(miseLocalToml);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("env" in parsed)) {
    return [];
  }
  const env = parsed.env;
  if (typeof env !== "object" || env === null) return [];
  return Object.values(env).filter(
    (value): value is string =>
      typeof value === "string" && value.length >= MASK_MIN_LENGTH,
  );
}

/**
 * 出力に含まれる秘密値を`***`に置き換える。
 * 長い値から先に置き換えるので、ある値が別の値を含んでいても、一部が残らない。
 * 値は文字列として探し、正規表現としては扱わない。
 */
export function maskSecrets(text: string, values: Iterable<string>): string {
  const secrets = [...values]
    .filter((value) => value.length >= MASK_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  let masked = text;
  for (const secret of secrets) masked = masked.replaceAll(secret, "***");
  return masked;
}
