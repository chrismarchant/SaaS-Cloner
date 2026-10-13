-- The runner that most recently leased a job. Leases are deleted when a job
-- completes, but follow-ups must be routed to the runner that holds the
-- investigation's REA session after its run job has succeeded. Set
-- atomically by the claim; never cleared by completion.
ALTER TABLE jobs ADD COLUMN last_runner_id UUID REFERENCES runners(id) ON DELETE SET NULL;
UPDATE jobs SET last_runner_id = l.runner_id FROM job_leases l WHERE l.job_id = jobs.id;
