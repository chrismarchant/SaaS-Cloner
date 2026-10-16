import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Job } from "@rea-web/contracts/browser";
import { Badge } from "../../components/Badge";
import { formatTimestamp } from "../../lib/format";
import type { Row } from "../../lib/buildView";

export interface Crumb {
  readonly to?: string;
  readonly label: ReactNode;
}

export function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <p>
        {items.map((crumb, index) => (
          <span key={index}>
            {index > 0 && " / "}
            {crumb.to === undefined ? (
              crumb.label
            ) : (
              <Link to={crumb.to}>{crumb.label}</Link>
            )}
          </span>
        ))}
      </p>
    </nav>
  );
}

export function Facts({ rows }: { rows: readonly Row[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="facts">
      {rows.map((row) => (
        <div className="fact" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            {row.block === true ? (
              <pre className="code">{row.value}</pre>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Earlier jobs of one kind, each linking to the resource it produced. */
export function JobLinks({
  title,
  jobs,
  href,
  empty,
}: {
  title: string;
  jobs: readonly Job[];
  /** Link target for a job, or null when its resource id is not known. */
  href: (job: Job) => string | null;
  empty: string;
}) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {jobs.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="plain" data-testid={`list-${title.toLowerCase()}`}>
          {jobs.map((job) => {
            const target = href(job);
            return (
              <li key={job.id}>
                {target === null ? (
                  formatTimestamp(job.created_at)
                ) : (
                  <Link to={target}>{formatTimestamp(job.created_at)}</Link>
                )}{" "}
                <Badge value={job.state} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
