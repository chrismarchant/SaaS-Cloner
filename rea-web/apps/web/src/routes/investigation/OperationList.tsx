import type { Job } from "@rea-web/contracts/browser";
import { Badge } from "../../components/Badge";
import { formatTimestamp } from "../../lib/format";

/** Earlier jobs of one kind, selectable to reopen their live panel. */
export function OperationList({
  title,
  jobs,
  selected,
  onSelect,
  describe,
}: {
  title: string;
  jobs: readonly Job[];
  selected: string | null;
  onSelect: (id: string) => void;
  describe: (job: Job) => string;
}) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <ul className="plain">
        {jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              aria-pressed={selected === job.id}
              onClick={() => onSelect(job.id)}
            >
              {formatTimestamp(job.created_at)}: {describe(job)}
            </button>{" "}
            <Badge value={job.state} />
          </li>
        ))}
      </ul>
    </section>
  );
}
