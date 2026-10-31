// 設計工程を開ける門。実装は後のコミットで書く。

export type DesignGate = {
  readonly enabled: boolean;
  readonly ignored: boolean;
};

export function readDesignSince(_since: unknown): Date | null {
  return null;
}

export function resolveDesignGate(
  _requested: boolean,
  _since: unknown,
): DesignGate {
  return { enabled: false, ignored: false };
}
