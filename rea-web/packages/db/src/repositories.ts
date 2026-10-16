import type { Database } from "./database.js";
import {
  type ApiTokensRepository,
  type MembershipsRepository,
  type ProjectsRepository,
  type SessionsRepository,
  type UsersRepository,
  apiTokensRepository,
  membershipsRepository,
  projectsRepository,
  sessionsRepository,
  usersRepository,
} from "./repos/identity.js";
import {
  type RunnersRepository,
  type TargetsRepository,
  runnersRepository,
  targetsRepository,
} from "./repos/fleet.js";
import {
  type JobEventsRepository,
  jobEventsRepository,
} from "./repos/jobEvents.js";
import { type JobsRepository, jobsRepository } from "./repos/jobs.js";
import {
  type ApprovalsRepository,
  type EffectLedgerRepository,
  type IdempotencyRepository,
  approvalsRepository,
  effectLedgerRepository,
  idempotencyRepository,
} from "./repos/jobSupport.js";
import {
  type EvidenceArtifactsRepository,
  type FindingsRepository,
  type InvestigationsRepository,
  type ToolCallsRepository,
  evidenceArtifactsRepository,
  findingsRepository,
  investigationsRepository,
  toolCallsRepository,
} from "./repos/investigations.js";
import {
  type BuildsRepository,
  type CapturesRepository,
  type ExportsRepository,
  type PlansRepository,
  type VerificationsRepository,
  buildsRepository,
  capturesRepository,
  exportsRepository,
  plansRepository,
  verificationsRepository,
} from "./repos/preservation.js";

export interface Repositories {
  users: UsersRepository;
  sessions: SessionsRepository;
  apiTokens: ApiTokensRepository;
  projects: ProjectsRepository;
  memberships: MembershipsRepository;
  runners: RunnersRepository;
  targets: TargetsRepository;
  jobs: JobsRepository;
  jobEvents: JobEventsRepository;
  effectLedger: EffectLedgerRepository;
  approvals: ApprovalsRepository;
  idempotency: IdempotencyRepository;
  investigations: InvestigationsRepository;
  toolCalls: ToolCallsRepository;
  evidenceArtifacts: EvidenceArtifactsRepository;
  findings: FindingsRepository;
  builds: BuildsRepository;
  plans: PlansRepository;
  captures: CapturesRepository;
  verifications: VerificationsRepository;
  exports: ExportsRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    users: usersRepository(db),
    sessions: sessionsRepository(db),
    apiTokens: apiTokensRepository(db),
    projects: projectsRepository(db),
    memberships: membershipsRepository(db),
    runners: runnersRepository(db),
    targets: targetsRepository(db),
    jobs: jobsRepository(db),
    jobEvents: jobEventsRepository(db),
    effectLedger: effectLedgerRepository(db),
    approvals: approvalsRepository(db),
    idempotency: idempotencyRepository(db),
    investigations: investigationsRepository(db),
    toolCalls: toolCallsRepository(db),
    evidenceArtifacts: evidenceArtifactsRepository(db),
    findings: findingsRepository(db),
    builds: buildsRepository(db),
    plans: plansRepository(db),
    captures: capturesRepository(db),
    verifications: verificationsRepository(db),
    exports: exportsRepository(db),
  };
}
