-- Tool-call identity is (upstream_session_id, upstream_seq): the call index
-- inside one REA session. The investigation timeline seq is allocated by the
-- control plane, because one investigation can span several sessions (a
-- requeued run, a comparison anchored to it). Before this migration a second
-- session's calls collided on (investigation_id, seq) and were dropped.
ALTER TABLE tool_calls ADD COLUMN upstream_seq INTEGER;
UPDATE tool_calls SET upstream_seq = seq;
ALTER TABLE tool_calls ALTER COLUMN upstream_seq SET NOT NULL;
ALTER TABLE tool_calls
  ADD CONSTRAINT tool_calls_upstream_call_key UNIQUE (upstream_session_id, upstream_seq);
