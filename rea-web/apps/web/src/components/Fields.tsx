import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

/** A labelled input with help text tied to it by `aria-describedby`. */
export function TextField({
  label,
  help,
  mono = false,
  onValue,
  ...input
}: {
  label: string;
  help?: ReactNode;
  mono?: boolean;
  onValue: (value: string) => void;
} & Omit<ComponentPropsWithoutRef<"input">, "onChange" | "id">) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={mono ? "mono" : undefined}
        aria-describedby={help === undefined ? undefined : `${id}-help`}
        onChange={(event) => onValue(event.target.value)}
        {...input}
      />
      {help !== undefined && (
        <span id={`${id}-help`} className="help-text">
          {help}
        </span>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  help,
  mono = false,
  onValue,
  ...input
}: {
  label: string;
  help?: ReactNode;
  mono?: boolean;
  onValue: (value: string) => void;
} & Omit<ComponentPropsWithoutRef<"textarea">, "onChange" | "id">) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className={mono ? "mono" : undefined}
        aria-describedby={help === undefined ? undefined : `${id}-help`}
        onChange={(event) => onValue(event.target.value)}
        {...input}
      />
      {help !== undefined && (
        <span id={`${id}-help`} className="help-text">
          {help}
        </span>
      )}
    </div>
  );
}

export function CheckField({
  label,
  checked,
  onValue,
  help,
}: {
  label: string;
  checked: boolean;
  onValue: (checked: boolean) => void;
  help?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="inline">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={help === undefined ? undefined : `${id}-help`}
          onChange={(event) => onValue(event.target.checked)}
        />{" "}
        {label}
      </label>
      {help !== undefined && (
        <span id={`${id}-help`} className="help-text">
          {help}
        </span>
      )}
    </div>
  );
}
