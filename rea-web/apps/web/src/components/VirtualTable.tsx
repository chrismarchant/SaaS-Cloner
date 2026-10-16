import { useState, type ReactNode } from "react";
import { virtualWindow } from "../lib/virtual";

/**
 * A table of fixed-height rows of which only the rows near the viewport exist
 * in the page, so a package with tens of thousands of files costs the same as
 * one with ten. The scroll area is keyboard focusable. Cells are plain text
 * supplied by the caller.
 */
export function VirtualTable<T>({
  label,
  columns,
  headers,
  items,
  cells,
  rowKey,
  rowHeight = 34,
  viewportHeight = 340,
  testId,
}: {
  label: string;
  /** CSS grid template for the columns. */
  columns: string;
  headers: readonly string[];
  items: readonly T[];
  cells: (item: T) => readonly ReactNode[];
  rowKey: (item: T, index: number) => string;
  rowHeight?: number;
  viewportHeight?: number;
  testId?: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const window_ = virtualWindow({
    scrollTop,
    viewportHeight,
    rowHeight,
    count: items.length,
  });
  const rows = items.slice(window_.start, window_.end);
  return (
    <div
      role="table"
      aria-label={label}
      aria-rowcount={items.length + 1}
      className="vtable"
      data-testid={testId}
    >
      <div
        role="row"
        className="vtable-row vtable-head"
        style={{ gridTemplateColumns: columns }}
      >
        {headers.map((header) => (
          <div role="columnheader" key={header}>
            {header}
          </div>
        ))}
      </div>
      <div
        role="rowgroup"
        className="vtable-body"
        tabIndex={0}
        aria-label={`${label}, scrollable`}
        style={{
          height: Math.min(
            viewportHeight,
            Math.max(window_.totalHeight, rowHeight),
          ),
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: window_.totalHeight, position: "relative" }}>
          {rows.map((item, offset) => {
            const index = window_.start + offset;
            return (
              <div
                role="row"
                aria-rowindex={index + 2}
                key={rowKey(item, index)}
                className="vtable-row"
                data-testid={testId === undefined ? undefined : `${testId}-row`}
                style={{
                  gridTemplateColumns: columns,
                  position: "absolute",
                  top: index * rowHeight,
                  height: rowHeight,
                  left: 0,
                  right: 0,
                }}
              >
                {cells(item).map((cell, column) => (
                  <div role="cell" key={headers[column] ?? column}>
                    {cell}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
