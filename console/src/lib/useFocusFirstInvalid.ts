import { type RefObject, useEffect, useRef, useState } from "react";
import { focusFirstInvalid, invalidAnnouncement } from "./focusInvalid.ts";

/** 読み上げ専用の領域に渡す文。`serial`が変わるたびに、同じ文でも読み直される。 */
type InvalidStatusMessage = {
  readonly text: string;
  readonly serial: number;
};

type FocusFirstInvalid = {
  /** フォームに付ける。誤りのある入力欄をこの中から探す。 */
  readonly formRef: RefObject<HTMLFormElement | null>;
  /** 送信が誤りで止まったときに呼ぶ。誤りの表示を描いた後に、最初の誤りの入力欄へフォーカスを移す。 */
  readonly request: () => void;
  /** 読み上げ専用の領域に渡す文。フォーカスがすでに最初の誤りの欄にあるときだけ、中身がある。 */
  readonly status: InvalidStatusMessage;
};

/**
 * 送信が誤りで止まったとき、最初の誤りの入力欄へフォーカスを移す。
 * 誤りの表示は、送信で描き直された後に属性が付く。移すのは描いた後でなければならないので、
 * 要求を数え、数が変わった描画の後にだけ移す。入力の途中の描き直しでは移さない。
 * フォーカスがすでにその欄にあると、`focus()`ではイベントが起きないので、件数を`status`に書く。
 */
export function useFocusFirstInvalid(): FocusFirstInvalid {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [requests, setRequests] = useState(0);
  const [status, setStatus] = useState<InvalidStatusMessage>({
    text: "",
    serial: 0,
  });
  useEffect(() => {
    const form = formRef.current;
    if (requests === 0 || form === null) {
      return;
    }
    const text = invalidAnnouncement(form, document.activeElement);
    focusFirstInvalid(form);
    setStatus({ text, serial: requests });
  }, [requests]);
  return {
    formRef,
    request: () => {
      setRequests((count) => count + 1);
    },
    status,
  };
}
