import { Link } from "react-router-dom";
import { flatten } from "../../api/hooks";
import { useBuilds } from "../../api/preserveHooks";
import { useProject } from "../../api/project";
import { ErrorNotice } from "../../components/ErrorNotice";
import { formatTimestamp, plural } from "../../lib/format";

export function BuildsPage() {
  const { project, canWrite } = useProject();
  const builds = useBuilds(project.id);
  const items = flatten(builds.data);
  return (
    <>
      <div className="row between">
        <h1>Preserve &amp; restore</h1>
        {canWrite && (
          <Link to="/preserve/new" className="button">
            New build
          </Link>
        )}
      </div>
      <p>
        A build declares what to preserve: its source, data, assets and the
        rest. Plan it, capture it into a recovery package, verify that the
        package restores, and export it.
      </p>
      <ErrorNotice error={builds.error} />
      {builds.isPending && <p role="status">Loading builds…</p>}
      {builds.data !== undefined && items.length === 0 && (
        <p>No build has been declared in this project.</p>
      )}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Build</th>
                <th scope="col">Source</th>
                <th scope="col">Components</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((build) => (
                <tr key={build.id} data-testid="build-row">
                  <th scope="row">
                    <Link to={`/preserve/builds/${build.id}`}>
                      {build.name}
                    </Link>
                  </th>
                  <td>
                    {build.source.kind === "git"
                      ? `git ${build.source.url}`
                      : "directory on a runner"}
                  </td>
                  <td>
                    {plural(build.components.length, "component")}:{" "}
                    {build.components
                      .map((component) => `${component.kind}:${component.id}`)
                      .join(", ")}
                  </td>
                  <td>{formatTimestamp(build.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {builds.hasNextPage && (
        <button
          type="button"
          disabled={builds.isFetchingNextPage}
          onClick={() => void builds.fetchNextPage()}
        >
          Load more builds
        </button>
      )}
    </>
  );
}
