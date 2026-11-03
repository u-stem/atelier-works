// 隔離の合格の証拠の型。
// 保護パスに置く。証拠を偽造できると、測定に合格していないのに調査のClaudeを起動できるため。
//
// 証拠は、このモジュールの`mintIsolationProof`が作ったものだけを受け付ける。
// 作れるのは関門だけで、参照元は保護されたテストが走査で固定する。
// 証拠は同じプロセスの中でだけ有効で、JSONを通した物やflowの段をまたいだ物は受け付けない。

/** 証拠が本物でない。 */
export class IsolationProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationProofError";
  }
}

/**
 * 型としてだけ公開し、値としては公開しない。外のモジュールが`new`で作れず、
 * `#brand`を持つので、形が同じだけの物は型の上でも代入できない。
 */
class IsolationProof {
  readonly #brand = true;

  /** `new`で作った物が`#brand`を持つかを調べる。登録済みかは`assertIsolationProof`が別に調べる。 */
  static hasBrand(value: object): value is IsolationProof {
    return #brand in value;
  }
}

export type { IsolationProof };

/**
 * `mintIsolationProof`が作った証拠の集合。登録は`mintIsolationProof`の中だけで行う。
 * `new`で作った物や`Reflect.construct`で作った物は、ここに入らないので受け付けない。
 */
const minted = new WeakSet<object>();

/** 証拠を作る。呼べるのは、測定に合格したと判定した関門だけである。 */
export function mintIsolationProof(): IsolationProof {
  const proof = new IsolationProof();
  minted.add(proof);
  return proof;
}

/** 値が`mintIsolationProof`の作った証拠でなければ、例外を投げる。 */
export function assertIsolationProof(
  value: unknown,
): asserts value is IsolationProof {
  if (
    typeof value !== "object" ||
    value === null ||
    !IsolationProof.hasBrand(value) ||
    !minted.has(value)
  ) {
    throw new IsolationProofError(
      "the isolation proof is missing or was not made by the gate",
    );
  }
}
