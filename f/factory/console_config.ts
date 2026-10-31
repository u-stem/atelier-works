// Consoleのシステム画面が読む、factory_configの全項目を返すscript。
//
// 補間しない生の値を読む(`ResourceService.getResourceValue`)。`$var:`や`$res:`を含む値は、
// 参照の先をscriptが解決しないよう、値を出さずに「参照」の印で返す。補間する`getResource`は使わない。
// 読むパスはリテラルの`f/factory/factory_config`だけで、境界テストが固定する。
// 値は`lib/console_redact.ts`で伏せてから返す。
// 設計工程だけは、書かれた値に加えて、効いている値も返す(`design_stage`)。
// 効いている値は、設定を読む全てのscriptと同じ門(`lib/design_gate.ts`)で決める。
// ただし、門の入力が参照のときは、参照を解決した値を読めないので、効いている値を断定しない。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { holdsReference, isRecord, redactValue } from "./lib/console_redact.ts";
import { type DesignGate, resolveDesignGate } from "./lib/design_gate.ts";

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

/** 設計工程の、効いている値と、書かれた値が無視されているか。 */
export type DesignStage = DesignGate & {
  /**
   * 門の入力が参照で、効いている値を判定できないか。
   * 真のとき、`enabled`と`ignored`は意味を持たず、どちらも偽にする。
   */
  readonly indeterminate: boolean;
};

export type ConfigSnapshot = {
  readonly path: string;
  readonly items: readonly ConfigItem[];
  readonly design_stage: DesignStage;
};

export type ConfigPorts = {
  /** 補間しない生の値を返す。 */
  readonly getConfig: () => Promise<unknown>;
};

/**
 * 設計工程が効いているかを、生の値から決める。
 * `design_enabled`か`design_enabled_since`が参照を含むときは、設定を読む側が解決した値で門を決めるので、
 * 生の値からは効いている値を判定できない。そのときは`indeterminate`を立てる。
 * 参照を含まないとき、真と書かれていない値(文字列、数値、無い値)は、要求なしとして扱う。
 * 設定を読む側は真偽値でない値を検証エラーにするが、ここは画面を出すために例外にしない。
 */
function designStageOf(raw: Record<string, unknown>): DesignStage {
  const requested = raw.design_enabled;
  const since = raw.design_enabled_since;
  if (holdsReference(requested) || holdsReference(since)) {
    return { enabled: false, ignored: false, indeterminate: true };
  }
  return {
    ...resolveDesignGate(requested === true, since),
    indeterminate: false,
  };
}

/**
 * 設定の全項目を、キーの順に返す。参照を含む値は値を出さない。
 * 設計工程の効いている値も添える。
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
  return {
    path: CONFIG_RESOURCE_PATH,
    items,
    design_stage: designStageOf(raw),
  };
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
