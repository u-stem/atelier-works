/**
 * 実行役が起動する外部コマンドの絶対パス。
 * 名前で探すと、`PATH`の先にある偽物を起動しうるので、絶対パスで固定する。
 */

export const GIT_BIN = "/usr/bin/git";
export const PS_BIN = "/bin/ps";
export const SYSCTL_BIN = "/usr/sbin/sysctl";
