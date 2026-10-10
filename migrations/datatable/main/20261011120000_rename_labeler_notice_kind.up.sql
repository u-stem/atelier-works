-- up migration: rename_labeler_notice_kind
--
-- ラベル付与者の確認で見送った通知の種類名を、labeler_association_deniedからlabeler_deniedに改める。
-- 未解決の通知だけを書き換える。本文は<owner>/<repo>#<番号>: で始まるため、
-- 書き換えた後は、接頭辞による解決(poll_issues)が既存の通知にも効く。
-- 解決済みの通知は履歴なので、種類名を変えない。
BEGIN;

UPDATE factory.notices
SET kind = 'labeler_denied'
WHERE kind = 'labeler_association_denied'
  AND resolved = false;

END;
