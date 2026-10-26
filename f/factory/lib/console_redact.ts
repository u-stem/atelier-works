// Consoleに返すジョブのログと結果から、秘密値らしい部分を伏せる(スタブ)。

export const LOG_LIMIT_BYTES = 256 * 1024;
export const RESULT_LIMIT_BYTES = 64 * 1024;

export type Redacted = {
  readonly text: string;
  readonly truncated: boolean;
  readonly masked: boolean;
};

export type RedactedLog = Redacted & { readonly nonJsonLines: number };

export function redactText(_text: string): Redacted {
  return { text: "", truncated: false, masked: false };
}

export function redactLog(
  _raw: string,
  _limitBytes: number = LOG_LIMIT_BYTES,
): RedactedLog {
  return { text: "", truncated: false, masked: false, nonJsonLines: 0 };
}

export function redactResult(
  _value: unknown,
  _limitBytes: number = RESULT_LIMIT_BYTES,
): Redacted {
  return { text: "", truncated: false, masked: false };
}
