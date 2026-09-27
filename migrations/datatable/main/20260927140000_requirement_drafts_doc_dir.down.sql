-- down migration: requirement_drafts.doc_dir
BEGIN;

COMMENT ON COLUMN factory.cleanup_runs.doc_dirs_deleted IS
    'Requirement-definition directories deleted. Always 0 for now -- that sweep is added in a follow-up PR.';

ALTER TABLE factory.requirement_drafts DROP COLUMN doc_dir;

END;
