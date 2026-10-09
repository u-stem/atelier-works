import { useEffect, useMemo, useRef, useState } from "react";
import {
  acceptsFrameMessages,
  buildRenderMessage,
  DRAWIO_FRAME_SRC,
  type DrawioRenderMessage,
  FRAME_STOPPED_TEXT,
  type FrameErrorReason,
  type FramePhase,
  frameErrorText,
  MAX_XML_BYTES,
  MIN_FRAME_HEIGHT,
  phaseAfterLoad,
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
 */
export function DrawioFrame({ xml, title }: DrawioFrameProps) {
  const [generation, setGeneration] = useState({ xml, count: 0 });
  if (generation.xml !== xml) {
    setGeneration({ xml, count: generation.count + 1 });
  }
  const result = useMemo(() => buildRenderMessage(xml), [xml]);

  if (!result.ok) {
    return (
      <p className="text-sm text-muted-foreground">
        {result.reason === "empty"
          ? "図のデータがありません。"
          : `図のXMLが大きすぎるため、表示しません(上限${MAX_XML_BYTES / 1024}KB)。`}
      </p>
    );
  }
  return (
    <SingleUseFrame
      key={generation.count}
      message={result.message}
      title={title}
    />
  );
}

type SingleUseFrameProps = {
  readonly message: DrawioRenderMessage;
  readonly title: string;
};

/** 1つのiframeの一生を扱う。段階と高さ、失敗は、iframeと一緒に捨てられる。 */
function SingleUseFrame({ message, title }: SingleUseFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const phaseRef = useRef<FramePhase>("loading");
  const [stopped, setStopped] = useState(false);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const [errorReason, setErrorReason] = useState<FrameErrorReason | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (!acceptsFrameMessages(phaseRef.current)) {
        return;
      }
      const frameWindow = frameRef.current?.contentWindow;
      const nextHeight = readFrameHeight(event.source, frameWindow, event.data);
      if (nextHeight !== null) {
        setHeight(nextHeight);
        return;
      }
      const reason = readFrameError(event.source, frameWindow, event.data);
      if (reason !== null) {
        setErrorReason(reason);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function onLoad(): void {
    const next = phaseAfterLoad(phaseRef.current);
    phaseRef.current = next.phase;
    if (next.send) {
      frameRef.current?.contentWindow?.postMessage(message, "*");
    }
    if (next.phase === "stopped") {
      // 2回目のloadは、iframeが別の文書へ遷移したことを表す。
      setStopped(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 枠線は外側に付ける。iframeに付けると、高さが枠線の分だけ足りなくなる。 */}
      <div
        className="overflow-hidden rounded-md border border-border"
        hidden={stopped}
      >
        <iframe
          ref={frameRef}
          title={title}
          src={stopped ? "about:blank" : DRAWIO_FRAME_SRC}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height }}
          onLoad={onLoad}
        />
      </div>
      {stopped ? (
        <p role="alert" className="text-sm text-destructive">
          {FRAME_STOPPED_TEXT}
        </p>
      ) : null}
      {errorReason !== null && !stopped ? (
        <p role="alert" className="text-sm text-destructive">
          {frameErrorText(errorReason)}
        </p>
      ) : null}
    </div>
  );
}
