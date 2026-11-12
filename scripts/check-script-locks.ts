#!/usr/bin/env bun
// `f/`の`.script.lock`の依存が、ルートのbun.lockと同じ版・同じintegrityであることを検査する(未実装)。

export type RootIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export type RootIndexResult =
  | { readonly ok: true; readonly index: RootIndex }
  | { readonly ok: false; readonly reason: string };

export type ScriptLockViolation = {
  readonly key: string;
  readonly reason: string;
};

export function indexRootLock(_text: string): RootIndexResult {
  return { ok: true, index: new Map() };
}

export function checkScriptLock(
  _text: string,
  _root: RootIndex,
): ScriptLockViolation[] {
  return [];
}
