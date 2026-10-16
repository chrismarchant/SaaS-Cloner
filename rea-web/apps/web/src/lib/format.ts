export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
};

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
};

/** Local, readable rendering of an RFC 3339 timestamp; unparseable text is kept. */
export const formatTimestamp = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const shortId = (id: string): string => id.slice(0, 8);

/** Counted values with the plural chosen by count. */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** File name for a `download` attribute: no path or markup characters. */
export const safeFileName = (name: string, fallback: string): string => {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/\.{2,}/gu, ".")
    .replace(/^\.+/u, "");
  return cleaned === "" ? fallback : cleaned.slice(0, 120);
};
