import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  roleSatisfies,
  type Role,
  type projectSchema,
} from "@rea-web/contracts/browser";
import type { z } from "zod";
import { ErrorNotice } from "../components/ErrorNotice";
import { useCreateProject, useMe, useProjects } from "./hooks";

type Project = z.output<typeof projectSchema>;

export interface ProjectContext {
  readonly project: Project;
  readonly projects: readonly Project[];
  readonly role: Role | null;
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
  readonly select: (id: string) => void;
}

const Context = createContext<ProjectContext | null>(null);
const STORAGE_KEY = "rea-web.project";

const remembered = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const remember = (id: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Remembering the choice is a convenience only.
  }
};

export const useProject = (): ProjectContext => {
  const value = useContext(Context);
  if (value === null) throw new Error("useProject outside ProjectProvider");
  return value;
};

function CreateProject() {
  const create = useCreateProject();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  return (
    <main className="page narrow">
      <h1>No project yet</h1>
      <p>Your account is not a member of any project. Create one to begin.</p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ slug, name });
        }}
      >
        <label>
          Project slug
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </label>
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create project
        </button>
        <ErrorNotice error={create.error} />
      </form>
    </main>
  );
}

/** Resolves the working project from the `/projects` list. */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const projects = useProjects();
  const me = useMe();
  const memberships = me.data?.memberships;
  const [choice, setChoice] = useState<string | null>(remembered);
  const select = useCallback((id: string) => {
    remember(id);
    setChoice(id);
  }, []);
  const items = projects.data?.items;
  const value = useMemo<ProjectContext | null>(() => {
    if (items === undefined || items.length === 0) return null;
    const project = items.find((entry) => entry.id === choice) ?? items[0];
    if (project === undefined) return null;
    const role =
      project.role ??
      memberships?.find((entry) => entry.project_id === project.id)?.role ??
      null;
    return {
      project,
      projects: items,
      role,
      canWrite: role !== null && roleSatisfies(role, "member"),
      canAdmin: role !== null && roleSatisfies(role, "admin"),
      select,
    };
  }, [items, memberships, choice, select]);

  if (projects.isPending)
    return (
      <main className="page">
        <p role="status">Loading projects…</p>
      </main>
    );
  if (projects.isError)
    return (
      <main className="page">
        <ErrorNotice error={projects.error} />
      </main>
    );
  if (value === null) return <CreateProject />;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
