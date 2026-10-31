// Factory Consoleの「新規投入」から呼ぶscript。
// 入力を検証して、既存のフロー`f/factory/manual_intake`を起動するだけの薄い入口である。
// Issueの作成、オーナーIDの照合、作業項目の登録、pipelineの起動は、フローのステップが行う。
//
// Console用workerで動くので、どのsecret変数も読まない。DBに書くのは、操作の記録(`factory.console_actions`)だけである。
// 記録は、フローを起動する前に`attempted`の行を入れ、起動した後に結果を更新する。書けなくても投入は通し、
// 戻りの`action_audit`を`failed`にする。記録にはリポジトリだけを入れ、題名と本文は入れない。
// フローは呼び出した主体の権限で起動する(`on_behalf_of_email`を置かない)。
// このため、投入できる主体はWindmillのUIから同じフローを実行できる主体と同じになる。
// 実行者はジョブの実行文脈から導き、ログに残す。導けなければ断る。
// 断りは例外にせず、理由の符号だけを返す。入力の文字列は理由に含めない。

import * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import { loadConfig } from "./lib/config.ts";
import {
  type ActionAudit,
  type ActionSqlClient,
  runRecordedAs,
} from "./lib/console_actions.ts";
import { defaultSqlClient } from "./lib/db.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { type Logger, logger } from "./lib/log.ts";
import {
  type ManualIntakeFields,
  type ManualIntakeRefusalReason,
  validateManualIntake,
} from "./lib/manual_intake_support.ts";
import type { FactoryConfig } from "./lib/types.ts";

const MANUAL_INTAKE_FLOW_PATH = "f/factory/manual_intake";

export type ManualIntakeSubmitResult =
  | {
      readonly refused: true;
      readonly reason: ManualIntakeRefusalReason;
    }
  | {
      readonly refused: false;
      readonly flow_job_id: string;
      /** 操作の記録を書けたか。`submitManualIntakeRecorded`が付ける。 */
      readonly action_audit?: ActionAudit;
    };

/** `submitManualIntake`が使う外部の操作。テストでは差し替える。 */
export type ManualIntakeSubmitDeps = {
  readonly loadConfig: () => Promise<
    Pick<FactoryConfig, "owners" | "repo_allowlist" | "factory_repo">
  >;
  /** 実行者を返す。導けないときは例外を投げる。 */
  readonly deriveActor: () => string;
  /** フローを起動して、応答の文字列をそのまま返す。 */
  readonly runFlow: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  readonly log: Pick<Logger, "info">;
};

/**
 * 入力を検証し、通れば`manual_intake`フローを非同期に起動する。
 * 断るときは`{ refused: true, reason }`を返し、フローを起動しない。
 * フローには、検証に使った前後の空白を除いた題名を渡す。検証した長さとGitHubへ届く長さを一致させるためである。
 * 起動の応答がジョブIDでないとき、起動に失敗したときは例外を投げる。
 */
export async function submitManualIntake(
  input: ManualIntakeFields,
  deps: ManualIntakeSubmitDeps,
): Promise<ManualIntakeSubmitResult> {
  const config = await deps.loadConfig();
  const validation = validateManualIntake(input, config);
  if (!validation.ok) {
    return { refused: true, reason: validation.reason };
  }

  let actor: string;
  try {
    actor = deps.deriveActor();
  } catch {
    return { refused: true, reason: "actor_unknown" };
  }

  // 題名と本文は、信頼できない入力なのでログに残さない。
  // 起動の前に残すのは、起動に失敗しても誰が投入しようとしたかを追えるようにするためである。
  deps.log.info("manual intake requested", {
    actor,
    owner: input.owner,
    repo: input.repo,
  });
  const flowJobId = parseFlowJobId(
    await deps.runFlow(MANUAL_INTAKE_FLOW_PATH, {
      owner: input.owner,
      repo: input.repo,
      title: validation.title,
      body: input.body,
      acceptance_criteria: input.acceptance_criteria,
      profile: input.profile,
      // キーが無い呼び出しには、引数を足さない。フローは、キーが無い従来の投入として動く。
      ...(input.intake_key === undefined
        ? {}
        : { intake_key: input.intake_key }),
    }),
    "runFlowAsync",
  );
  deps.log.info("manual intake started", {
    actor,
    flow_job_id: flowJobId,
  });
  return { refused: false, flow_job_id: flowJobId };
}

/**
 * 投入を、操作の記録(`factory.console_actions`)で包む。記録するのは、フローを起動する操作だけである。
 * 検証で断った投入は、何も起動しないので記録しない。
 * 操作の前に`attempted`の行を入れ、フローを起動した後に結果を更新する。
 * 記録を書けなくても投入は通し、戻りの`action_audit`を`failed`にする。
 * 記録には、リポジトリ(`owner/repo`)だけを入れ、題名と本文は入れない。
 */
export async function submitManualIntakeRecorded(
  input: ManualIntakeFields,
  deps: ManualIntakeSubmitDeps,
  sql: ActionSqlClient,
): Promise<ManualIntakeSubmitResult> {
  const state: { audit: ActionAudit } = { audit: "failed" };
  const result = await submitManualIntake(input, {
    ...deps,
    runFlow: async (path, args) => {
      const recorded = await runRecordedAs(
        deps.deriveActor,
        {
          action: "manual_intake_submit",
          target: `${input.owner}/${input.repo}`,
          changes: { owner: input.owner, repo: input.repo },
        },
        async () => ({
          outcome: "succeeded" as const,
          changes: {},
          value: await deps.runFlow(path, args),
        }),
        { sql, onUnrecordable: "proceed" },
      );
      if (!recorded.ok) {
        throw new Error(`manual_intake_submit: ${recorded.reason}`);
      }
      state.audit = recorded.audit;
      return recorded.value;
    },
  });
  return result.refused ? result : { ...result, action_audit: state.audit };
}

/**
 * Consoleの新規投入。実行者はジョブの実行文脈から導く。
 * `profile`は進め方で、省くと通常の進め方になる。受け付けない値は、検証で断る。
 * `intake_key`は投入の再送を止める冪等キー(小文字のUUID)で、省くと再送を止めない従来の投入になる。
 * 形が違うキーは、検証で断る。
 */
export async function main(
  owner: string,
  repo: string,
  title: string,
  body: string,
  acceptance_criteria: string = "",
  profile: string = "standard",
  intake_key?: string,
): Promise<ManualIntakeSubmitResult> {
  // Windmillは、渡されなかった引数を`null`で渡すことがある。`null`は、キーが無い呼び出しとして扱う。
  return await submitManualIntakeRecorded(
    {
      owner,
      repo,
      title,
      body,
      acceptance_criteria,
      profile,
      ...(intake_key == null ? {} : { intake_key }),
    },
    {
      loadConfig: () =>
        loadConfig(() => wmill.getResource("f/factory/factory_config")),
      deriveActor: () =>
        deriveApprover({
          WM_USERNAME: process.env.WM_USERNAME,
          WM_EMAIL: process.env.WM_EMAIL,
        }),
      runFlow: (path, args) => wmill.runFlowAsync(path, args),
      log: logger("manual_intake_submit"),
    },
    defaultSqlClient,
  );
}
