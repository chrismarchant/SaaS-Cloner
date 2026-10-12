import { ApiError, type Role, roleSatisfies } from "@rea-web/contracts";
import type { AppContext } from "../context.js";

export interface ProjectAccess {
  readonly project_id: string;
  readonly role: Role;
}

/**
 * Membership gate for every project-scoped route. A non-member learns nothing
 * about the project's existence (`not_found`); a member lacking the role gets
 * `forbidden`.
 */
export const authorizeProject = async (
  ctx: AppContext,
  userId: string,
  projectId: string,
  required: Role,
): Promise<ProjectAccess> => {
  const role = await ctx.repos.memberships.roleFor(projectId, userId);
  if (role === null) throw new ApiError("not_found", "Project not found");
  if (!roleSatisfies(role, required))
    throw new ApiError("forbidden", "Insufficient role for this operation", {
      required,
      actual: role,
    });
  return { project_id: projectId, role };
};
