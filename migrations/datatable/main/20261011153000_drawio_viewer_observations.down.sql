-- down migration: drawio_viewer_observations
-- 観測の記録は失われる。次の週から、14日の待ちを数え直す。
BEGIN;

DROP TABLE factory.drawio_viewer_observations;

END;
