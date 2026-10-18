/**
 * 実行役が持つロックの、書き込み側から見た形。
 * 状態ファイルの書き込みは、書く直前に`assertHeld`を呼び、ロックを持っていなければ書かずに止まる。
 * ロックの実装(カーネルの助言ロックの取得、孤児の検査)はこの型の外にある。
 * 書く先の置き場のパスを`assertHeld`に渡し、ロックと違う置き場への書き込みを拒否できるようにする。
 *
 * 構造的な型にすると、どのモジュールも`{ assertHeld: () => {} }`でフェンスを素通りできる。
 * そのため、非公開の欄を持つクラスにして、型の上で偽物を作れないようにする。
 * 作る箇所は、ロックの実装とテストに限る。契約テストで固定する。
 */
export class HeldLock {
  readonly #assertHeld: (dir: string) => void;

  constructor(assertHeld: (dir: string) => void) {
    this.#assertHeld = assertHeld;
  }

  /** ロックを今も持っていない、または`dir`がロックの置き場と違えば例外を投げる。 */
  assertHeld(dir: string): void {
    this.#assertHeld(dir);
  }
}
