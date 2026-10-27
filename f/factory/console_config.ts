// Consoleのシステム画面が読む、factory_configの全項目を返すscript。
//
// 補間しない生の値を読む(`ResourceService.getResourceValue`)。`$var:`や`$res:`を含む値は、
// 参照の先をscriptが解決しないよう、値を出さずに「参照」の印で返す。補間する`getResource`は使わない。
// 読むパスはリテラルの`f/factory/factory_config`だけで、境界テストが固定する。
// 値は`lib/console_redact.ts`で伏せてから返す。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { holdsReference, isRecord, redactValue } from "./lib/console_redact.ts";

export const CONFIG_RESOURCE_PATH = "f/factory/factory_config";

export type ConfigItem =
  | {
      readonly key: string;
      readonly kind: "value";
      readonly value: unknown;
      /** 伏せた箇所がある。 */
      readonly masked: boolean;
    }
  | { readonly key: string; readonly kind: "reference" };

export type ConfigSnapshot = {
  readonly path: string;
  readonly items: readonly ConfigItem[];
};

export type ConfigPorts = {
  /** 補間しない生の値を返す。 */
  readonly getConfig: () => Promise<unknown>;
};

/**
 * 設定の全項目を、キーの順に返す。参照を含む値は値を出さない。
 * 設定がオブジェクトでなければ例外を投げる。
 */
export async function loadConfigView(
  ports: ConfigPorts,
): Promise<ConfigSnapshot> {
  const raw = await ports.getConfig();
  if (!isRecord(raw)) {
    throw new Error("console_config: the config resource is not an object");
  }
  const items: ConfigItem[] = Object.keys(raw)
    .sort()
    .map((key): ConfigItem => {
      const value = raw[key];
      if (holdsReference(value)) {
        return { key, kind: "reference" };
      }
      const redacted = redactValue({ [key]: value });
      const shown = isRecord(redacted.value) ? redacted.value[key] : undefined;
      return { key, kind: "value", value: shown, masked: redacted.masked };
    });
  return { path: CONFIG_RESOURCE_PATH, items };
}

/** Consoleのシステム画面に、factory_configの全項目を返す。 */
export async function main(): Promise<ConfigSnapshot> {
  const workspace = wmillDefault.getWorkspace();
  return await loadConfigView({
    getConfig: () =>
      wmill.ResourceService.getResourceValue({
        workspace,
        path: "f/factory/factory_config",
      }),
  });
}
