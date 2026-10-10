// draw.io(mxGraph)の図を、隔離したiframeの中で描く。
// 図のXMLは信頼できないIssueの内容に由来する。Windmillと同じオリジンで描くと、
// ビューアが図形ライブラリを動的に取得して評価する経路や、図のリンクで遷移する経路が
// 管理者のセッションに届くので、図はすべてiframeの中に閉じ込める(`docs/security.md`)。
// - iframeのsandboxは`allow-scripts`だけにする。`allow-same-origin`が無いので、
//   不透明なオリジンになり、Windmillのクッキーにも、このページのDOMにも届かない。
//   ポップアップ、フォームの送信、トップレベルの遷移も許さない。
// - iframeの中身は固定のHTML(`lib/drawioFrameHtml.ts`)で、CSPが、受け口のスクリプトの
//   ハッシュと、固定したビューアのURL以外のスクリプトと、通信を許さない。
// - XMLは`srcdoc`に埋め込まず、最初のloadの後にpostMessageで1回だけ渡す。
//   iframeから届く高さは、送り元を確かめ、範囲に収めてから使う(`lib/drawioMessages.ts`)。
// - `f/factory/lib/drawio.ts`の`validateDrawioXml`が、リンクなどを含む図を、生成の時点と
//   `console_query`の読み戻しの時点で拒否する。
//
// ブラウザでの実行時には確かめていない点がある。WindmillのCSPが`srcdoc`のiframeと、
// jsDelivrのスクリプトを許すか(許さなければ図は「読み込まれていない」表示になる)と、
// 図が実際に描かれることを、`wmill app dev`と実機で確かめる。

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildDrawioFrameHtml } from "../lib/drawioFrameHtml";
import {
  type FrameEvent,
  initialFrameState,
  RESPONSE_TIMEOUT_MS,
  reduceFrame,
  shouldSendXml,
} from "../lib/drawioFrameState";
import {
  buildRenderMessage,
  FRAME_STOPPED_TEXT,
  frameErrorText,
  MAX_XML_BYTES,
  readFrameError,
  readFrameHeight,
} from "../lib/drawioMessages";

const FRAME_SRC_DOC = buildDrawioFrameHtml();

/**
 * draw.ioの図を1つ、隔離したiframeでその場に描く。
 * `xml`は、`f/factory/steps/console_query.ts`の`requirements_doc`ビューが
 * 要件定義ディレクトリから読み出し、検証を通した、圧縮していないmxGraphのXML。
 * 状態の遷移は`lib/drawioFrameState.ts`の純関数にある。ここは、DOMの出来事をその入力にする。
 * 不透明なオリジンには送り先のオリジンを指定できないので、postMessageは`"*"`で送る。
 * そのため、1つのiframeに送るのは最初のloadの後の1回だけにし、図が変わったらiframeを作り直す。
 */
export function DrawioViewer({
  name,
  xml,
}: {
  name: string;
  xml: string;
}): React.ReactElement {
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
      <div className="diagram-viewer diagram-viewer-error">
        {result.reason === "empty"
          ? `図 ${name} のデータがありません。`
          : `図 ${name} のXMLが大きすぎるため、表示しません(上限${MAX_XML_BYTES / 1024}KB)。`}
      </div>
    );
  }

  const stopped = state.phase === "stopped";
  return (
    <div className="diagram-viewer">
      {stopped ? null : (
        <iframe
          key={state.generation}
          ref={frameRef}
          title={`図 ${name}`}
          srcDoc={FRAME_SRC_DOC}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{
            display: "block",
            width: "100%",
            border: 0,
            height: state.height,
          }}
          onLoad={onLoad}
        />
      )}
      {stopped ? (
        <p role="alert" className="diagram-viewer-error">
          {FRAME_STOPPED_TEXT}
        </p>
      ) : null}
      {state.failure !== null && !stopped ? (
        <p role="alert" className="diagram-viewer-error">
          {frameErrorText(state.failure)}
        </p>
      ) : null}
    </div>
  );
}
