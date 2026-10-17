// factory_configのownersを、WindmillのAPIから読む。doctor.shが使う。
// スタブ。

export function ownersWithUnderscore(_config: unknown): string[] {
  return ["stub"];
}

export async function readFactoryOwnerNames(
  _baseUrl: string,
  _credentials: { email: string; password: string },
  _fetchFn: typeof fetch = fetch,
): Promise<string[] | null> {
  return null;
}
