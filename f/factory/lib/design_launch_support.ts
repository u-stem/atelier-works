import type { WorkItem } from "./types.ts";

export const DESIGN_START_FAILED_REASON = "";

export type StartDesignOutcome =
  | "started"
  | "launch_failed"
  | "record_failed"
  | "flow_holds_lease";

export type DesignLaunchDeps = {
  readonly launchFlow: () => Promise<string>;
  readonly recordFlowJobId: (jobId: string) => Promise<boolean>;
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  readonly recordFailure: (reason: string, step: string) => Promise<void>;
  readonly addNotice: (reason: string) => Promise<void>;
  readonly notifyNeedsHuman: (reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export function designFlowInput(
  _item: Pick<WorkItem, "id" | "design_attempt">,
): {
  readonly work_item_id: number;
  readonly design_attempt: number;
  readonly feedback: string;
} {
  return { work_item_id: 0, design_attempt: 0, feedback: "stub" };
}

export async function startDesign(
  _deps: DesignLaunchDeps,
): Promise<StartDesignOutcome> {
  return "launch_failed";
}
