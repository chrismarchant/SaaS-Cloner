import { z } from "zod";

/** Verification scopes and statuses (docs/RECOVERY-FORMAT.md). Sole owner. */
export const VERIFICATION_SCOPES = [
  "integrity",
  "clean_build",
  "data_restore",
  "behavior",
] as const;
export const verificationScopeSchema = z.enum(VERIFICATION_SCOPES);
export type VerificationScope = (typeof VERIFICATION_SCOPES)[number];

export const VERIFICATION_STATUSES = [
  "captured",
  "integrity_verified",
  "clean_build_verified",
  "data_restore_verified",
  "behavior_verified",
  "partial",
  "blocked",
  "failed",
] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** The status a scope earns when every one of its checks passed. */
export const VERIFIED_STATUS_BY_SCOPE: Readonly<
  Record<VerificationScope, VerificationStatus>
> = {
  integrity: "integrity_verified",
  clean_build: "clean_build_verified",
  data_restore: "data_restore_verified",
  behavior: "behavior_verified",
};
