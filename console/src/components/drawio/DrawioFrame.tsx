import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FrameEvent,
  initialFrameState,
  RESPONSE_TIMEOUT_MS,
  reduceFrame,
  shouldSendXml,
} from "../../lib/drawioFrameState.ts";
import {
  buildRenderMessage,
  DRAWIO_FRAME_SRC,
  FRAME_STOPPED_TEXT,
  frameErrorText,
  MAX_XML_BYTES,
  readFrameError,
  readFrameHeight,
} from "../../lib/drawioMessages.ts";

type DrawioFrameProps = {
  /** draw.ioの図のXML。データ由来で、信用しない。 */
  readonly xml: string;
  /** iframeの内容を説明する名前(スクリーンリーダーが読む)。 */
  readonly title: string;
};

/**
 * draw.ioの図を、隔離したiframeで描く。
 * sandboxは`allow-scripts`だけにする。`allow-same-origin`が無いので、iframeは不透明な
 * オリジンになり、Cookieにも、Windmillにも、このページのDOMにも届かない。
 * XMLはpostMessageで渡す。不透明なオリジンには送り先のオリジンを指定できないので`"*"`を使う。
 * そのため、1つのiframeに送るのは、最初のloadの後の1回だけにする。
 * 図のXMLが変わったら、iframeごと作り直す(keyを変える)。
 * 状態の遷移は`lib/drawioFrameState.ts`の純関数にある。ここは、DOMの出来事をその入力にする。
 */
export function DrawioFrame({ xml, title }: DrawioFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stateRef = useRef(initialFrameState());
  const [state, setState] = useState(stateRef.current);
  const result = useMemo(() => buildRenderMessage(xml), [xml]);
  const message = result.ok ? result.message : null;
  const messageRef = useRef(message);
  messageRef.current = message;

  const dispatch = useCallback((event: FrameEvent) => {
    stateRef.current = reduceFrame(stateRef.current, event);
    setState(stateRef.current);
  }, []);

  // 図が変わったら、iframeを作り直す。最初の描画では何もしない。
  const previousXml = useRef(xml);
  useEffect(() => {
    if (previousXml.current !== xml) {
      previousXml.current = xml;
      dispatch({ type: "replace" });
    }
  }, [xml, dispatch]);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const frameWindow = frameRef.current?.contentWindow;
      const height = readFrameHeight(event.source, frameWindow, event.data);
      if (height !== null) {
        dispatch({ type: "height", height });
        return;
      }
      const reason = readFrameError(event.source, frameWindow, event.data);
      if (reason !== null) {
        dispatch({ type: "error", reason });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dispatch]);

  // 最初のloadの後、一定時間たっても高さも失敗も届かなければ、応答なしとみなす。
  const waiting = state.phase === "rendered" && !state.responded;
  // biome-ignore lint/correctness/useExhaustiveDependencies: iframeを作り直すたびに、待ちを数え直す。
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setTimeout(
      () => dispatch({ type: "timeout" }),
      RESPONSE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [waiting, state.generation, dispatch]);

  function onLoad(): void {
    const event: FrameEvent = { type: "load" };
    const send = shouldSendXml(stateRef.current, event);
    dispatch(event);
    if (send && messageRef.current !== null) {
      frameRef.current?.contentWindow?.postMessage(messageRef.current, "*");
    }
  }

  if (!result.ok) {
    return (
      <p className="text-sm text-muted-foreground">
        {result.reason === "empty"
          ? "図のデータがありません。"
          : `図のXMLが大きすぎるため、表示しません(上限${MAX_XML_BYTES / 1024}KB)。`}
      </p>
    );
  }

  const stopped = state.phase === "stopped";
  return (
    <div className="flex flex-col gap-2">
      {/* 枠線は外側に付ける。iframeに付けると、高さが枠線の分だけ足りなくなる。 */}
      <div
        className="overflow-hidden rounded-md border border-border"
        hidden={stopped}
      >
        <iframe
          key={state.generation}
          ref={frameRef}
          title={title}
          src={stopped ? "about:blank" : DRAWIO_FRAME_SRC}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height: state.height }}
          onLoad={onLoad}
        />
      </div>
      {stopped ? (
        <p role="alert" className="text-sm text-destructive">
          {FRAME_STOPPED_TEXT}
        </p>
      ) : null}
      {state.failure !== null && !stopped ? (
        <p role="alert" className="text-sm text-destructive">
          {frameErrorText(state.failure)}
        </p>
      ) : null}
    </div>
  );
}
