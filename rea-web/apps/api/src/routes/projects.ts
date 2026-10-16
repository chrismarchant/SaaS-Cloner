import { ApiError } from "@rea-web/contracts";
import { membershipView, projectView, userView } from "./mappers.js";
import type { HandlersFor } from "./types.js";

export const projectHandlers = (): HandlersFor<
  | "listProjects"
  | "createProject"
  | "getProject"
  | "upsertMember"
  | "listMembers"
> => ({
  async listProjects({ ctx, user }) {
    const projects = await ctx.repos.projects.listForUser(user.user.id);
    return { items: projects.map(projectView) };
  },

  async createProject({ ctx, user, body }) {
    const project = await ctx.repos.projects.create({
      slug: body.slug,
      name: body.name,
      created_by: user.user.id,
    });
    return projectView({ ...project, role: "owner" });
  },

  async getProject({ ctx, params, project }) {
    const record = await ctx.repos.projects.findById(params.p);
    if (record === null || project === null)
      throw new ApiError("not_found", "Project not found");
    return projectView({ ...record, role: project.role });
  },

  async upsertMember({ ctx, params, body, project }) {
    const record = await ctx.repos.projects.findById(params.p);
    if (record === null || project === null)
      throw new ApiError("not_found", "Project not found");
    const target = await ctx.repos.users.findByEmail(
      body.email.trim().toLowerCase(),
    );
    if (target === null) throw new ApiError("not_found", "User not found");
    const existing = await ctx.repos.memberships.roleFor(params.p, target.id);
    const touchesOwner = body.role === "owner" || existing === "owner";
    if (touchesOwner && project.role !== "owner")
      throw new ApiError("forbidden", "Only an owner can change owner roles");
    if (existing === "owner" && body.role !== "owner") {
      const members = await ctx.repos.memberships.list(params.p);
      if (members.filter((m) => m.role === "owner").length <= 1)
        throw new ApiError(
          "conflict",
          "A project must keep at least one owner",
        );
    }
    await ctx.repos.memberships.upsert({
      project_id: params.p,
      user_id: target.id,
      role: body.role,
    });
    return membershipView({ ...record, role: body.role });
  },

  async listMembers({ ctx, params }) {
    const members = await ctx.repos.memberships.list(params.p);
    const items = [];
    for (const member of members) {
      const user = await ctx.repos.users.findById(member.user_id);
      if (user !== null)
        items.push({ user: userView(user), role: member.role });
    }
    return { items };
  },
});
