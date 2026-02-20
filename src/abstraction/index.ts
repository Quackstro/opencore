/**
 * Channel Abstraction Layer — Public API
 */

// Primitives (T-001)
export * from "./primitives.js";

// Adapter interface (T-002)
export * from "./adapter.js";

// Workflow types (T-003)
export * from "./types/workflow.js";

// Schema validation (T-003)
export { validateWorkflowDefinition } from "./schema/validate.js";
export type { ValidationResult, ValidationError } from "./schema/validate.js";

// Workflow state manager (T-004)
export { WorkflowStateManager } from "./state.js";

// Capability negotiator (T-005)
export { DefaultCapabilityNegotiator } from "./negotiator.js";

// Identity service (T-006)
export { IdentityService } from "./identity/identity-service.js";
export * from "./identity/types.js";

// Message router (T-007)
export { MessageRouter } from "./router.js";
