import { useState } from "react";
import { toast } from "sonner";
import type {
  HoldPlaceResult,
  ScheduleStopResult,
} from "../../api/guards/writeResults.ts";
import { holdsQueryKey } from "../../api/holdsQueries.ts";
import { schedulesQueryKey } from "../../api/jobsQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import { systemStatusQueryKey } from "../../api/systemQueries.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import {
  type HoldPlaceInput,
  placeHold,
  stopSchedule,
} from "../../api/writes.ts";
import {
  checkPlaceForm,
  type PlaceForm,
  type ScheduleFreeze,
} from "../../lib/holdPlace.ts";
import {
  describeHoldPlaceResult,
  describeScheduleStopResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "../../lib/writeNotices.ts";

function announce(notice: ReleaseNotice): void {
  switch (notice.tone) {
    case "success":
      toast.success(notice.message);
      return;
    case "info":
      toast.info(notice.message);
      return;
    case "warning":
      toast.warning(notice.message);
      return;
    case "error":
      toast.error(notice.message);
      return;
  }
}

/** 保留と凍結を置く操作を、共通の書き込みの流れに載せる設定。種類と対象ごとにロックし、置いた後は保留と状態の取得を読み直す。 */
export const PLACE_HOLD: WriteRunnerConfig<HoldPlaceInput, HoldPlaceResult> = {
  keyOf: (input) => `place:${input.kind}:${input.target}`,
  run: (input) => placeHold(input),
  invalidates: [holdsQueryKey, systemStatusQueryKey],
  onOutcome: (outcome) => {
    announce(releaseNotice(outcome, describeHoldPlaceResult));
  },
  onStale: () => {
    announce(STALE_LIST_NOTICE);
  },
};

/** scheduleを止める操作の設定。scheduleごとにロックし、止めた後はscheduleと保留の取得を読み直す。 */
export const STOP_SCHEDULE: WriteRunnerConfig<string, ScheduleStopResult> = {
  keyOf: (path) => `schedule-stop:${path}`,
  run: (path) => stopSchedule(path),
  invalidates: [schedulesQueryKey, holdsQueryKey],
  onOutcome: (outcome) => {
    announce(releaseNotice(outcome, describeScheduleStopResult));
  },
  onStale: () => {
    announce(STALE_LIST_NOTICE);
  },
};

/** 置く確認の入力欄の初期値。期限は1時間にする。止める準備は、対象のscheduleを固定した凍結から始める。 */
export function initialPlaceForm(
  variant: "any" | "stop_prepare",
  schedulePath = "",
): PlaceForm {
  return variant === "any"
    ? { kind: "merge", target: "", minutesText: "60", reason: "" }
    : {
        kind: "freeze",
        target: schedulePath,
        minutesText: "60",
        reason: "",
      };
}

type PlaceDialogState = {
  readonly variant: "any" | "stop_prepare";
  readonly form: PlaceForm;
};

/**
 * 保留や凍結を置く操作。確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。
 * 入力が整わないうちは呼ばない。実行中は同じ種類と対象を操作できない。
 */
export function usePlaceHold() {
  const [dialog, setDialog] = useState<PlaceDialogState | null>(null);
  const place = useWriteMutation(PLACE_HOLD);

  return {
    dialog,
    begin: (variant: "any" | "stop_prepare", schedulePath = "") => {
      setDialog({ variant, form: initialPlaceForm(variant, schedulePath) });
    },
    change: (form: PlaceForm) => {
      setDialog((current) => (current === null ? null : { ...current, form }));
    },
    dismiss: () => {
      setDialog(null);
    },
    confirm: () => {
      if (dialog === null) return;
      const checked = checkPlaceForm(dialog.form);
      if (!checked.ok) return;
      setDialog(null);
      place.submit(checked.input);
    },
    /** `path`のscheduleの凍結を、置いている最中か。 */
    isFreezeLocked: (path: string) =>
      place.isLocked({ kind: "freeze", target: path, minutes: 1, reason: "-" }),
  };
}

type StopTarget = { readonly path: string; readonly freeze: ScheduleFreeze };

/** scheduleを止める操作。確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。実行中は同じscheduleを操作できない。 */
export function useScheduleStop() {
  const [target, setTarget] = useState<StopTarget | null>(null);
  const stop = useWriteMutation(STOP_SCHEDULE);

  return {
    target,
    choose: (path: string, freeze: ScheduleFreeze) => {
      setTarget({ path, freeze });
    },
    dismiss: () => {
      setTarget(null);
    },
    confirm: () => {
      if (target === null) return;
      setTarget(null);
      stop.submit(target.path);
    },
    isLocked: (path: string) => stop.isLocked(path),
  };
}
