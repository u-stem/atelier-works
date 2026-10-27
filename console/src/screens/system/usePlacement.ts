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
  type PlaceVariant,
  type ScheduleFreeze,
} from "../../lib/holdPlace.ts";
import {
  describeHoldPlaceResult,
  describeScheduleStopResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "../../lib/writeNotices.ts";
import { useReleaseFreeze } from "./useRelease.ts";

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

/**
 * 保留と凍結を置く操作を、共通の書き込みの流れに載せる設定。種類と対象ごとにロックし、置いた後は保留と状態の取得を読み直す。
 * 対象は、scriptが小文字にそろえて置くので、ロックの鍵も小文字にそろえる。
 */
export const PLACE_HOLD: WriteRunnerConfig<HoldPlaceInput, HoldPlaceResult> = {
  keyOf: (input) => `place:${input.kind}:${input.target.toLowerCase()}`,
  run: (input) => placeHold(input),
  invalidates: [holdsQueryKey, systemStatusQueryKey],
  onOutcome: (outcome) => {
    announce(releaseNotice(outcome, describeHoldPlaceResult));
  },
  onStale: () => {
    announce(STALE_LIST_NOTICE);
  },
};

/** スケジュールを止める操作の設定。スケジュールごとにロックし、止めた後はスケジュールと保留の取得を読み直す。 */
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

/** 置く確認の入力欄の初期値。期限は1時間にする。止める準備は、対象のスケジュールを固定した凍結から始める。 */
export function initialPlaceForm(
  variant: PlaceVariant,
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

export type PlaceDialogState = {
  readonly variant: PlaceVariant;
  readonly form: PlaceForm;
};

/** 確認のダイアログを開く。開くだけで、書き込みは呼ばない。 */
export function beginPlacement(
  variant: PlaceVariant,
  schedulePath = "",
): PlaceDialogState {
  return { variant, form: initialPlaceForm(variant, schedulePath) };
}

/** 入力欄の変更を反映する。ダイアログが開いていなければ何もしない。 */
export function editPlacement(
  current: PlaceDialogState | null,
  form: PlaceForm,
): PlaceDialogState | null {
  return current === null ? null : { ...current, form };
}

/**
 * 確認を通ったときの流れ。入力が整っていれば`submit`を1回呼んで閉じ、整っていなければ何も呼ばずに開いたままにする。
 * 止める準備では、凍結が止められる前に終わる期限も整っていない入力として扱う。
 */
export function confirmPlacement(
  dialog: PlaceDialogState | null,
  submit: (input: HoldPlaceInput) => boolean,
): PlaceDialogState | null {
  if (dialog === null) return null;
  const checked = checkPlaceForm(dialog.form, dialog.variant);
  if (!checked.ok) return dialog;
  submit(checked.input);
  return null;
}

type ScheduleTarget = {
  readonly path: string;
  readonly freeze: ScheduleFreeze;
};

/** 止める確認を通ったときの流れ。選んだスケジュールがあれば`submit`を1回呼んで閉じる。 */
export function confirmStop(
  target: ScheduleTarget | null,
  submit: (path: string) => boolean,
): ScheduleTarget | null {
  if (target === null) return null;
  submit(target.path);
  return null;
}

/** 戻す確認を通ったときの流れ。選んだスケジュールの凍結があれば、その解除を`submit`に1回渡して閉じる。 */
export function confirmRestore(
  target: ScheduleTarget | null,
  submit: (freezeId: string) => boolean,
): ScheduleTarget | null {
  if (target === null) return null;
  submit(target.freeze.id);
  return null;
}

/**
 * 保留や凍結を置く操作。確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。
 * 入力が整わないうちは呼ばない。実行中は同じ種類と対象を操作できない。
 */
export function usePlaceHold() {
  const [dialog, setDialog] = useState<PlaceDialogState | null>(null);
  const place = useWriteMutation(PLACE_HOLD);

  return {
    dialog,
    begin: (variant: PlaceVariant, schedulePath = "") => {
      setDialog(beginPlacement(variant, schedulePath));
    },
    change: (form: PlaceForm) => {
      setDialog((current) => editPlacement(current, form));
    },
    dismiss: () => {
      setDialog(null);
    },
    confirm: () => {
      setDialog(confirmPlacement(dialog, place.submit));
    },
    /** `path`のスケジュールの凍結を、置いている最中か。 */
    isFreezeLocked: (path: string) =>
      place.isLocked({ kind: "freeze", target: path, minutes: 1, reason: "-" }),
  };
}

/** スケジュールを止める操作。確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。実行中は同じスケジュールを操作できない。 */
export function useScheduleStop() {
  const [target, setTarget] = useState<ScheduleTarget | null>(null);
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
      setTarget(confirmStop(target, stop.submit));
    },
    isLocked: (path: string) => stop.isLocked(path),
  };
}

/**
 * 止めたスケジュールを、凍結の解除で戻す操作。既存の解除の流れ(`useReleaseFreeze`)を使い、新しい書き込み口は足さない。
 * 確認のダイアログを開き、確認を通った後にだけ解除を呼ぶ。実行中は同じ凍結を操作できない。
 */
export function useScheduleRestore() {
  const [target, setTarget] = useState<ScheduleTarget | null>(null);
  const release = useReleaseFreeze();

  return {
    target,
    choose: (path: string, freeze: ScheduleFreeze) => {
      setTarget({ path, freeze });
    },
    dismiss: () => {
      setTarget(null);
    },
    confirm: () => {
      setTarget(confirmRestore(target, release.submit));
    },
    isLocked: (freezeId: string) => release.isLocked(freezeId),
  };
}
