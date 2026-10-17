// ジョブごとの一時ディレクトリの保持期間。
// 何にも依存しないので、fsに触れないモジュールが期限だけを読める。
// `job_tmp.ts`が再エクスポートする。

/**
 * 掃除が消すまでの経過秒。ジョブの終了時の削除が走らなかったものだけが残る。
 * 取り消されたジョブや強制終了されたworkerが対象である。
 * 動いているジョブのものを消さないよう、`claude_timeout_sec`と`implement_timeout_sec`の既定値より十分長くする。
 * `config.ts`は、`claude_timeout_sec`と`implement_timeout_sec`がこの期限を超える設定を拒否する。
 */
export const JOB_TMP_MAX_AGE_SEC = 3 * 24 * 60 * 60;
