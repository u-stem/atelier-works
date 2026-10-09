import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildRenderMessage,
  DRAWIO_FRAME_SRC,
  MAX_XML_BYTES,
  MIN_FRAME_HEIGHT,
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
 * 送るのは図のXMLだけなので許容する。
 */
export function DrawioFrame({ xml, title }: DrawioFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const result = useMemo(() => buildRenderMessage(xml), [xml]);
  const message = result.ok ? result.message : null;

  // iframeの受け口は、scriptの実行後(loadの後)に使える。
  useEffect(() => {
    if (!loaded || message === null) {
      return;
    }
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, [loaded, message]);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const next = readFrameHeight(
        event.source,
        frameRef.current?.contentWindow,
        event.data,
      );
      if (next !== null) {
        setHeight(next);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
    <iframe
      ref={frameRef}
      title={title}
      src={DRAWIO_FRAME_SRC}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full rounded-md border border-border"
      style={{ height }}
      onLoad={() => setLoaded(true)}
    />
  );
}
