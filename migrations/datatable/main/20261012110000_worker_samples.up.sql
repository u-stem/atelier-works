-- up migration: worker_samples
--
-- defaultのworkerの枠の占有、queueの待ち、コンテナのメモリを、2分ごとに1行ずつ記録する。
-- 作業項目とは独立した読み取り専用の記録で、作業項目の状態、終端、リードタイムには影響しない。
-- 外部キーは持たない。掃除は自身のsampled_atで行う。
--
-- NULLは「読めなかった」を表す。0は「読めて、0だった」を表す。
-- 行を残すことを優先し、読めない値があってもほかの値は記録する。
BEGIN;

CREATE TABLE factory.worker_samples (
    id bigserial PRIMARY KEY,
    sampled_at timestamptz NOT NULL DEFAULT now(),
    scheduled_for timestamptz,
    slots smallint NOT NULL,
    running_jobs smallint,
    running_by_script jsonb,
    waiting_jobs integer,
    max_wait_seconds integer,
    lag_seconds integer,
    mem_current_bytes bigint,
    mem_anon_bytes bigint,
    mem_working_set_bytes bigint,
    mem_peak_bytes bigint,
    mem_limit_bytes bigint,
    mem_events_max bigint,
    mem_oom bigint,
    mem_oom_kill bigint,
    mem_pressure_total_us bigint,
    CONSTRAINT worker_samples_slots_check CHECK (slots > 0),
    CONSTRAINT worker_samples_running_jobs_check CHECK (running_jobs >= 0),
    CONSTRAINT worker_samples_running_by_script_check
        CHECK (jsonb_typeof(running_by_script) = 'object'),
    CONSTRAINT worker_samples_waiting_jobs_check CHECK (waiting_jobs >= 0),
    CONSTRAINT worker_samples_max_wait_seconds_check CHECK (max_wait_seconds >= 0),
    CONSTRAINT worker_samples_lag_seconds_check CHECK (lag_seconds >= 0),
    CONSTRAINT worker_samples_mem_current_bytes_check CHECK (mem_current_bytes >= 0),
    CONSTRAINT worker_samples_mem_anon_bytes_check CHECK (mem_anon_bytes >= 0),
    CONSTRAINT worker_samples_mem_working_set_bytes_check CHECK (mem_working_set_bytes >= 0),
    CONSTRAINT worker_samples_mem_peak_bytes_check CHECK (mem_peak_bytes >= 0),
    CONSTRAINT worker_samples_mem_limit_bytes_check CHECK (mem_limit_bytes >= 0),
    CONSTRAINT worker_samples_mem_events_max_check CHECK (mem_events_max >= 0),
    CONSTRAINT worker_samples_mem_oom_check CHECK (mem_oom >= 0),
    CONSTRAINT worker_samples_mem_oom_kill_check CHECK (mem_oom_kill >= 0),
    CONSTRAINT worker_samples_mem_pressure_total_us_check CHECK (mem_pressure_total_us >= 0)
);

COMMENT ON TABLE factory.worker_samples IS
    'defaultのworkerの負荷の2分ごとの記録。枠の占有、queueの待ち、コンテナのcgroupのメモリを並べる。読み取り専用の記録で、作業項目には影響しない。';
COMMENT ON COLUMN factory.worker_samples.sampled_at IS
    '値を読み始めた時刻。記録するscriptが明示して渡すので、挿入のジョブが遅れても、測った時刻が残る。';
COMMENT ON COLUMN factory.worker_samples.scheduled_for IS
    '記録したジョブの予定時刻。行の間隔が予定より開いていれば、その間の予定が実行されなかったことを示す。ジョブの情報を読めなければNULL。';
COMMENT ON COLUMN factory.worker_samples.slots IS
    '枠の数。記録するscriptのコードの定数(DEFAULT_WORKER_SLOTS)で、workerから読んだ値ではない。NUM_WORKERSを変えた直後は、mise run upでworkerを作り直すまで、実際の枠の数と食い違う。';
COMMENT ON COLUMN factory.worker_samples.running_jobs IS
    '実行中のジョブの数。記録するジョブ自身、フローの親ジョブ、defaultのworkerが受けないtag(console、nativeのworkerのtag)のジョブは数えない。記録のジョブは枠が空いたときにしか動かないので、枠がすべて埋まった状態は行に残らない。占有はrunning_jobs / slotsで読み、枠が空いていた瞬間の標本である。塞がりはlag_secondsとscheduled_forの欠けで判定する。';
COMMENT ON COLUMN factory.worker_samples.running_by_script IS
    '実行中のジョブのscriptごとの件数。上限の件数を超えた分は、キー(other)にまとめる。';
COMMENT ON COLUMN factory.worker_samples.waiting_jobs IS
    '予定時刻を過ぎても開始していないジョブの数。1回の取得は100件までなので、100で頭打ちになる。';
COMMENT ON COLUMN factory.worker_samples.max_wait_seconds IS
    '待っているジョブのうち、予定時刻から最も長く待っているものの待ち時間。待つジョブが無ければ0。記録するジョブは自分の遅れの分だけ待った後に始まるので、待ちの深さの下限である。';
COMMENT ON COLUMN factory.worker_samples.lag_seconds IS
    '記録したジョブの予定時刻から開始までの遅れ。';
COMMENT ON COLUMN factory.worker_samples.mem_current_bytes IS
    'memory.current。ページキャッシュを含むので、上限に近くても逼迫とは限らない。';
COMMENT ON COLUMN factory.worker_samples.mem_anon_bytes IS
    'memory.statのanon。プロセスが確保したメモリで、回収できない分を見るのに使う。';
COMMENT ON COLUMN factory.worker_samples.mem_working_set_bytes IS
    'memory.currentからmemory.statのinactive_fileを引いた値。';
COMMENT ON COLUMN factory.worker_samples.mem_peak_bytes IS
    'memory.peak。コンテナの起動からの累積で、キャッシュを含む。前の行から増えたかどうかを見る印にだけ使う。';
COMMENT ON COLUMN factory.worker_samples.mem_limit_bytes IS
    'memory.max。上限が無ければNULL。読めなかった場合もNULLで、上限なしと区別できない。';
COMMENT ON COLUMN factory.worker_samples.mem_events_max IS
    'memory.eventsのmax。上限に達した回数の、コンテナの起動からの累積。';
COMMENT ON COLUMN factory.worker_samples.mem_oom IS
    'memory.eventsのoom。コンテナの起動からの累積。';
COMMENT ON COLUMN factory.worker_samples.mem_oom_kill IS
    'memory.eventsのoom_kill。OOMで止められたプロセスの数の、コンテナの起動からの累積。';
COMMENT ON COLUMN factory.worker_samples.mem_pressure_total_us IS
    'memory.pressureのsomeのtotal(マイクロ秒)の累積。読めない環境ではNULL。';

-- 直近の行の取得と、期間での集計と掃除を引く。
CREATE INDEX worker_samples_sampled_at_idx ON factory.worker_samples (sampled_at);

END;
