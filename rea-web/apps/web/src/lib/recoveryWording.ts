/**
 * Words for recovery statuses (docs/RECOVERY-FORMAT.md). A status is shown as
 * the vocabulary states it: blocked, partial and failed stay what they are,
 * `unknown` is never upgraded, and no percentage or score is ever derived.
 */
import type { Tone } from "../components/Badge";

export const humanise = (value: string): string => value.replace(/_/gu, " ");

export interface Wording {
  readonly label: string;
  readonly tone: Tone;
  readonly meaning: string;
}

// --- consistency ---------------------------------------------------------------

export type Consistency = "single_point" | "inconsistent" | "unknown";

export const consistencyWording = (
  value: Consistency | string | null | undefined,
): Wording => {
  switch (value) {
    case "single_point":
      return {
        label: "single point",
        tone: "ok",
        meaning:
          "The collectors report that the captured components reflect one point in time. The strategy and window are in the manifest.",
      };
    case "inconsistent":
      return {
        label: "inconsistent",
        tone: "bad",
        meaning:
          "The components were not captured from one shared point in time. The gaps in the manifest say where.",
      };
    case "unknown":
      return {
        label: "unknown",
        tone: "warn",
        meaning:
          "Consistency could not be established. This is not a pass: treat the components as captured at different times.",
      };
    default:
      return value === null || value === undefined || value === ""
        ? {
            label: "not classified",
            tone: "neutral",
            meaning:
              "The capture has not produced a consistency classification.",
          }
        : {
            label: humanise(value),
            tone: "neutral",
            meaning:
              "A classification this page does not know; shown as the server sent it and not treated as a pass.",
          };
  }
};

// --- capture components --------------------------------------------------------

export const COMPONENT_STATUS_WORDING: Readonly<Record<string, Wording>> = {
  captured: {
    label: "captured",
    tone: "ok",
    meaning: "Bytes exist in the package with recorded hashes.",
  },
  partial: {
    label: "partial",
    tone: "warn",
    meaning:
      "Only part of the component was captured; see its limitations and omissions.",
  },
  blocked: {
    label: "blocked",
    tone: "bad",
    meaning:
      "The component could not be captured; see the missing or blocked list.",
  },
  manual: {
    label: "manual",
    tone: "warn",
    meaning:
      "The component needs a step by hand; see the manual prerequisites.",
  },
  pending: {
    label: "pending",
    tone: "neutral",
    meaning: "The component has not been captured yet.",
  },
};

export const componentStatusWording = (status: string): Wording =>
  COMPONENT_STATUS_WORDING[status] ?? {
    label: humanise(status),
    tone: "neutral",
    meaning: "A status this page does not know; shown as the server sent it.",
  };

// --- verification --------------------------------------------------------------

export const VERIFICATION_STATUS_WORDING: Readonly<Record<string, Wording>> = {
  captured: {
    label: "captured",
    tone: "info",
    meaning: "Bytes exist in the package with recorded hashes.",
  },
  integrity_verified: {
    label: "integrity verified",
    tone: "ok",
    meaning:
      "Every file's SHA-256 matched and the manifest validated against the embedded schema.",
  },
  clean_build_verified: {
    label: "clean build verified",
    tone: "ok",
    meaning:
      "Source was restored into an empty directory, dependencies installed, and the declared build command succeeded.",
  },
  data_restore_verified: {
    label: "data restore verified",
    tone: "ok",
    meaning:
      "The database was restored into a disposable instance and the declared invariants held.",
  },
  behavior_verified: {
    label: "behavior verified",
    tone: "ok",
    meaning: "The named critical behaviour checks passed.",
  },
  partial: {
    label: "partial",
    tone: "warn",
    meaning: "Some scopes passed and some did not; see each scope.",
  },
  blocked: {
    label: "blocked",
    tone: "warn",
    meaning:
      "The scope could not run (a missing prerequisite, network required but denied, or an unsupported host). This is a reported result, not a failure of the job.",
  },
  failed: {
    label: "failed",
    tone: "bad",
    meaning: "The scope ran and its checks did not pass.",
  },
};

export const verificationStatusWording = (status: string): Wording =>
  VERIFICATION_STATUS_WORDING[status] ?? {
    label: humanise(status),
    tone: "neutral",
    meaning: "A status this page does not know; shown as the server sent it.",
  };

export type NetworkVerdict = "yes" | "no" | "unknown";

export const networkWording = (verdict: NetworkVerdict | null): Wording => {
  switch (verdict) {
    case "yes":
      return {
        label: "yes",
        tone: "warn",
        meaning:
          "Restoring needed outbound network, so the package is not network-free. The reasons say which steps.",
      };
    case "no":
      return {
        label: "no",
        tone: "ok",
        meaning:
          "Every step completed with outbound network denied. This is reported only from observed steps.",
      };
    case "unknown":
      return {
        label: "unknown",
        tone: "warn",
        meaning:
          "Whether the restore needs network was not established, for example because a step did not run.",
      };
    default:
      return {
        label: "not reported",
        tone: "neutral",
        meaning: "The verification has not reported a network verdict.",
      };
  }
};

export const SCOPE_HELP: Readonly<Record<string, string>> = {
  integrity:
    "Checks every file hash and the manifest against the embedded schema. Needs nothing from the runner beyond the package.",
  clean_build:
    "Restores the source into an empty directory, installs dependencies and runs the declared build. Registry steps are blocked unless the runner allows registry network (REA_WEB_VERIFY_ALLOW_NETWORK).",
  data_restore:
    "Restores the database dump into a disposable database and checks the declared invariants. The runner needs a restore-only database server (REA_WEB_VERIFY_DATABASE_ADMIN_URL); without it this scope reports blocked.",
  behavior:
    "Runs the declared critical behaviour checks against the restored build.",
};
