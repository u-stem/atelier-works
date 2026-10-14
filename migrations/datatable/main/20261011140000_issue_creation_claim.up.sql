-- up migration: issue_creation_claim
--
-- Issue提案の承認で、Issueを作る処理が同時に2つ走らないようにする印を加える。
-- issue_proposal_applyは、Issueを作る直前に、この列を条件付きのUPDATEで書き込んで印を取る。
-- 印を取れた1つだけがIssueを作り、取れなかった呼び出しは何もせずに終わる。
-- GitHubの検索は索引の反映が遅れるので、マーカーでの検索だけでは、同時の呼び出しの重複を防げない。
--
-- 印は期限付きで、期限を過ぎた印は取り直せる。処理が途中で止まっても、やり直しを塞がない。
-- Issueを作り終えた(created_issue_numberが入った)行は、印を取れない。
BEGIN;

ALTER TABLE factory.issue_proposals ADD COLUMN issue_creation_claimed_at timestamptz;

COMMENT ON COLUMN factory.issue_proposals.issue_creation_claimed_at IS
    'Issueを作る処理が印を取った時刻。印は期限付きで、期限後は取り直せる。印を取っていない行や、印を手放した行ではNULL。';

END;
