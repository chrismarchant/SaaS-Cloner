import { TOOL_EFFECTS, type ToolEffect } from "@rea-web/contracts/browser";
import {
  BUDGET_KEYS,
  CONTRACT_BUDGET_DEFAULTS,
  type PolicyDraft,
  type PolicyMode,
} from "../lib/policy";

const toggle = (list: ToolEffect[], effect: ToolEffect): ToolEffect[] =>
  list.includes(effect) ? list.filter((e) => e !== effect) : [...list, effect];

/** Execution policy inputs; contract defaults come from `defaultPolicyDraft`. */
export function PolicyFields({
  draft,
  onChange,
  errors,
}: {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  errors: Record<string, string>;
}) {
  return (
    <fieldset>
      <legend>Execution policy</legend>
      <fieldset className="nested">
        <legend>Mode</legend>
        {(
          [
            ["static_only", "Static only"],
            ["static_plus_runtime", "Static plus runtime"],
          ] as const satisfies readonly (readonly [PolicyMode, string])[]
        ).map(([value, label]) => (
          <label key={value} className="inline">
            <input
              type="radio"
              name="policy-mode"
              value={value}
              checked={draft.mode === value}
              onChange={() => onChange({ ...draft, mode: value })}
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>
      <div className="grid-2">
        <fieldset className="nested">
          <legend>Allowed effects</legend>
          {TOOL_EFFECTS.map((effect) => (
            <label key={effect} className="inline block">
              <input
                type="checkbox"
                checked={draft.allowed.includes(effect)}
                onChange={() =>
                  onChange({ ...draft, allowed: toggle(draft.allowed, effect) })
                }
              />{" "}
              <code>{effect}</code>
            </label>
          ))}
        </fieldset>
        <fieldset className="nested">
          <legend>Effects that require approval</legend>
          {TOOL_EFFECTS.map((effect) => (
            <label key={effect} className="inline block">
              <input
                type="checkbox"
                checked={draft.approval.includes(effect)}
                onChange={() =>
                  onChange({
                    ...draft,
                    approval: toggle(draft.approval, effect),
                  })
                }
              />{" "}
              <code>{effect}</code>
              <span className="sr-only"> requires approval</span>
            </label>
          ))}
        </fieldset>
      </div>
      <p className="muted help">
        A tool call whose effects include an approval-required effect pauses the
        job in awaiting approval until a member approves or rejects it.
      </p>
      <label className="inline block">
        <input
          type="checkbox"
          checked={draft.modelFollowUp}
          onChange={(event) =>
            onChange({ ...draft, modelFollowUp: event.target.checked })
          }
        />{" "}
        Model follow-up (a bounded model-driven loop, when a model provider is
        configured on the runner)
      </label>
      <label>
        Maximum follow-up rounds
        <input
          value={draft.maxRounds}
          inputMode="numeric"
          onChange={(event) =>
            onChange({ ...draft, maxRounds: event.target.value })
          }
        />
      </label>
      {errors["max_follow_up_rounds"] !== undefined && (
        <p className="field-error">{errors["max_follow_up_rounds"]}</p>
      )}
      <details>
        <summary>Budget overrides</summary>
        <p className="muted help">
          Leave a field empty to keep the default. Counted budgets (tool calls,
          model tokens) end planned work early and produce a partial result;
          measured budgets (time, memory, disk, artifact bytes) abort the job
          when exceeded.
        </p>
        <div className="grid-2">
          {BUDGET_KEYS.map((key) => (
            <div key={key} className="field">
              <label htmlFor={`budget-${key}`}>
                <code>{key}</code>
              </label>
              <input
                id={`budget-${key}`}
                inputMode="numeric"
                placeholder={`default ${CONTRACT_BUDGET_DEFAULTS[key] ?? "none"}`}
                value={draft.budget[key] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    budget: { ...draft.budget, [key]: event.target.value },
                  })
                }
              />
              {errors[key] !== undefined && (
                <small className="field-error">{errors[key]}</small>
              )}
            </div>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
