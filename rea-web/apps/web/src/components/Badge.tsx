import type { ReactNode } from "react";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const TONES: Record<string, Tone> = {
  online: "ok",
  succeeded: "ok",
  completed: "ok",
  running: "info",
  preparing: "info",
  queued: "neutral",
  pending: "neutral",
  awaiting_approval: "warn",
  stale: "warn",
  interrupted: "warn",
  partial: "warn",
  offline: "bad",
  failed: "bad",
  revoked: "bad",
  cancelled: "neutral",
  never_connected: "neutral",
};

/** Status chip: the label is always text, tone is only decoration. */
export function Badge({
  value,
  tone,
  children,
}: {
  value: string;
  tone?: Tone;
  children?: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone ?? TONES[value] ?? "neutral"}`}>
      {children ?? value.replace(/_/gu, " ")}
    </span>
  );
}

export function YesNo({ value }: { value: boolean | null | undefined }) {
  if (value === null || value === undefined) return <span>unknown</span>;
  return <Badge value={value ? "yes" : "no"} tone={value ? "ok" : "bad"} />;
}
