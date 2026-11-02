// 隔離の合格の証拠の型。
// 保護パスに置く。証拠を偽造できると、測定に合格していないのに調査のClaudeを起動できるため。

/** 証拠が本物でない。 */
export class IsolationProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationProofError";
  }
}

class IsolationProof {
  readonly #brand = "isolation-proof";

  get brand(): string {
    return this.#brand;
  }
}

export type { IsolationProof };

export function mintIsolationProof(): IsolationProof {
  return new IsolationProof();
}

export function assertIsolationProof(
  _value: unknown,
): asserts _value is IsolationProof {}
