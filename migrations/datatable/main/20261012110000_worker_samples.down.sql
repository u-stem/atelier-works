-- down migration: worker_samples
-- workerの負荷の記録は失われる。Windmillのジョブ履歴から取り戻せるのは、枠の占有だけである。
BEGIN;

DROP TABLE factory.worker_samples;

END;
