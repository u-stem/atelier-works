// flowごとの図のデータの型と、その検査。
// データは`scripts/docs-gen.ts`が`src/generated/flows.json`に書き、CIが古さを検査する。

import flowsJson from "../generated/flows.json";

/** flowのステップ。定義(`flow.yaml`の`modules[]`)の順に並ぶ。 */
export type FlowStep = {
  /** 実行時のステップidと一致する。 */
  readonly id: string;
  /** 接頭辞(`[SF-…]`)を除いた1行の説明。 */
  readonly summary: string;
  /** ステップが実行するscriptのpath。 */
  readonly scriptPath: string;
  /** `skip_if`を持ち、条件で飛ぶことがある。 */
  readonly conditional: boolean;
};

/** 出口がflowを起動する経路。承認を介するときは、承認と却下を分ける。 */
export type ExitVia = "launch" | "approve" | "reject";

/** flowの入口。 */
export type FlowEntry =
  | { readonly kind: "schedule"; readonly name: string }
  | { readonly kind: "human"; readonly label: string }
  | { readonly kind: "script"; readonly name: string }
  | {
      readonly kind: "flow";
      readonly flow: string;
      readonly via: ExitVia;
    };

/** あるステップから、次に動くflowへの出口。 */
export type FlowExit = {
  readonly flow: string;
  /** 出口がつくステップのid。 */
  readonly step: string;
  readonly via: ExitVia;
};

export type FlowDefinition = {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly steps: readonly FlowStep[];
  readonly entries: readonly FlowEntry[];
  readonly exits: readonly FlowExit[];
};

/** スケジュールの1行の説明と、起動するflow。 */
export type FlowSchedule = {
  readonly name: string;
  readonly summary: string;
  readonly flows: readonly string[];
};

export type FlowsData = {
  readonly flows: readonly FlowDefinition[];
  readonly schedules: readonly FlowSchedule[];
};

/** flowとscheduleの名前に許す形。パスと検索のキーに入れるので、英小文字と数字と`_`に限る。 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const FACTORY_PREFIX = "f/factory/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVia(value: unknown): value is ExitVia {
  return value === "launch" || value === "approve" || value === "reject";
}

function isName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

function readStep(value: unknown): FlowStep | null {
  if (!isRecord(value)) return null;
  const { id, summary, scriptPath, conditional } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof summary !== "string" || typeof scriptPath !== "string") {
    return null;
  }
  if (typeof conditional !== "boolean") return null;
  return { id, summary, scriptPath, conditional };
}

function readEntry(value: unknown): FlowEntry | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "schedule":
    case "script":
      return typeof value.name === "string"
        ? { kind: value.kind, name: value.name }
        : null;
    case "human":
      return typeof value.label === "string"
        ? { kind: "human", label: value.label }
        : null;
    case "flow":
      return isName(value.flow) && isVia(value.via)
        ? { kind: "flow", flow: value.flow, via: value.via }
        : null;
    default:
      return null;
  }
}

function readExit(value: unknown): FlowExit | null {
  if (!isRecord(value)) return null;
  const { flow, step, via } = value;
  if (!isName(flow) || typeof step !== "string" || !isVia(via)) return null;
  return { flow, step, via };
}

function readList<T>(
  value: unknown,
  read: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = read(raw);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function readFlow(value: unknown): FlowDefinition | null {
  if (!isRecord(value)) return null;
  const { name, summary, description } = value;
  if (!isName(name)) return null;
  if (typeof summary !== "string" || typeof description !== "string") {
    return null;
  }
  const steps = readList(value.steps, readStep);
  const entries = readList(value.entries, readEntry);
  const exits = readList(value.exits, readExit);
  if (steps === null || entries === null || exits === null) return null;
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return null;
  if (exits.some((exit) => !ids.has(exit.step))) return null;
  return { name, summary, description, steps, entries, exits };
}

function readSchedule(value: unknown): FlowSchedule | null {
  if (!isRecord(value)) return null;
  const { name, summary, flows } = value;
  if (!isName(name) || typeof summary !== "string") return null;
  if (!Array.isArray(flows)) return null;
  const names: string[] = [];
  for (const flow of flows) {
    if (!isName(flow)) return null;
    names.push(flow);
  }
  return { name, summary, flows: names };
}

/**
 * 値をflowごとの図のデータとして読む。形が違えばnullを返す。
 * flowとscheduleの名前は一意で、ステップのidはflowの中で一意でなければならない。
 * 出口と入口とscheduleが指すflowは存在し、出口がつくステップはそのflowにある。
 * 図の組み立ては、この条件を前提にする。
 */
export function parseFlowsData(value: unknown): FlowsData | null {
  if (!isRecord(value)) return null;
  const flows = readList(value.flows, readFlow);
  const schedules = readList(value.schedules, readSchedule);
  if (flows === null || schedules === null) return null;
  const names = new Set(flows.map((flow) => flow.name));
  if (names.size !== flows.length) return null;
  if (new Set(schedules.map((item) => item.name)).size !== schedules.length) {
    return null;
  }
  for (const flow of flows) {
    if (flow.exits.some((exit) => !names.has(exit.flow))) return null;
    const unknownEntry = flow.entries.some(
      (entry) => entry.kind === "flow" && !names.has(entry.flow),
    );
    if (unknownEntry) return null;
  }
  if (schedules.some((item) => item.flows.some((flow) => !names.has(flow)))) {
    return null;
  }
  return { flows, schedules };
}

/** バンドルに取り込んだflowごとの図のデータ。形が違えばnullになる。 */
export const FLOWS_DATA: FlowsData | null = parseFlowsData(flowsJson);

/** 名前のflowを返す。無ければnull。名前は一覧から探し、オブジェクトの継承したキーを拾わない。 */
export function findFlow(
  data: FlowsData | null,
  name: string,
): FlowDefinition | null {
  return data?.flows.find((flow) => flow.name === name) ?? null;
}

/** schedule(`f/factory/<name>`)の説明と起動するflowを返す。無ければnull。 */
export function scheduleFlowsOf(
  data: FlowsData | null,
  schedulePath: string,
): FlowSchedule | null {
  if (!schedulePath.startsWith(FACTORY_PREFIX)) return null;
  const name = schedulePath.slice(FACTORY_PREFIX.length);
  return data?.schedules.find((item) => item.name === name) ?? null;
}

/** ジョブの画面のパス。ルーターの基準(`/console`)からの絶対パスで書く。 */
const JOBS = "/jobs";

/** flowの図の画面のパス。データに無い名前と、安全でない名前はnullにする。 */
export function flowDiagramPath(
  name: string,
  data: FlowsData | null = FLOWS_DATA,
): string | null {
  if (!NAME_PATTERN.test(name) || findFlow(data, name) === null) return null;
  return `${JOBS}/flows/${name}`;
}

/** flowの図の画面が、経路の引数から決める状態。 */
export type FlowRouteState =
  | { readonly kind: "redirect" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "not_found" }
  | { readonly kind: "found"; readonly flow: FlowDefinition };

export function flowRouteState(
  _name: string | undefined,
  _data: FlowsData | null,
): FlowRouteState {
  return { kind: "not_found" };
}

/** flowのジョブの履歴の画面のパス。 */
export function flowHistoryPath(name: string): string {
  const query = new URLSearchParams({
    tab: "history",
    script: `${FACTORY_PREFIX}${name}`,
  });
  return `${JOBS}?${query.toString()}`;
}
