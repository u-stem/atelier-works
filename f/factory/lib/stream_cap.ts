// バイト列のストリームを、保持する量に上限を付けて読む。
// 子プロセスの出力(`workspace.ts`)と、GitHubの応答の本文(`github_http.ts`)が使う。
// 依存を持たない末端のモジュールにする。ファイルにも子プロセスにも触れない`github_http.ts`から読めるようにするため。

const OMITTED_MARKER_PATTERN = /\[\.\.\. \d+ bytes omitted \.\.\.\]/;

/** `readStreamCapped`が、保持した先頭と末尾の間に入れる文字列を返す。 */
export function omittedMarker(bytes: number): string {
  return `\n[... ${String(bytes)} bytes omitted ...]\n`;
}

/**
 * `readStreamCapped`が間を捨てたときの`omittedMarker`の位置(文字数)を返す。無ければ-1。
 * 位置より前が、保持した先頭である。
 */
export function omittedMarkerIndex(text: string): number {
  return text.search(OMITTED_MARKER_PATTERN);
}

/**
 * `readStreamCapped`が`text`の途中を捨てたかを返す。
 * 途中を捨てた機械可読のレポートは解析してはいけない。
 */
export function isCappedOutput(text: string): boolean {
  return OMITTED_MARKER_PATTERN.test(text);
}

/** signalが中断されたらreaderを取り消す(保留中のreadはdone: trueで返る)。戻り値は登録を外す関数。 */
export function cancelOnAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => {};
  const cancel = (): void => {
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    cancel();
    return () => {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

/** `readStreamCappedDetail`の結果。`omittedBytes`は捨てたバイト数で、0なら全体を保持した。 */
export type CappedRead = {
  readonly text: string;
  readonly omittedBytes: number;
};

/**
 * `stream`を最後まで読み、先頭の`floor(maxBytes / 2)`バイトと、
 * 末尾の`maxBytes - floor(maxBytes / 2)`バイトだけを保持して文字列で返す。
 * 先頭は固定長のバッファ、末尾は固定長のリングバッファにコピーするので、
 * ストリームが長くてもメモリは増えない。
 * 間を捨てたときは、2つの部分を別々にデコードし、`omittedMarker(捨てたバイト数)`でつなぐ
 * (境界で切れたマルチバイト文字はU+FFFDになる)。
 * 捨てたかどうかは、本文の文字列ではなく、捨てたバイト数(`omittedBytes`)で返す。
 * signalが中断されたら、それまでに保持した分で返す。
 */
export async function readStreamCappedDetail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CappedRead> {
  const headLimit = Math.floor(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  const head = new Uint8Array(headLimit);
  let headSize = 0;
  const ring = new Uint8Array(tailLimit);
  let ringStart = 0;
  let ringSize = 0;
  let omitted = 0;

  const pushTail = (bytes: Uint8Array): void => {
    if (tailLimit === 0) {
      omitted += bytes.byteLength;
      return;
    }
    if (bytes.byteLength >= tailLimit) {
      omitted += ringSize + (bytes.byteLength - tailLimit);
      ring.set(bytes.subarray(bytes.byteLength - tailLimit), 0);
      ringStart = 0;
      ringSize = tailLimit;
      return;
    }
    const overflow = ringSize + bytes.byteLength - tailLimit;
    if (overflow > 0) {
      ringStart = (ringStart + overflow) % tailLimit;
      ringSize -= overflow;
      omitted += overflow;
    }
    const writeAt = (ringStart + ringSize) % tailLimit;
    const firstPart = Math.min(bytes.byteLength, tailLimit - writeAt);
    ring.set(bytes.subarray(0, firstPart), writeAt);
    ring.set(bytes.subarray(firstPart), 0);
    ringSize += bytes.byteLength;
  };

  const reader = stream.getReader();
  const release = cancelOnAbort(reader, signal);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      if (headSize < headLimit) {
        const take = Math.min(headLimit - headSize, value.byteLength);
        head.set(value.subarray(0, take), headSize);
        headSize += take;
        offset = take;
      }
      if (offset < value.byteLength) pushTail(value.subarray(offset));
    }
  } finally {
    release();
  }

  const tail = new Uint8Array(ringSize);
  const firstPart = Math.min(ringSize, tailLimit - ringStart);
  tail.set(ring.subarray(ringStart, ringStart + firstPart), 0);
  tail.set(ring.subarray(0, ringSize - firstPart), firstPart);
  const decoder = new TextDecoder();
  if (omitted === 0) {
    const whole = new Uint8Array(headSize + ringSize);
    whole.set(head.subarray(0, headSize), 0);
    whole.set(tail, headSize);
    return { text: decoder.decode(whole), omittedBytes: 0 };
  }
  return {
    text: `${decoder.decode(head.subarray(0, headSize))}${omittedMarker(omitted)}${decoder.decode(tail)}`,
    omittedBytes: omitted,
  };
}

/** `readStreamCappedDetail`と同じ読み方で、文字列だけを返す。 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return (await readStreamCappedDetail(stream, maxBytes, signal)).text;
}
