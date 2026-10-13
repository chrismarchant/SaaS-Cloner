declare const __REA_RECOVER_VERSION__: string | undefined;

/** The CLI package version, embedded at bundle time by build.mjs. */
export const CLI_VERSION: string =
  typeof __REA_RECOVER_VERSION__ === "string"
    ? __REA_RECOVER_VERSION__
    : "0.0.0-dev";
