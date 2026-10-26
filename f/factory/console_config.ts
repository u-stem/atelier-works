// Consoleのシステム画面が読む、factory_configの全項目を返すscript(スタブ)。

export const CONFIG_RESOURCE_PATH = "f/factory/factory_config";

export type ConfigItem =
  | {
      readonly key: string;
      readonly kind: "value";
      readonly value: unknown;
      readonly masked: boolean;
    }
  | { readonly key: string; readonly kind: "reference" };

export type ConfigSnapshot = {
  readonly path: string;
  readonly items: readonly ConfigItem[];
};

export type ConfigPorts = {
  readonly getConfig: () => Promise<unknown>;
};

export async function loadConfigView(
  _ports: ConfigPorts,
): Promise<ConfigSnapshot> {
  return { path: "", items: [] };
}

export async function main(): Promise<ConfigSnapshot> {
  return { path: "", items: [] };
}
