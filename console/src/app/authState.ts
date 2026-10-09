// ログインの状態を、APIの結果から画面全体で共有する。
// 401が返ったらバナーを出し、その後の取得が成功したら消す。
// 画面はすぐにはログインへ移さない。入力途中の内容を失わないため、移すのは操作者がバナーのボタンを押したときだけにする。

import { useSyncExternalStore } from "react";
import { type ApiError, ApiFailure } from "../api/errors.ts";

export type AuthState = { readonly unauthorized: boolean };

export type AuthEvent =
  | { readonly type: "failed"; readonly error: ApiError }
  | { readonly type: "succeeded" };

export const INITIAL_AUTH_STATE: AuthState = { unauthorized: false };

/**
 * 状態を次の状態にする純関数。401だけがバナーを出し、成功だけがバナーを消す。
 * 401以外の失敗ではバナーを消さない。通信が戻ったとは限らないため。
 * 変わらないときは同じ参照を返す。
 */
export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  if (event.type === "failed") {
    if (event.error.kind !== "unauthorized" || state.unauthorized) {
      return state;
    }
    return { unauthorized: true };
  }
  return state.unauthorized ? INITIAL_AUTH_STATE : state;
}

/** QueryClientに渡る任意のエラーが、401を示すものか。 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiFailure && error.apiError.kind === "unauthorized";
}

export type AuthStore = {
  readonly getSnapshot: () => AuthState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportError: (error: unknown) => void;
  readonly reportSuccess: () => void;
};

/** `reduceAuth`の状態を持ち、変わったときだけ購読者に知らせる。 */
export function createAuthStore(): AuthStore {
  let state = INITIAL_AUTH_STATE;
  const listeners = new Set<() => void>();

  const dispatch = (event: AuthEvent): void => {
    const next = reduceAuth(state, event);
    if (next === state) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportError: (error) => {
      if (error instanceof ApiFailure) {
        dispatch({ type: "failed", error: error.apiError });
      }
    },
    reportSuccess: () => {
      dispatch({ type: "succeeded" });
    },
  };
}

/** アプリ全体で1つのストア。 */
export const authStore = createAuthStore();

export function useAuthState(): AuthState {
  return useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
}
