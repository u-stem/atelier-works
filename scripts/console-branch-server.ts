// スタブ。実装は次のコミットで書く。

export type Route =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "reject" }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly fallback: "index" | "not-found";
    }
  | { readonly kind: "proxy" };

export type Config = {
  readonly dist: string;
  readonly port: number;
  readonly upstream: string;
};

export type ParsedArgs =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly message: string };

export function routeFor(_pathname: string): Route {
  return { kind: "proxy" };
}

export function parseArgs(_argv: readonly string[]): ParsedArgs {
  return { ok: false, message: "" };
}

export function toUpstreamRequestHeaders(
  _headers: Headers,
  _upstream: string,
): Headers {
  return new Headers();
}

export function toClientResponseHeaders(
  _headers: Headers,
  _upstream: string,
): Headers {
  return new Headers();
}

export function startServer(_config: Config): { port: number; stop(): void } {
  return { port: 0, stop() {} };
}
