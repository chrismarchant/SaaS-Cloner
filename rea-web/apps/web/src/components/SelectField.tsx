import { useId, type ComponentPropsWithoutRef } from "react";

/**
 * A select with its label next to it, not around it: a wrapping label would
 * fold every option's text into the control's accessible name.
 */
export function SelectField({
  label,
  hideLabel = false,
  children,
  ...select
}: {
  label: string;
  hideLabel?: boolean;
} & ComponentPropsWithoutRef<"select">) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      <select id={id} {...select}>
        {children}
      </select>
    </div>
  );
}
