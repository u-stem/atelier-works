// テストの前にジョブの環境変数を外す。
// 環境にジョブIDがあると、一時ディレクトリを引く処理が実機の`/tmp/windmill`の下にディレクトリを作るため。
// ジョブIDが要るテストは、環境変数を引数や注入で渡す。
delete process.env.WM_JOB_ID;
delete process.env.WM_ROOT_FLOW_JOB_ID;
delete process.env.WM_WORKSPACE;
