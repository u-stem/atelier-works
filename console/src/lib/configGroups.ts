import type { ConfigItemView } from "../api/jobsQueries.ts";

export type ConfigGroup = {
  readonly id: string;
  readonly label: string;
  readonly items: readonly ConfigItemView[];
};

export type ConfigGroupDefinition = {
  readonly id: string;
  readonly label: string;
  readonly keys: readonly string[];
};

export const CONFIG_GROUP_DEFINITIONS: readonly ConfigGroupDefinition[] = [];

export function groupConfigItems(
  _items: readonly ConfigItemView[],
): ConfigGroup[] {
  return [];
}
