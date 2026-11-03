import { type RefObject, useEffect, useRef, useState } from "react";
import { focusFirstInvalid } from "./focusInvalid.ts";

type FocusFirstInvalid = {
  /** フォームに付ける。誤りのある入力欄をこの中から探す。 */
  readonly formRef: RefObject<HTMLFormElement | null>;
  /** 送信が誤りで止まったときに呼ぶ。誤りの表示を描いた後に、最初の誤りの入力欄へフォーカスを移す。 */
  readonly request: () => void;
};

/**
 * 送信が誤りで止まったとき、最初の誤りの入力欄へフォーカスを移す。
 * 誤りの表示は、送信で描き直された後に属性が付く。移すのは描いた後でなければならないので、
 * 要求を数え、数が変わった描画の後にだけ移す。入力の途中の描き直しでは移さない。
 */
export function useFocusFirstInvalid(): FocusFirstInvalid {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    if (requests > 0 && formRef.current !== null) {
      focusFirstInvalid(formRef.current);
    }
  }, [requests]);
  return {
    formRef,
    request: () => {
      setRequests((count) => count + 1);
    },
  };
}
