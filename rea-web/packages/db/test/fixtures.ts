import { DEFAULT_JOB_BUDGET } from "@rea-web/contracts";
import type { CreateJobInput, Repositories } from "../src/index.js";

let counter = 0;
const unique = (): string => `${Date.now().toString(36)}${(counter += 1)}`;

export async function seedProject(repos: Repositories) {
  const user = await repos.users.create({
    email: `user-${unique()}@example.test`,
    password_hash: "scrypt$test",
    display_name: "Test User",
  });
  const project = await repos.projects.create({
    slug: `proj-${unique()}`,
    name: "Project",
    created_by: user.id,
  });
  return { user, project };
}

export async function seedRunner(
  repos: Repositories,
  project_id: string,
  created_by?: string,
) {
  return repos.runners.create({
    project_id,
    name: `runner-${unique()}`,
    token_hash: `hash-${unique()}`,
    labels: ["linux"],
    created_by: created_by ?? null,
  });
}

export const jobInput = (
  project_id: string,
  overrides: Partial<CreateJobInput> = {},
): CreateJobInput => ({
  project_id,
  kind: "investigation.run",
  budget: DEFAULT_JOB_BUDGET,
  ...overrides,
});
