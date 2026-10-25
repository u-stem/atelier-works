import { useSyncExternalStore } from "react";
import type { ApiError } from "../api/errors.ts";

export type ConnectionState = { readonly unreachable: boolean };

export type ConnectionEvent =
  | { readonly type: "failed"; readonly error: ApiError }
  | { readonly type: "succeeded" };

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  unreachable: false,
};

export function reduceConnection(
  state: ConnectionState,
  _event: ConnectionEvent,
): ConnectionState {
  return state;
}

export type ConnectionStore = {
  readonly getSnapshot: () => ConnectionState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportError: (error: unknown) => void;
  readonly reportSuccess: () => void;
};

export function createConnectionStore(): ConnectionStore {
  const state = INITIAL_CONNECTION_STATE;
  return {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    reportError: () => undefined,
    reportSuccess: () => undefined,
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
