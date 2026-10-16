/** Windowing for long lists: only the rows near the viewport are rendered. */

export interface VirtualWindow {
  /** First row to render. */
  readonly start: number;
  /** One past the last row to render. */
  readonly end: number;
  /** Height of the whole list in pixels. */
  readonly totalHeight: number;
}

export const virtualWindow = (options: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}): VirtualWindow => {
  const { rowHeight, count } = options;
  const overscan = options.overscan ?? 6;
  const totalHeight = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight: 0 };
  const top = Math.min(Math.max(0, options.scrollTop), totalHeight);
  const first = Math.floor(top / rowHeight);
  const visible =
    Math.ceil(Math.max(0, options.viewportHeight) / rowHeight) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
    totalHeight,
  };
};
