/**
 * 実行役が持つロックの、書き込み側から見た形。
 * 状態ファイルの書き込みは、書く直前に`assertHeld`を呼び、ロックを持っていなければ書かずに止まる。
 * ロックの実装(奪取、生存の判定)はこの型の外にある。
 *
 * 構造的な型にすると、どのモジュールも`{ assertHeld: () => {} }`でフェンスを素通りできる。
 * そのため、非公開の欄を持つクラスにして、型の上で偽物を作れないようにする。
 * 作る箇所は、ロックの実装とテストに限る。契約テストで固定する。
 */
export class HeldLock {
  readonly #assertHeld: () => void;

  constructor(assertHeld: () => void) {
    this.#assertHeld = assertHeld;
  }

  /** ロックを今も持っていなければ例外を投げる。 */
  assertHeld(): void {
    this.#assertHeld();
  }
}
