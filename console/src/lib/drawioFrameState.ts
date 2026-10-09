// draw.ioのiframe(DrawioFrame)の状態の遷移を、(state, event) => stateの純関数で表す。
// DOMには触れない。iframeのloadやmessageなどの出来事をeventにして、この関数に渡す。

import {
  clampFrameHeight,
  type FrameErrorReason,
  type FrameFailure,
  MIN_FRAME_HEIGHT,
} from "./drawioMessages.ts";

/** 最初のloadの後、高さも失敗も届かないときに、応答なしとみなすまでの時間。 */
export const RESPONSE_TIMEOUT_MS = 10_000;

/**
 * iframeの一生の段階。
 * - loading: 最初のloadを待っている
 * - rendered: 最初のloadでXMLを送った
 * - stopped: 2回目のloadを受けた(iframeが遷移した)ので、表示を止めた
 */
export type FramePhase = "loading" | "rendered" | "stopped";

export type FrameState = {
  readonly phase: FramePhase;
  /** iframeの高さ。数値と範囲は検査済みの値だけが入る。 */
  readonly height: number;
  /** 高さか失敗のメッセージが1つでも届いたか。届かなければ、iframeの中のscriptが動いていない。 */
  readonly responded: boolean;
  readonly failure: FrameFailure | null;
  /** iframeを作り直すたびに増える。iframeのkeyに使う。 */
  readonly generation: number;
};

export type FrameEvent =
  | { readonly type: "load" }
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "error"; readonly reason: FrameErrorReason }
  | { readonly type: "timeout" }
  | { readonly type: "replace" };

export function initialFrameState(generation = 0): FrameState {
  return {
    phase: "loading",
    height: MIN_FRAME_HEIGHT,
    responded: false,
    failure: null,
    generation,
  };
}

/**
 * このloadで、XMLを送ってよいかを返す。
 * 送るのは、iframeの一生の最初のloadの後の1回だけにする。
 * 2回目のloadは、iframeが別の文書へ遷移したことを表す。遷移した先にXMLを渡さない。
 * 最善の努力である。loadが起きない遷移は検知できない。
 * その場合も、親が受けるのは数値と固定の失敗の種類だけである。
 */
export function shouldSendXml(state: FrameState, event: FrameEvent): boolean {
  return event.type === "load" && state.phase === "loading";
}

export function reduceFrame(state: FrameState, event: FrameEvent): FrameState {
  switch (event.type) {
    case "replace":
      return initialFrameState(state.generation + 1);
    case "load":
      return {
        ...state,
        phase: state.phase === "loading" ? "rendered" : "stopped",
      };
    case "height":
      if (state.phase === "stopped") return state;
      return {
        ...state,
        height: clampFrameHeight(event.height),
        responded: true,
      };
    case "error":
      if (state.phase === "stopped") return state;
      return { ...state, failure: event.reason, responded: true };
    case "timeout":
      if (state.phase !== "rendered" || state.responded) return state;
      return { ...state, failure: "no_response" };
  }
}
