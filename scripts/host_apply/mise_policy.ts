/** mise設定の静的な読み取りと、承認が要る変更かどうかの判定。`mise`コマンドは使わない。 */

export function validateMiseValue(_key: string, _value: unknown): boolean {
  return true;
}

export function isMiseConfigPath(_path: string): boolean {
  return false;
}

export function readMiseEnv(
  _text: string,
): Readonly<Record<string, string>> | null {
  return null;
}

export type MiseStaticCheck =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

export function checkMiseStatic(_text: string): MiseStaticCheck {
  return { ok: true, env: {} };
}

/** `none`は内容が同じ、`auto`は承認なしで反映できる変更、`approval`は承認が要る変更。 */
export type MiseChange = "none" | "auto" | "approval";

export function classifyMiseTomlChange(
  _base: string | null,
  _target: string,
): MiseChange {
  return "none";
}
