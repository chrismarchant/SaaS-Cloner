import { useState } from "react";
import {
  TREE_PAGE_SIZE,
  childEntries,
  describeValue,
  isContainer,
} from "../lib/json";

/**
 * Collapsible JSON explorer. Children are only created when a node is opened
 * and large containers are paged, so a big result costs nothing until used.
 * Every value is rendered as text.
 */
export function JsonTree({
  value,
  label,
  defaultOpen = false,
}: {
  value: unknown;
  label?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(TREE_PAGE_SIZE);
  if (!isContainer(value))
    return (
      <li className="tree-leaf">
        {label !== undefined && <span className="tree-key">{label}: </span>}
        <span className="tree-value">{describeValue(value)}</span>
      </li>
    );
  const entries = open ? childEntries(value) : [];
  return (
    <li>
      <button
        type="button"
        className="tree-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>{" "}
        {label !== undefined && <span className="tree-key">{label}: </span>}
        <span className="muted">{describeValue(value)}</span>
      </button>
      {open && (
        <ul className="tree">
          {entries.slice(0, shown).map(([key, child]) => (
            <JsonTree key={key} label={key} value={child} />
          ))}
          {entries.length > shown && (
            <li>
              <button
                type="button"
                onClick={() => setShown(shown + TREE_PAGE_SIZE)}
              >
                Show more ({entries.length - shown} remaining)
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function JsonExplorer({
  value,
  label,
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <ul className="tree tree-root">
      <JsonTree
        value={value}
        {...(label === undefined ? {} : { label })}
        defaultOpen
      />
    </ul>
  );
}
