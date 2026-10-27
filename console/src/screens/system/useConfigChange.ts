import { useState } from "react";
import { toast } from "sonner";
import type { ConfigUpdateResult } from "../../api/guards/writeResults.ts";
import { configQueryKey } from "../../api/jobsQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import { type ConfigUpdateInput, updateConfig } from "../../api/writes.ts";
import { type ChangeOffer, parseNewNumber } from "../../lib/configChange.ts";
import {
  describeConfigUpdateResult,
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

/** 設定の変更を、共通の書き込みの流れに載せる設定。項目ごとにロックし、変更の後は設定の取得を読み直す。 */
const CONFIG_UPDATE: WriteRunnerConfig<ConfigUpdateInput, ConfigUpdateResult> =
  {
    keyOf: (input) => `config:${input.item}`,
    run: (input) => updateConfig(input),
    invalidates: [configQueryKey],
    onOutcome: (outcome) => {
      announce(releaseNotice(outcome, describeConfigUpdateResult));
    },
    onStale: () => {
      announce(STALE_LIST_NOTICE);
    },
  };

/**
 * 変更の候補から、書き込みの入力を作る。数値は、入力欄の文字列が使えるときだけ作る。
 * 読んだ時の値(`expected`)は、候補を作ったときの値で、scriptが書く直前の値と突き合わせる。
 */
export function changeInputOf(
  offer: ChangeOffer,
  text: string,
): ConfigUpdateInput | null {
  if (offer.kind === "stop") {
    return { item: offer.key, expected: true, next: false };
  }
  const parsed = parseNewNumber(text, offer);
  return parsed.ok
    ? { item: offer.key, expected: offer.current, next: parsed.value }
    : null;
}

/**
 * 設定の変更の操作。項目を選ぶと確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。
 * 実行中は同じ項目を操作できない。
 */
export function useConfigChange() {
  const [offer, setOffer] = useState<ChangeOffer | null>(null);
  const [text, setText] = useState("");
  const change = useWriteMutation(CONFIG_UPDATE);

  return {
    offer,
    text,
    setText,
    choose: (chosen: ChangeOffer) => {
      setText("");
      setOffer(chosen);
    },
    dismiss: () => {
      setOffer(null);
    },
    confirm: () => {
      if (offer === null) return;
      const input = changeInputOf(offer, text);
      if (input === null) return;
      setOffer(null);
      change.submit(input);
    },
    isLocked: (chosen: ChangeOffer) =>
      change.isLocked({ item: chosen.key, expected: true, next: false }),
  };
}
