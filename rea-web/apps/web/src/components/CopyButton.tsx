import { useState } from "react";

/** Copies text with the async clipboard API and says if it could not. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <>
      <button type="button" onClick={() => void copy()}>
        {label}
      </button>
      <span role="status" className="muted">
        {state === "copied" && " Copied."}
        {state === "failed" &&
          " Copy failed; select the text and copy it manually."}
      </span>
    </>
  );
}
