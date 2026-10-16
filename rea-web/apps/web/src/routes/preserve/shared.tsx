import type { ReactNode } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { ErrorNotice } from "../../components/ErrorNotice";
import { formatTimestamp, shortId } from "../../lib/format";
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

export interface RunRow {
  readonly id: string;
  readonly to: string;
  readonly label: string;
  /** The status derived from the resource's job. */
  readonly status: string;
}

interface PagedQuery<T> {
  readonly data: InfiniteData<{ items: T[] }> | undefined;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  fetchNextPage(): unknown;
}

/** One page-by-page list of plans, captures, verifications or exports, newest first. */
export function RunList<T>({
  title,
  query,
  row,
  empty,
}: {
  title: string;
  query: PagedQuery<T>;
  row: (item: T) => RunRow;
  empty: string;
}) {
  const rows = (query.data?.pages ?? []).flatMap((page) => page.items.map(row));
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <ErrorNotice error={query.error} />
      {query.isPending && <p role="status">Loading…</p>}
      {!query.isPending && rows.length === 0 && (
        <p className="muted">{empty}</p>
      )}
      {rows.length > 0 && (
        <ul className="plain" data-testid={`list-${title.toLowerCase()}`}>
          {rows.map((item) => (
            <li key={item.id}>
              <Link to={item.to}>{item.label}</Link>{" "}
              <Badge value={item.status} />
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </section>
  );
}

/** Link text for a resource: its time when known, otherwise the start of its id. */
export const runLabel = (time: string | null, id: string): string =>
  time === null ? `${shortId(id)} (not started)` : formatTimestamp(time);
