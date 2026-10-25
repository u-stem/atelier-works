// Windmillへ届いているかを、`runScript`の結果から画面全体で共有する。
// 届かなかった失敗(`isUnreachableError`)で帯を出し、次に応答を得たら消す。
// `runScript`を通らない取得(`status.json`)は、元にしない。Windmillに届かなくても成功を返すことがあるため。
// ブラウザの接続状態(navigator.onLine)は使わない。
// ConsoleはWindmillを同じ端末(127.0.0.1)で配信するので、他のネットワークが切れていても、Windmillには届く。

import { useSyncExternalStore } from "react";
import {
  type ApiError,
  isUnreachableError,
  type RunResult,
} from "../api/errors.ts";

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
 * 届かなかった失敗(ネットワークの失敗と、転送が返す502と503)だけが「届かない」にする。
 * 他の失敗(401、4xx、500、ジョブの失敗、待ちの上限)は、Windmillが答えたものなので、届いている。
 * 変わらないときは同じ参照を返す。
 */
export function reduceConnection(
  state: ConnectionState,
  event: ConnectionEvent,
): ConnectionState {
  const unreachable =
    event.type === "failed" && isUnreachableError(event.error);
  if (unreachable === state.unreachable) {
    return state;
  }
  return unreachable ? UNREACHABLE : INITIAL_CONNECTION_STATE;
}

export type ConnectionStore = {
  readonly getSnapshot: () => ConnectionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly report: (result: RunResult) => void;
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
    report: (result) => {
      dispatch(
        result.ok
          ? { type: "succeeded" }
          : { type: "failed", error: result.error },
      );
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
