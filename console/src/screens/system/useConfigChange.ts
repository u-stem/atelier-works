import { useState, useSyncExternalStore } from "react";
import type { WriteOutcome } from "../../api/executeWrite.ts";
import type { ConfigUpdateResult } from "../../api/guards/writeResults.ts";
import { configQueryKey } from "../../api/jobsQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import { type ConfigUpdateInput, updateConfig } from "../../api/writes.ts";
import { announce } from "../../components/announce.ts";
import {
  type ChangeOffer,
  parseNewElement,
  parseNewNumber,
} from "../../lib/configChange.ts";
import { createPinnedNoticeStore } from "../../lib/pinnedNotice.ts";
import {
  describeConfigUpdateResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
  staysUntilClosed,
} from "../../lib/writeNotices.ts";

/**
 * 閉じるまで残す知らせの置き場。設定のタブが1つだけ読む。
 * 画面の部品の外に置くので、結果が届いたときにシステムの画面を離れていても、戻ると残っている。
 */
export const configNoticeStore = createPinnedNoticeStore();

/**
 * 設定の変更の結果を、知らせの出し先に振り分ける。
 * 成功は数秒で消えるトーストにする。断り、確かめる警告、失敗は、操作が要るので、閉じるまで残す置き場に置く。
 * 置き場の知らせは、どの項目の結果かを保つため、入力の項目を添える。
 */
export function routeConfigOutcome(
  outcome: WriteOutcome<ConfigUpdateResult>,
  input: ConfigUpdateInput,
  sinks: {
    announce: (notice: ReleaseNotice) => void;
    pin: (item: string, notice: ReleaseNotice) => void;
  },
): void {
  const notice = releaseNotice(outcome, describeConfigUpdateResult);
  if (staysUntilClosed(notice)) {
    sinks.pin(input.item, notice);
  } else {
    sinks.announce(notice);
  }
}

/** 設定の変更を、共通の書き込みの流れに載せる設定。項目ごとにロックし、変更の後は設定の取得を読み直す。 */
const CONFIG_UPDATE: WriteRunnerConfig<ConfigUpdateInput, ConfigUpdateResult> =
  {
    keyOf: (input) => `config:${input.item}`,
    run: (input) => updateConfig(input),
    invalidates: [configQueryKey],
    onOutcome: (outcome, input) => {
      routeConfigOutcome(outcome, input, {
        announce,
        pin: configNoticeStore.pin,
      });
    },
    onStale: () => {
      announce(STALE_LIST_NOTICE, { transient: true });
    },
  };

/**
 * 変更の候補から、書き込みの入力を作る。数値と追加する要素は、入力欄の文字列が使えるときだけ作る。
 * 読んだ時の値(`expected`)は、候補を作ったときの値で、scriptが書く直前の値と突き合わせる。
 * 一覧の`next`は、読んだ配列の末尾に要素を足した配列か、選んだ位置の要素を除いた配列である。
 */
export function changeInputOf(
  offer: ChangeOffer,
  text: string,
): ConfigUpdateInput | null {
  switch (offer.kind) {
    case "stop":
      return { item: offer.key, expected: true, next: false };
    case "lower": {
      const parsed = parseNewNumber(text, offer);
      return parsed.ok
        ? { item: offer.key, expected: offer.current, next: parsed.value }
        : null;
    }
    case "add": {
      const parsed = parseNewElement(text);
      return parsed.ok
        ? {
            item: offer.key,
            expected: offer.current,
            next: [...offer.current, parsed.value],
          }
        : null;
    }
    case "remove":
      return {
        item: offer.key,
        expected: offer.current,
        next: offer.current.filter((_entry, index) => index !== offer.index),
      };
  }
}

/**
 * 設定の変更の操作。項目を選ぶと確認のダイアログを開き、確認を通った後にだけscriptを呼ぶ。
 * 実行中は同じ項目を操作できない。
 * 閉じるまで残す知らせ(`notice`)は、次の変更を始めたときに消す。前の結果が、新しい結果の隣に残らないためである。
 */
export function useConfigChange() {
  const [offer, setOffer] = useState<ChangeOffer | null>(null);
  const [text, setText] = useState("");
  const change = useWriteMutation(CONFIG_UPDATE);
  const notice = useSyncExternalStore(
    configNoticeStore.subscribe,
    configNoticeStore.get,
    configNoticeStore.get,
  );

  return {
    offer,
    text,
    setText,
    notice,
    closeNotice: configNoticeStore.dismiss,
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
      if (change.submit(input)) {
        configNoticeStore.dismiss();
      }
    },
    isLocked: (chosen: ChangeOffer) =>
      change.isLocked({ item: chosen.key, expected: true, next: false }),
  };
}
