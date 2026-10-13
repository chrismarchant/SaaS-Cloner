export const PACKAGE_NAME = "@rea-web/preservation";

export * from "./types.js";
export { runCommand } from "./exec.js";
export { planPreservation, consistencyStrategyText } from "./plan.js";
export { capturePackage } from "./capture.js";
export {
  infrastructureDescriptorSchema,
  integrationsDescriptorSchema,
  type InfrastructureDescriptor,
  type IntegrationsDescriptor,
} from "./descriptors.js";
export { evidenceKey } from "./collectors/artifacts.js";
