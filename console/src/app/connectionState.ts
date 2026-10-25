// Windmillへ届いているかを、取得の結果から画面全体で共有する。
// ネットワークの失敗(応答が無い)で帯を出し、その後の取得が成功したら消す。
// ブラウザの接続状態(navigator.onLine)は使わない。
// ConsoleはWindmillを同じ端末(127.0.0.1)で配信するので、他のネットワークが切れていても、Windmillには届く。

import { useSyncExternalStore } from "react";
import { type ApiError, ApiFailure } from "../api/errors.ts";

export type ConnectionState = { readonly unreachable: boolean };

export type ConnectionEvent =
  | { readonly type: "failed"; readonly error: ApiError }
  | { readonly type: "succeeded" };

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  unreachable: false,
};

const UNREACHABLE: ConnectionState = { unreachable: true };

/**
 * 状態を次の状態にする純関数。
 * ネットワークの失敗だけが「届かない」にする。
 * 他の失敗(401、500、ジョブの失敗、待ちの上限)は、Windmillが答えたものなので、届いている。
 * 変わらないときは同じ参照を返す。
 */
export function reduceConnection(
  state: ConnectionState,
  event: ConnectionEvent,
): ConnectionState {
  const unreachable = event.type === "failed" && event.error.kind === "network";
  if (unreachable === state.unreachable) {
    return state;
  }
  return unreachable ? UNREACHABLE : INITIAL_CONNECTION_STATE;
}

export type ConnectionStore = {
  readonly getSnapshot: () => ConnectionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportError: (error: unknown) => void;
  readonly reportSuccess: () => void;
};

/** `reduceConnection`の状態を持ち、変わったときだけ購読者に知らせる。 */
export function createConnectionStore(): ConnectionStore {
  let state = INITIAL_CONNECTION_STATE;
  const listeners = new Set<() => void>();

  const dispatch = (event: ConnectionEvent): void => {
    const next = reduceConnection(state, event);
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
export const connectionStore = createConnectionStore();

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getSnapshot,
  );
}
