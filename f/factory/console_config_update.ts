// Consoleから、factory_configの許可した項目を1つ、止める向きか下げる向きにだけ変更するscript。
//
// 変更できるのは、次の項目と向きだけである。
// - 真偽の項目(`BOOLEAN_STOP_ITEMS`): `true`から`false`へ。自動でGitHubに書く機能を止める向きだけで、有効にする向きは人がCLIで行う。
// - 数値の項目(`LOWERABLE_NUMBERS`): いまの値より小さい値へ。下限は項目ごとに決める。
// 許可表の外の項目、`owners`や`repo_allowlist`のような権限に関わる設定、`*_since`は、変更できない。
// 向きを下げる変更は、設定の組み合わせの検査(有効にする向きの検査だけ)に触れないので、項目ごとの検査で足りる。
// この対応は`tests/scripts/console_config_update.test.ts`が、実際の設定の検証に通して確かめる。
//
// 補間しない生の値を読み、許可した1項目だけを置き換えて、全体を書き戻す。他のキーは同じ文字列のまま残す。
// 値のどこかに`$var:`か`$res:`があれば、参照の先をこのscriptが解決しないよう、変更しない。
// 呼び出し側が「読んだ時の値」を渡し、書く直前に読み直した値と違えば変更しない(比較交換)。
// Windmillのresourceの更新は条件付きの書き込みを持たないので、読み直しから書き込みまでの間は原子的でない。
// その間に別の経路が同じ項目を書くと、その書き込みを上書きする。書いた後に読み直して、変更が残ったかを返す。
//
// 操作の記録(`factory.console_actions`)は、読み取りの前に`attempted`の行を入れ、後で結果を更新する。
// 記録するのは項目名と前後の値(数値か真偽)だけで、設定の全体は入れない。
// 行を入れられなければ、変更せずに断る。更新に失敗しても変更は戻さず、`action_audit`を`failed`にする。
// 操作者は、ジョブのWindmill実行文脈から導く(`deriveApprover`)。導けなければ断る。引数に操作者は取らない。
//
// Console用workerで動くので、どのsecret変数も読まない。SDKの呼び出しは、境界テストの許可表に収める。
// 読み書きするパスはリテラルの`f/factory/factory_config`だけで、境界テストが固定する。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  actionSqlClientFrom,
  type RecordedOperation,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { holdsReference, isRecord } from "./lib/console_redact.ts";

const CONFIG_TARGET = "f/factory/factory_config";

/**
 * `true`から`false`へだけ変えられる真偽の項目。どれも、自動でGitHubに書くか、実装を起動する機能の入口である。
 * `pr_conflict_watch_enabled`は、GitHubに書かず通知だけなので入れない。`*_since`には触れない。
 */
export const BOOLEAN_STOP_ITEMS: readonly string[] = [
  "implement_enabled",
  "dependabot_enabled",
  "dependabot_merge_enabled",
  "pr_ci_fix_enabled",
  "pr_conflict_fix_enabled",
];

/**
 * 数値の項目の規則。`integer`は整数に限る。下限は`minimum`で、`minimumExclusive`なら下限を含まない。
 * 新しい値は、いまの値より小さい値に限るので、上限は持たない。
 */
export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

/**
 * いまの値より小さい値へだけ変えられる数値の項目。予算は0より大きい値、回数と行数と件数は1以上の整数に限る。
 * 0にすると、設定の検証が拒否するか、Claudeの利用が止まる。止めるのは真偽の項目の役割である。
 * 型の他の数値の項目(`retention_*`、`dependabot_min_published_days`、`worker_alert_memory_ratio`、`*_timeout_sec`)は、
 * 変更できない。
 */
export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {
  daily_budget_usd: { integer: false, minimum: 0, minimumExclusive: true },
  max_budget_usd_per_run: {
    integer: false,
    minimum: 0,
    minimumExclusive: true,
  },
  max_fix_rounds: { integer: true, minimum: 1, minimumExclusive: false },
  implement_max_changed_files: {
    integer: true,
    minimum: 1,
    minimumExclusive: false,
  },
  max_fix_diff_lines: { integer: true, minimum: 1, minimumExclusive: false },
};

/** 断る理由。画面は日本語の固定文に直す。 */
export const CONFIG_UPDATE_REFUSAL_REASONS = [
  "item_not_allowed",
  "invalid_value",
  "not_lowering",
  "has_reference",
  "conflict",
  "actor_unknown",
  "audit_unavailable",
] as const;

export type ConfigUpdateRefusalReason =
  (typeof CONFIG_UPDATE_REFUSAL_REASONS)[number];

export type ConfigUpdateResult =
  | { readonly refused: true; readonly reason: ConfigUpdateRefusalReason }
  | {
      readonly refused: false;
      readonly item: string;
      readonly before: number | boolean;
      readonly after: number | boolean;
      /** 書いた後に読み直した値が、期待と同じか(対象の項目が新しい値で、他のキーが同じ)。 */
      readonly verified: boolean;
      readonly action_audit: ActionAudit;
    };

/** `updateConfigFromConsole`が使う外部の操作。テストでは差し替える。 */
export type ConfigUpdatePorts = {
  /** 操作者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** 補間しない生の値を返す。 */
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (value: Record<string, unknown>) => Promise<void>;
  readonly sql: ActionSqlClient;
};

function ownRule(item: string): NumberRule | undefined {
  return Object.hasOwn(LOWERABLE_NUMBERS, item)
    ? LOWERABLE_NUMBERS[item]
    : undefined;
}

type Change =
  | {
      readonly kind: "ok";
      readonly before: number | boolean;
      readonly after: number | boolean;
    }
  | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason };

function refusedWith(reason: ConfigUpdateRefusalReason): Change {
  return { kind: "refused", reason };
}

function numberFits(value: unknown, rule: NumberRule): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (rule.integer && !Number.isInteger(value)) return false;
  return rule.minimumExclusive ? value > rule.minimum : value >= rule.minimum;
}

/**
 * 項目と、読んだ時の値と、新しい値が、許可表に合うか判定する。外部を読まず、記録も書かない。
 * 項目が許可表の外なら`item_not_allowed`、値の型や範囲が合わなければ`invalid_value`、
 * 止める向き(真偽は`true`から`false`)か下げる向き(数値は小さい値)でなければ`not_lowering`にする。
 */
export function checkChange(
  item: string,
  expected: unknown,
  next: unknown,
): Change {
  if (BOOLEAN_STOP_ITEMS.includes(item)) {
    if (typeof expected !== "boolean" || typeof next !== "boolean") {
      return refusedWith("invalid_value");
    }
    return expected && !next
      ? { kind: "ok", before: expected, after: next }
      : refusedWith("not_lowering");
  }
  const rule = ownRule(item);
  if (rule === undefined) return refusedWith("item_not_allowed");
  if (!numberFits(expected, rule) || !numberFits(next, rule)) {
    return refusedWith("invalid_value");
  }
  return next < expected
    ? { kind: "ok", before: expected, after: next }
    : refusedWith("not_lowering");
}

type WriteStep =
  | { readonly kind: "refused"; readonly reason: ConfigUpdateRefusalReason }
  | { readonly kind: "written"; readonly verified: boolean };

/** 項目以外のキーを同じ順に並べた文字列。書き戻しの前後で、他のキーが変わらないことの確認に使う。 */
function withoutItem(config: Record<string, unknown>, item: string): string {
  return JSON.stringify(Object.entries(config).filter(([key]) => key !== item));
}

/** 書いた後の読み直し。読めない、期待と違う形、対象の項目か他のキーが違うときは、`false`。 */
async function verifyWritten(
  ports: ConfigUpdatePorts,
  item: string,
  written: Record<string, unknown>,
  after: number | boolean,
): Promise<boolean> {
  try {
    const read = await ports.readConfig();
    return (
      isRecord(read) &&
      read[item] === after &&
      withoutItem(read, item) === withoutItem(written, item)
    );
  } catch {
    return false;
  }
}

/**
 * 項目`item`を、読んだ時の値`expected`から`next`へ変更する。
 * 呼び出しの順序は、許可表の判定、操作者の導出、記録(`attempted`)、読み取り、書き込み、読み直し、記録(結果)に固定する。
 * 読み取りの後の判定(参照を含む、読んだ時の値と違う)で断ったときも、記録は`failed`で残す。
 * 読み取りと書き込みの失敗は、記録を`failed`にしてから投げる。
 */
export async function updateConfigFromConsole(
  item: string,
  expected: unknown,
  next: unknown,
  ports: ConfigUpdatePorts,
): Promise<ConfigUpdateResult> {
  const change = checkChange(item, expected, next);
  if (change.kind === "refused") {
    return { refused: true, reason: change.reason };
  }
  let actor: string;
  try {
    actor = ports.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }

  const { before, after } = change;
  const recorded = await runRecordedAs(
    () => actor,
    {
      action: "config_update",
      target: CONFIG_TARGET,
      changes: { item, before, after },
    },
    async (): Promise<RecordedOperation<WriteStep>> => {
      const current = await ports.readConfig();
      if (!isRecord(current) || current[item] !== before) {
        return {
          outcome: "failed",
          changes: { refusal: "conflict" },
          value: { kind: "refused", reason: "conflict" },
        };
      }
      if (holdsReference(current)) {
        return {
          outcome: "failed",
          changes: { refusal: "has_reference" },
          value: { kind: "refused", reason: "has_reference" },
        };
      }
      const written = { ...current, [item]: after };
      await ports.writeConfig(written);
      const verified = await verifyWritten(ports, item, written, after);
      return {
        outcome: verified ? "succeeded" : "partial",
        changes: { verified },
        value: { kind: "written", verified },
      };
    },
    { sql: ports.sql, onUnrecordable: "refuse" },
  );
  if (!recorded.ok) {
    return { refused: true, reason: "audit_unavailable" };
  }
  if (recorded.value.kind === "refused") {
    return { refused: true, reason: recorded.value.reason };
  }
  return {
    refused: false,
    item,
    before,
    after,
    verified: recorded.value.verified,
    action_audit: recorded.audit,
  };
}

function sdkPorts(): ConfigUpdatePorts {
  const workspace = wmillDefault.getWorkspace();
  return {
    deriveActor: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    readConfig: () =>
      wmill.ResourceService.getResourceValue({
        workspace,
        path: "f/factory/factory_config",
      }),
    writeConfig: async (value) => {
      await wmill.ResourceService.updateResourceValue({
        workspace,
        path: "f/factory/factory_config",
        requestBody: { value },
      });
    },
    sql: actionSqlClientFrom(() => wmill.datatable()),
  };
}

/**
 * Consoleから、factory_configの項目を1つ、止める向きか下げる向きに変更する。
 * 操作者はジョブの実行文脈から導く。
 */
export async function main(
  item: string,
  expected: number | boolean,
  next: number | boolean,
): Promise<ConfigUpdateResult> {
  return await updateConfigFromConsole(item, expected, next, sdkPorts());
}
