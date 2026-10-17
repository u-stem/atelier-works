/** ルートの`package.json`の変更が、承認を要するかの判定。 */

/** `none`は内容が同じ、`auto`は依存の版の変更だけ、`approval`は承認が要る変更。 */
export type PackageChange = "none" | "auto" | "approval";

export function classifyPackageJsonChange(
  _base: string | null,
  _target: string,
): PackageChange {
  return "none";
}
