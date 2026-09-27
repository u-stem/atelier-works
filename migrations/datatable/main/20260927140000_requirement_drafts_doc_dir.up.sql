-- up migration: requirement_drafts.doc_dir
--
-- File-per-diagram requirements-doc redesign (2026-09-27): headless Claude
-- now writes requirements.md and any <name>.drawio diagrams directly into a
-- per-attempt worker-local directory (see
-- f/factory/lib/requirements_template.ts's buildRequirementsDocDir) instead
-- of returning them as JSON structured output. This column records that
-- directory so a later reader (or cleanup_db.ts) can find the files again.
-- requirement_drafts.diagrams keeps its jsonb shape but now holds
-- {name, file} per diagram (see requirement_drafts.diagrams.schema.json).
-- Rows written before this redesign hold the old {name, drawio_xml} shape
-- and no doc_dir; their XML was only ever consumed by the (now removed)
-- Issue-comment / viewer-URL path, so they are reset to '[]' here rather
-- than carried forward in a shape the new parser does not accept.
--
-- Neither factory.v_inbox nor factory.v_approval_requests enumerates
-- requirement_drafts via `rd.*` (both list its columns explicitly), so
-- neither view needs to change to pick up this new column.
BEGIN;

ALTER TABLE factory.requirement_drafts ADD COLUMN doc_dir text;

UPDATE factory.requirement_drafts
SET diagrams = '[]'::jsonb
WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(diagrams) AS d
    WHERE d ? 'drawio_xml' OR NOT (d ? 'file')
);

COMMENT ON COLUMN factory.requirement_drafts.doc_dir IS
    'Worker-local directory holding this attempt''s requirements.md and any diagram files (see f/factory/lib/requirements_template.ts''s buildRequirementsDocDir). NULL for a row generated before this column existed.';

COMMENT ON COLUMN factory.cleanup_runs.doc_dirs_deleted IS
    'Requirement-definition doc dirs (see requirement_drafts.doc_dir) deleted alongside their work item.';

END;
