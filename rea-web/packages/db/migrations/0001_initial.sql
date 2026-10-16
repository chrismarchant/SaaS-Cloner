-- rea-web initial schema (G01). Owner: architecture lead. Append-only: later
-- changes are new numbered migration files, never edits to applied ones.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','member','admin','owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE runners (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'never_connected'
    CHECK (status IN ('never_connected','online','stale','offline','revoked')),
  capability_report JSONB,
  capability_digest JSONB,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runners_project_idx ON runners(project_id);

CREATE TABLE targets (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('upload','url','runtime_capture','runner_local')),
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  sha256 TEXT,
  size BIGINT,
  url TEXT,
  object_key TEXT,
  runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,
  runner_path_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX targets_project_idx ON targets(project_id, created_at DESC);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued','preparing','running','awaiting_approval','succeeded','failed','cancelled','interrupted')),
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget JSONB NOT NULL,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  failure JSONB,
  preferred_runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  cancel_requested_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_project_state_idx ON jobs(project_id, state, created_at);
CREATE INDEX jobs_queued_idx ON jobs(created_at) WHERE state = 'queued';

CREATE TABLE job_leases (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  runner_id UUID NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  fencing_token BIGINT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX job_leases_expiry_idx ON job_leases(expires_at);
CREATE INDEX job_leases_runner_idx ON job_leases(runner_id);

-- Monotonic fencing counter per job, survives lease deletion.
CREATE TABLE job_fencing (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_token BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE job_events (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE effect_ledger (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, step_key)
);

CREATE TABLE job_approvals (
  approval_id TEXT PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  arguments JSONB NOT NULL,
  effects JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT CHECK (decision IN ('approved','rejected')),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX job_approvals_job_idx ON job_approvals(job_id);

CREATE TABLE idempotency_records (
  principal_id UUID NOT NULL,
  project_id UUID,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX idempotency_created_idx ON idempotency_records(created_at);

CREATE TABLE investigations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES targets(id),
  question TEXT NOT NULL,
  policy JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','cancelled')),
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  routing JSONB,
  upstream_identity JSONB,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investigations_project_idx ON investigations(project_id, created_at DESC);

CREATE TABLE tool_calls (
  id UUID PRIMARY KEY,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  upstream_session_id TEXT NOT NULL,
  arguments_object_key TEXT,
  raw_result_object_key TEXT NOT NULL,
  raw_result_sha256 TEXT NOT NULL,
  raw_result_bytes BIGINT NOT NULL,
  derived JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_id TEXT,
  effects JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_error BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  UNIQUE (investigation_id, seq)
);
CREATE INDEX tool_calls_evidence_idx ON tool_calls(investigation_id, evidence_id);

CREATE TABLE evidence_artifacts (
  id UUID PRIMARY KEY,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bundle','raw_result','export','ledger','findings')),
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_artifacts_inv_idx ON evidence_artifacts(investigation_id);

CREATE TABLE findings (
  id UUID PRIMARY KEY,
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  class TEXT NOT NULL CHECK (class IN ('fact','inference','proposal','unknown')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_call_seqs JSONB NOT NULL DEFAULT '[]'::jsonb,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('upstream','routing','model','policy')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX findings_inv_idx ON findings(investigation_id, class);

CREATE TABLE builds (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source JSONB NOT NULL,
  components JSONB NOT NULL,
  preferred_runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX builds_project_idx ON builds(project_id);

CREATE TABLE preservation_plans (
  id UUID PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id),
  runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,
  plan JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE captures (
  id UUID PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES preservation_plans(id),
  job_id UUID NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','cancelled')),
  manifest_object_key TEXT,
  manifest_sha256 TEXT,
  consistency TEXT CHECK (consistency IN ('single_point','inconsistent','unknown')),
  component_statuses JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE verifications (
  id UUID PRIMARY KEY,
  capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id),
  scope JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  network_required JSONB,
  overall TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exports (
  id UUID PRIMARY KEY,
  capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  object_key TEXT,
  sha256 TEXT,
  size BIGINT,
  signature JSONB,
  encryption JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('0001_initial') ON CONFLICT DO NOTHING;
