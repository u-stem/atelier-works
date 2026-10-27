// 起動関係の静的グラフ(スケジュール、script、flow、人の操作とそれらをつなぐ辺)を作る。
// 元データは`scripts/launch-graph.ts`の表、`*.schedule.yaml`、flowの定義である。
// 純関数だけを置く。ファイルの読み込みと書き出しは`scripts/docs-gen.ts`が行う。

import type {
  FlowGraph,
  GraphEdge,
  GraphNode,
} from "../console/src/lib/flowGraph.ts";
import type {
  ExitVia,
  FlowDefinition,
  FlowEntry,
  FlowExit,
  FlowSchedule,
  FlowsData,
} from "../console/src/lib/flowsData.ts";
import type {
  ApprovalOutcome,
  LaunchEdge,
  ReworkEdge,
} from "./launch-graph.ts";

export type ScheduleInput = {
  /** `f/factory/<name>.schedule.yaml`の`<name>`。 */
  readonly name: string;
  readonly cron: string;
  /** スケジュールが実行するscriptかflowのpath(`f/factory/poll_issues`)。 */
  readonly target: string;
  readonly isFlow: boolean;
  /** 無効のスケジュールは図に載せない。 */
  readonly enabled: boolean;
};

export type FlowInput = {
  readonly name: string;
  readonly summary: string;
  /** flowのモジュールが実行するscriptのpath(`f/factory/steps/pr_fix_finish`)。 */
  readonly stepPaths: readonly string[];
};

export type FlowGraphInput = {
  readonly edges: readonly LaunchEdge[];
  readonly humanOperations: Readonly<Record<string, string>>;
  readonly humanEntryScripts: Readonly<Record<string, string>>;
  readonly schedules: readonly ScheduleInput[];
  readonly flows: readonly FlowInput[];
};

const FACTORY_PREFIX = "f/factory/";

const NODE_ORDER: Readonly<Record<GraphNode["kind"], number>> = {
  schedule: 0,
  human: 1,
  script: 2,
  flow: 3,
};

const EDGE_ORDER: Readonly<Record<GraphEdge["kind"], number>> = {
  schedule: 0,
  human: 1,
  run: 2,
  step: 3,
};

/** `f/factory/`からの相対パスにする。 */
function relativeToFactory(path: string): string {
  return path.startsWith(FACTORY_PREFIX)
    ? path.slice(FACTORY_PREFIX.length)
    : path;
}

/** summaryの先頭の`[SF-2-1]`などの接頭辞を除く。 */
export function withoutIdPrefix(summary: string): string {
  return summary.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 起動関係のグラフを作る。ノードと辺の並びは入力の並びに依らない。
 * - flowのノードは、すべてのflowに作る
 * - scriptのノードは、flowを起動するscriptだけに作る
 * - スケジュールのノードは、有効で、そのscriptかflowを実行するスケジュールだけに作る
 * - 人の操作のノードは、flowを起動する操作と、scriptを動かすConsoleの操作に作る
 * - flowからscriptへの辺は、flowのモジュールが、flowを起動するscriptを実行するときに引く
 * 起動の辺が存在しないflowを指していれば、例外を投げる。
 */
export function buildFlowGraph(input: FlowGraphInput): FlowGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode): void => {
    nodes.set(node.id, node);
  };
  const addEdge = (edge: GraphEdge): void => {
    edges.set(`${edge.kind} ${edge.from} ${edge.to}`, edge);
  };

  for (const flow of input.flows) {
    addNode({
      id: `flow:${flow.name}`,
      kind: "flow",
      label: flow.name,
      note: withoutIdPrefix(flow.summary),
    });
  }

  for (const edge of input.edges) {
    if (!nodes.has(`flow:${edge.to}`)) {
      throw new Error(`launch edge targets an unknown flow: ${edge.to}`);
    }
    if (edge.kind === "human") {
      const id = `human:op:${edge.from}`;
      addNode({
        id,
        kind: "human",
        label: input.humanOperations[edge.from] ?? edge.from,
        note: "",
      });
      addEdge({ from: id, to: `flow:${edge.to}`, kind: "human" });
      continue;
    }
    const scriptId = `script:${edge.from}`;
    addNode({ id: scriptId, kind: "script", label: edge.from, note: "" });
    addEdge({ from: scriptId, to: `flow:${edge.to}`, kind: "run" });
    const entry = input.humanEntryScripts[edge.from];
    if (entry !== undefined) {
      const entryId = `human:entry:${edge.from}`;
      addNode({ id: entryId, kind: "human", label: entry, note: "" });
      addEdge({ from: entryId, to: scriptId, kind: "human" });
    }
  }

  for (const schedule of input.schedules) {
    if (!schedule.enabled) continue;
    const target = relativeToFactory(schedule.target);
    const targetId = `${schedule.isFlow ? "flow" : "script"}:${target}`;
    if (!nodes.has(targetId)) continue;
    const id = `schedule:${schedule.name}`;
    addNode({
      id,
      kind: "schedule",
      label: schedule.name,
      note: schedule.cron,
    });
    addEdge({ from: id, to: targetId, kind: "schedule" });
  }

  for (const flow of input.flows) {
    for (const path of flow.stepPaths) {
      const scriptId = `script:${relativeToFactory(path)}`;
      if (nodes.has(scriptId)) {
        addEdge({ from: `flow:${flow.name}`, to: scriptId, kind: "step" });
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort(
      (a, b) =>
        NODE_ORDER[a.kind] - NODE_ORDER[b.kind] || compareText(a.id, b.id),
    ),
    edges: [...edges.values()].sort(
      (a, b) =>
        EDGE_ORDER[a.kind] - EDGE_ORDER[b.kind] ||
        compareText(a.from, b.from) ||
        compareText(a.to, b.to),
    ),
  };
}

/** グラフをJSONの文字列にする。末尾に改行を付ける。 */
export function renderFlowGraphJson(graph: FlowGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

/** flow.yamlのモジュール1つ。 */
export type FlowStepInput = {
  readonly id: string;
  readonly summary: string;
  /** モジュールが実行するscriptのpath(`f/factory/steps/pr_fix_finish`)。 */
  readonly path: string;
  /** `skip_if`を持つか。 */
  readonly conditional: boolean;
};

export type FlowDefinitionInput = {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly steps: readonly FlowStepInput[];
};

export type ScheduleDescriptionInput = ScheduleInput & {
  readonly summary: string;
};

export type FlowsInput = {
  readonly edges: readonly LaunchEdge[];
  readonly humanOperations: Readonly<Record<string, string>>;
  readonly humanEntryScripts: Readonly<Record<string, string>>;
  readonly schedules: readonly ScheduleDescriptionInput[];
  readonly flows: readonly FlowDefinitionInput[];
  /** 承認依頼を作るステップのscriptから、承認を処理するscriptへの対応。ハンドラーが無ければnull。 */
  readonly approvalSteps: Readonly<Record<string, string | null>>;
  /** 承認を処理するscriptごとの、起動するflowと承認か却下か。 */
  readonly approvalOutcomes: Readonly<
    Record<string, readonly ApprovalOutcome[]>
  >;
  /** 表にあるが、本番では起動しない辺。入口と出口には描かず、「まだ起動されない」入口として分ける。 */
  readonly unwiredEdges: readonly LaunchEdge[];
  /** 差し戻しのときだけ起動する辺。 */
  readonly reworkEdges: readonly ReworkEdge[];
  /** flowを起動するscriptを呼ぶscript(呼ばれるscript → 呼ぶscript)。 */
  readonly scriptCallers: Readonly<Record<string, string>>;
};

const ENTRY_ORDER: Readonly<Record<FlowEntry["kind"], number>> = {
  schedule: 0,
  human: 1,
  script: 2,
  flow: 3,
};

const VIA_ORDER: Readonly<Record<ExitVia, number>> = {
  launch: 0,
  approve: 1,
  reject: 2,
  rework: 3,
};

function entryKey(entry: FlowEntry): string {
  switch (entry.kind) {
    case "schedule":
    case "script":
      return entry.name;
    case "human":
      return entry.label;
    case "flow":
      return `${entry.flow} ${String(VIA_ORDER[entry.via])}`;
  }
}

/** 承認のステップから、承認の処理が起動するflowへの1本。 */
type ApprovalLink = {
  readonly flow: string;
  readonly step: string;
  readonly handler: string;
  readonly to: string;
  readonly via: ExitVia;
  /** 本番で起動するか。 */
  readonly wired: boolean;
};

function sameEdge(a: LaunchEdge, b: LaunchEdge): boolean {
  return a.from === b.from && a.to === b.to && a.kind === b.kind;
}

/**
 * 表を自分のキーだけで引く。scriptやstepの名前が`constructor`のような継承したキーでも、
 * 表の値と取り違えないためである。
 */
function own<T>(
  table: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * flowごとの図のデータを作る。並びは入力の並びに依らない。
 * - ステップは、flowの定義の順に並べる
 * - 入口は、そのflowを起動するスケジュール、人の操作、script、他のflowのステップとする。
 *   ステップから起動されるときは、scriptではなく起動元のflowを入口にする。
 *   スケジュールも人の操作も持たないscriptは、呼ぶscriptがあればそれを添える
 * - 出口は、ステップが起動する他のflowとする。承認のステップには、承認の処理が起動するflowを、承認と却下に分けてつける。
 *   差し戻しのときだけ起動する辺は、通常の起動と分ける
 * - `unwiredEdges`の辺は、入口にも出口にも描かず、起動先のflowの`unwiredEntries`に分ける
 * 起動の辺が存在しないflowを指していれば、例外を投げる。
 * 承認の処理の辺が`approvalOutcomes`に無ければ、例外を投げる。
 */
export function buildFlowsData(input: FlowsInput): FlowsData {
  const flowNames = new Set(input.flows.map((flow) => flow.name));
  for (const edge of input.edges) {
    if (!flowNames.has(edge.to)) {
      throw new Error(`launch edge targets an unknown flow: ${edge.to}`);
    }
  }
  const isUnwired = (edge: LaunchEdge): boolean =>
    input.unwiredEdges.some((other) => sameEdge(edge, other));
  const wired = input.edges.filter((edge) => !isUnwired(edge));
  const unwired = input.edges.filter(isUnwired);
  const launchVia = (edge: LaunchEdge): ExitVia =>
    input.reworkEdges.some(
      (other) => other.from === edge.from && other.to === edge.to,
    )
      ? "rework"
      : "launch";

  const owners = new Map<string, { flow: string; step: string }[]>();
  const approvalLinks: ApprovalLink[] = [];
  for (const flow of input.flows) {
    for (const step of flow.steps) {
      const script = relativeToFactory(step.path);
      owners.set(script, [
        ...(owners.get(script) ?? []),
        { flow: flow.name, step: step.id },
      ]);
      const handler = own(input.approvalSteps, script);
      if (handler === undefined || handler === null) continue;
      for (const edge of input.edges) {
        if (edge.kind !== "script" || edge.from !== handler) continue;
        const outcome = own(input.approvalOutcomes, handler)?.find(
          (candidate) => candidate.to === edge.to,
        );
        if (outcome === undefined) {
          throw new Error(
            `approval handler edge has no outcome: ${edge.from} -> ${edge.to}`,
          );
        }
        approvalLinks.push({
          flow: flow.name,
          step: step.id,
          handler,
          to: edge.to,
          via: outcome.outcome,
          wired: !isUnwired(edge),
        });
      }
    }
  }

  const entriesOf = (
    flow: string,
    edges: readonly LaunchEdge[],
    links: readonly ApprovalLink[],
    direct: boolean,
  ): FlowEntry[] => {
    const entries = new Map<string, FlowEntry>();
    const add = (entry: FlowEntry): void => {
      entries.set(JSON.stringify(entry), entry);
    };
    for (const edge of edges) {
      if (edge.to !== flow) continue;
      if (edge.kind === "human") {
        add({
          kind: "human",
          label: own(input.humanOperations, edge.from) ?? edge.from,
        });
        continue;
      }
      const approvals = links.filter(
        (link) => link.handler === edge.from && link.to === flow,
      );
      if (approvals.length > 0) {
        for (const link of approvals) {
          add({ kind: "flow", flow: link.flow, via: link.via });
        }
        continue;
      }
      const stepOwners = owners.get(edge.from) ?? [];
      if (stepOwners.length > 0) {
        for (const owner of stepOwners) {
          add({ kind: "flow", flow: owner.flow, via: launchVia(edge) });
        }
        continue;
      }
      const schedules = input.schedules.filter(
        (schedule) =>
          schedule.enabled &&
          !schedule.isFlow &&
          relativeToFactory(schedule.target) === edge.from,
      );
      for (const schedule of schedules) {
        add({ kind: "schedule", name: schedule.name });
      }
      const operation = own(input.humanEntryScripts, edge.from);
      if (operation !== undefined) add({ kind: "human", label: operation });
      if (schedules.length === 0 && operation === undefined) {
        add({
          kind: "script",
          name: edge.from,
          caller: own(input.scriptCallers, edge.from) ?? null,
        });
      }
    }
    if (direct) {
      for (const schedule of input.schedules) {
        if (
          schedule.enabled &&
          schedule.isFlow &&
          relativeToFactory(schedule.target) === flow
        ) {
          add({ kind: "schedule", name: schedule.name });
        }
      }
    }
    return [...entries.values()].sort(
      (a, b) =>
        ENTRY_ORDER[a.kind] - ENTRY_ORDER[b.kind] ||
        compareText(entryKey(a), entryKey(b)),
    );
  };

  const exitsOf = (flow: FlowDefinitionInput): FlowExit[] => {
    const exits: FlowExit[] = [];
    for (const step of flow.steps) {
      const script = relativeToFactory(step.path);
      if (Object.hasOwn(input.approvalSteps, script)) {
        for (const link of approvalLinks) {
          if (link.wired && link.flow === flow.name && link.step === step.id) {
            exits.push({ flow: link.to, step: step.id, via: link.via });
          }
        }
        continue;
      }
      for (const edge of wired) {
        if (edge.kind === "script" && edge.from === script) {
          exits.push({ flow: edge.to, step: step.id, via: launchVia(edge) });
        }
      }
    }
    const order = new Map(flow.steps.map((step, index) => [step.id, index]));
    return exits.sort(
      (a, b) =>
        (order.get(a.step) ?? 0) - (order.get(b.step) ?? 0) ||
        VIA_ORDER[a.via] - VIA_ORDER[b.via] ||
        compareText(a.flow, b.flow),
    );
  };

  const wiredLinks = approvalLinks.filter((link) => link.wired);
  const unwiredLinks = approvalLinks.filter((link) => !link.wired);
  const flows: FlowDefinition[] = input.flows
    .map((flow) => {
      const entries = entriesOf(flow.name, wired, wiredLinks, true);
      const wiredKeys = new Set(entries.map((entry) => JSON.stringify(entry)));
      return {
        name: flow.name,
        summary: withoutIdPrefix(flow.summary),
        description: flow.description.trim(),
        steps: flow.steps.map((step) => ({
          id: step.id,
          summary: withoutIdPrefix(step.summary),
          scriptPath: step.path,
          conditional: step.conditional,
        })),
        entries,
        unwiredEntries: entriesOf(
          flow.name,
          unwired,
          unwiredLinks,
          false,
        ).filter((entry) => !wiredKeys.has(JSON.stringify(entry))),
        exits: exitsOf(flow),
      };
    })
    .sort((a, b) => compareText(a.name, b.name));

  const schedules: FlowSchedule[] = input.schedules
    .map((schedule) => {
      const target = relativeToFactory(schedule.target);
      const launched = !schedule.enabled
        ? []
        : schedule.isFlow
          ? flowNames.has(target)
            ? [target]
            : []
          : wired
              .filter(
                (edge) =>
                  edge.kind === "script" &&
                  (edge.from === target ||
                    own(input.scriptCallers, edge.from) === target),
              )
              .map((edge) => edge.to);
      return {
        name: schedule.name,
        summary: withoutIdPrefix(schedule.summary),
        flows: [...new Set(launched)].sort(compareText),
      };
    })
    .sort((a, b) => compareText(a.name, b.name));

  return { flows, schedules };
}

/** formatterが1行に収める幅。 */
const LINE_WIDTH = 80;

/** 文字列だけを並べた複数行の配列。キーを持つときはキーも含めて取る。 */
const STRING_ARRAY =
  /^( *)((?:"[^"\n]*": )?)\[\n((?: +"[^"\n]*",?\n)+)\1\](,?)$/gm;

/**
 * データをJSONの文字列にする。末尾に改行を付ける。
 * 文字列だけの短い配列は1行にする。生成したファイルを、リポジトリのformatterが書き換えないためである。
 */
export function renderFlowsJson(data: FlowsData): string {
  const folded = JSON.stringify(data, null, 2).replace(
    STRING_ARRAY,
    (match, indent: string, key: string, body: string, comma: string) => {
      const items = body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => line.trim().replace(/,$/, ""));
      const line = `${indent}${key}[${items.join(", ")}]${comma}`;
      return line.length <= LINE_WIDTH ? line : match;
    },
  );
  return `${folded}\n`;
}
