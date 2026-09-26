-- down migration: issue_proposals
BEGIN;

DROP VIEW factory.v_issue_proposals;
DROP TABLE factory.issue_proposals;

END;
