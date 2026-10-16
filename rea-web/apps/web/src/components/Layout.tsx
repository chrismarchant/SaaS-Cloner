import { NavLink, Outlet } from "react-router-dom";
import { SelectField } from "./SelectField";
import { useLogout, useMe } from "../api/hooks";
import { useProject } from "../api/project";

const NAV = [
  { to: "/investigations", label: "Investigations" },
  { to: "/targets", label: "Targets" },
  { to: "/runners", label: "Runners" },
  { to: "/preserve", label: "Preserve" },
  { to: "/compare", label: "Compare" },
] as const;

export function Layout() {
  const me = useMe();
  const logout = useLogout();
  const { project, projects, role, select } = useProject();
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <span className="brand">REA Web</span>
        <nav aria-label="Primary">
          <ul className="nav">
            {NAV.map((entry) => (
              <li key={entry.to}>
                <NavLink to={entry.to}>{entry.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="row account">
          {projects.length > 1 ? (
            <SelectField
              label="Project"
              hideLabel
              value={project.id}
              onChange={(event) => select(event.target.value)}
            >
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <span data-testid="project-name">{project.name}</span>
          )}
          <span className="muted">
            {role ?? "role unknown"}
            {me.data ? ` · ${me.data.user.email}` : ""}
          </span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Log out
          </button>
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
