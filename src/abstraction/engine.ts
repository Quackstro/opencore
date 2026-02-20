/**
 * T-010/T-012/T-013/T-014: Workflow Engine + SDK
 *
 * Core state machine that drives workflow execution:
 * - Register and validate workflow definitions
 * - Start workflows, render steps, handle transitions
 * - Cancel/back meta-actions
 * - Tool call execution with param mapping
 * - Progress indicators
 * - Concurrency guard (first action wins)
 */

import type {
  CapabilityNegotiator,
  MessagePayload,
  ParsedUserAction,
  RenderContext,
  RenderedMessage,
  SurfaceAdapter,
  SurfaceTarget,
} from "./adapter.js";
import type {
  ConfirmPrimitive,
  InteractionPrimitive,
  StepProgress,
} from "./primitives.js";
import type { WorkflowStateManager } from "./state.js";
import type {
  StepData,
  ToolCallBinding,
  WorkflowActionResult,
  WorkflowDefinition,
  WorkflowState,
  WorkflowStepDefinition,
} from "./types/workflow.js";
import {
  validateWorkflowDefinition,
  type ValidationResult,
} from "./schema/validate.js";

const DEFAULT_TTL = 3600000; // 1 hour

/** Tool executor injected by the host (calls the agent tool system). */
export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<{ success: boolean; result?: unknown; error?: string }>;

// ─── Concurrency lock ───────────────────────────────────────────────────────

const activeLocks = new Set<string>();

function lockKey(userId: string, workflowId: string): string {
  return `${userId}::${workflowId}`;
}

// ─── Progress calculation ───────────────────────────────────────────────────

function computeProgress(
  def: WorkflowDefinition,
  currentStep: string,
  stepHistory: string[],
): StepProgress | undefined {
  if (def.showProgress === false) {return undefined;}

  // Simple: count steps along the longest path from entry to nearest terminal
  // For display purposes, use: current = history.length + 1
  const current = stepHistory.length + 1;

  // Estimate total by BFS from current step to nearest terminal
  const total = current + stepsToTerminal(def, currentStep);
  return { current, total };
}

function stepsToTerminal(
  def: WorkflowDefinition,
  fromStep: string,
): number {
  // BFS to find shortest path to any terminal
  const visited = new Set<string>();
  const queue: Array<{ stepId: string; depth: number }> = [
    { stepId: fromStep, depth: 0 },
  ];

  while (queue.length > 0) {
    const { stepId, depth } = queue.shift()!;
    if (visited.has(stepId)) {continue;}
    visited.add(stepId);

    const step = def.steps[stepId];
    if (!step) {continue;}
    if (step.terminal) {return depth;}

    if (step.next) {
      queue.push({ stepId: step.next, depth: depth + 1 });
    }
    if (step.transitions) {
      for (const target of Object.values(step.transitions)) {
        queue.push({ stepId: target, depth: depth + 1 });
      }
    }
  }

  return 1; // fallback
}

// ─── Template interpolation ─────────────────────────────────────────────────

function interpolate(
  template: string,
  data: Record<string, StepData>,
): string {
  return template.replace(/\{\{data\.([^}]+)\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    const stepId = parts[0];
    const field = parts[1] ?? "input"; // default to .input
    const stepData = data[stepId];
    if (!stepData) {return "";}

    if (field === "input") {return stepData.input ?? "";}
    if (field === "selection") {
      return Array.isArray(stepData.selection)
        ? stepData.selection.join(", ")
        : (stepData.selection ?? "");
    }
    return "";
  });
}

// ─── Workflow SDK / Engine ───────────────────────────────────────────────────

export class WorkflowEngine {
  private definitions: Map<string, WorkflowDefinition> = new Map();
  private stateManager: WorkflowStateManager;
  private negotiator: CapabilityNegotiator;
  private adapters: Map<string, SurfaceAdapter> = new Map();
  private toolExecutor: ToolExecutor;

  constructor(opts: {
    stateManager: WorkflowStateManager;
    negotiator: CapabilityNegotiator;
    toolExecutor: ToolExecutor;
  }) {
    this.stateManager = opts.stateManager;
    this.negotiator = opts.negotiator;
    this.toolExecutor = opts.toolExecutor;
  }

  registerAdapter(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.surfaceId, adapter);
  }

  // ─── SDK Methods ──────────────────────────────────────────────────────

  registerWorkflow(definition: WorkflowDefinition): ValidationResult {
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {return result;}
    this.definitions.set(definition.id, definition);
    return result;
  }

  getWorkflowDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  hasWorkflow(id: string): boolean {
    return this.definitions.has(id);
  }

  async startWorkflow(
    workflowId: string,
    userId: string,
    surface: SurfaceTarget,
    initialData?: Record<string, unknown>,
  ): Promise<WorkflowState> {
    const def = this.definitions.get(workflowId);
    if (!def) {throw new Error(`Workflow "${workflowId}" not registered`);}

    // Cancel existing instance of this workflow for this user
    const existing = this.stateManager.get(userId, workflowId);
    if (existing) {
      this.stateManager.delete(userId, workflowId);
    }

    const now = new Date().toISOString();
    const ttl = def.ttl ?? DEFAULT_TTL;
    const surfaceKey = `${surface.surfaceId}:${surface.surfaceUserId}`;

    const state: WorkflowState = {
      workflowId,
      userId,
      currentStep: def.entryPoint,
      stepHistory: [],
      data: {},
      startedAt: now,
      lastActiveAt: now,
      originSurface: surfaceKey,
      lastSurface: surfaceKey,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      lastMessageIds: {},
    };

    this.stateManager.create(state);

    // Render entry point
    await this.renderStep(state, def, surface);

    // Auto-advance through consecutive info steps
    let currentStepDef = def.steps[state.currentStep];
    while (currentStepDef?.type === "info" && !currentStepDef.terminal && currentStepDef.next) {
      // Execute tool call on auto-advanced info step if present
      if (currentStepDef.toolCall) {
        const params = this.resolveToolParams(currentStepDef.toolCall, state, {
          kind: "text", workflowId: def.id, stepId: state.currentStep, surface, rawEvent: {},
        });
        const result = await this.toolExecutor(currentStepDef.toolCall.name, params);
        if (!result.success) {
          // On error during auto-advance, stop advancing
          break;
        }
      }
      state.stepHistory.push(state.currentStep);
      state.currentStep = currentStepDef.next;
      this.stateManager.update(state);
      await this.renderStep(state, def, surface);
      currentStepDef = def.steps[state.currentStep];
    }

    return state;
  }

  async handleAction(
    userId: string,
    action: ParsedUserAction,
  ): Promise<WorkflowActionResult> {
    const state = this.stateManager.getActiveForUser(userId);
    if (!state) {
      return {
        outcome: "cancelled",
        state: null,
        error: "No active workflow",
      };
    }

    const def = this.definitions.get(state.workflowId);
    if (!def) {
      return { outcome: "cancelled", state: null, error: "Workflow definition not found" };
    }

    // Concurrency guard
    const lk = lockKey(userId, state.workflowId);
    if (activeLocks.has(lk)) {
      return {
        outcome: "cancelled",
        state,
        error: "Already handled on another surface.",
      };
    }
    activeLocks.add(lk);

    try {
      return await this.processAction(state, def, action);
    } finally {
      activeLocks.delete(lk);
    }
  }

  async cancelWorkflow(
    userId: string,
    workflowId: string,
  ): Promise<void> {
    this.stateManager.delete(userId, workflowId);
  }

  getActiveWorkflow(userId: string): WorkflowState | null {
    return this.stateManager.getActiveForUser(userId);
  }

  getSurfaceCapabilities(surface: SurfaceTarget) {
    const adapter = this.adapters.get(surface.surfaceId);
    return adapter?.capabilities;
  }

  // ─── Core Engine ──────────────────────────────────────────────────────

  private async processAction(
    state: WorkflowState,
    def: WorkflowDefinition,
    action: ParsedUserAction,
  ): Promise<WorkflowActionResult> {
    const surface = action.surface;

    // Update last surface
    state.lastSurface = `${surface.surfaceId}:${surface.surfaceUserId}`;
    state.lastActiveAt = new Date().toISOString();

    // Meta-actions
    if (action.kind === "cancel") {
      this.stateManager.delete(state.userId, state.workflowId);
      const adapter = this.adapters.get(surface.surfaceId);
      if (adapter) {
        await adapter.sendMessage(surface, {
          text: "Cancelled. No changes were made.",
        });
      }
      return { outcome: "cancelled", state: null };
    }

    if (action.kind === "back") {
      if (state.stepHistory.length === 0) {
        // Back on first step = cancel
        this.stateManager.delete(state.userId, state.workflowId);
        const adapter = this.adapters.get(surface.surfaceId);
        if (adapter) {
          await adapter.sendMessage(surface, {
            text: "Cancelled. No changes were made.",
          });
        }
        return { outcome: "cancelled", state: null };
      }

      // Pop previous step, clear current step data
      delete state.data[state.currentStep];
      state.currentStep = state.stepHistory.pop()!;
      this.stateManager.update(state);
      await this.renderStep(state, def, surface);
      return { outcome: "advanced", state };
    }

    // Regular action
    const step = def.steps[state.currentStep];
    if (!step) {
      return {
        outcome: "cancelled",
        state: null,
        error: "Current step not found in definition",
      };
    }

    // Validation for text-input
    if (step.type === "text-input" && action.kind === "text") {
      const vErr = this.validate(step, action.text ?? "");
      if (vErr) {
        const adapter = this.adapters.get(surface.surfaceId);
        if (adapter) {
          await adapter.sendMessage(surface, { text: vErr });
        }
        return { outcome: "validation-error", state, error: vErr };
      }
    }

    // Store step data
    const stepData: StepData = { timestamp: new Date().toISOString() };
    if (action.kind === "selection") {
      stepData.selection = action.value;
    } else if (action.kind === "text") {
      stepData.input = action.text;
    }
    state.data[state.currentStep] = stepData;

    // Execute tool call if bound
    let toolResult: unknown;
    if (step.toolCall) {
      const params = this.resolveToolParams(step.toolCall, state, action);
      const result = await this.toolExecutor(step.toolCall.name, params);
      if (!result.success) {
        const errMsg = result.error ?? "Tool call failed. Please try again.";
        const adapter = this.adapters.get(surface.surfaceId);
        if (adapter) {
          await adapter.sendMessage(surface, { text: errMsg });
        }
        // Stay on current step or go to onError step
        if (step.toolCall.onError) {
          state.stepHistory.push(state.currentStep);
          state.currentStep = step.toolCall.onError;
          this.stateManager.update(state);
          await this.renderStep(state, def, surface);
        }
        return {
          outcome: "tool-error",
          state,
          error: errMsg,
          toolResult: result.result,
        };
      }
      toolResult = result.result;
    }

    // Resolve next step
    const nextStepId = this.resolveTransition(step, action);
    if (!nextStepId) {
      // Terminal or no transition
      if (step.terminal) {
        this.stateManager.delete(state.userId, state.workflowId);
        return { outcome: "completed", state: null, toolResult };
      }
      return { outcome: "advanced", state, toolResult };
    }

    // Advance
    state.stepHistory.push(state.currentStep);
    state.currentStep = nextStepId;
    this.stateManager.update(state);

    const nextStep = def.steps[nextStepId];
    await this.renderStep(state, def, surface);

    // Auto-advance through info steps (non-interactive, non-terminal)
    if (nextStep && nextStep.type === "info" && !nextStep.terminal && nextStep.next) {
      // Execute tool call on auto-advanced info step if present
      if (nextStep.toolCall) {
        const infoParams = this.resolveToolParams(nextStep.toolCall, state, action);
        const infoResult = await this.toolExecutor(nextStep.toolCall.name, infoParams);
        if (!infoResult.success) {
          const errMsg = infoResult.error ?? "Tool call failed.";
          const adapter = this.adapters.get(surface.surfaceId);
          if (adapter) {
            await adapter.sendMessage(surface, { text: errMsg });
          }
          if (nextStep.toolCall.onError) {
            state.stepHistory.push(state.currentStep);
            state.currentStep = nextStep.toolCall.onError;
            this.stateManager.update(state);
            await this.renderStep(state, def, surface);
            const errorStep = def.steps[state.currentStep];
            if (errorStep?.terminal) {
              this.stateManager.delete(state.userId, state.workflowId);
              return { outcome: "completed", state: null, toolResult: infoResult.result };
            }
          }
          return { outcome: "tool-error", state, error: errMsg, toolResult: infoResult.result };
        }
        if (!toolResult) {toolResult = infoResult.result;}
      }
      state.stepHistory.push(state.currentStep);
      state.currentStep = nextStep.next;
      this.stateManager.update(state);
      await this.renderStep(state, def, surface);
    }

    // Check if we landed on a terminal
    const landedStep = def.steps[state.currentStep];
    if (landedStep?.terminal) {
      this.stateManager.delete(state.userId, state.workflowId);
      return { outcome: "completed", state: null, toolResult };
    }

    return { outcome: "advanced", state, toolResult };
  }

  // ─── Step Rendering ───────────────────────────────────────────────────

  private async renderStep(
    state: WorkflowState,
    def: WorkflowDefinition,
    surface: SurfaceTarget,
  ): Promise<RenderedMessage | null> {
    const step = def.steps[state.currentStep];
    if (!step) {return null;}

    const adapter = this.adapters.get(surface.surfaceId);
    if (!adapter) {return null;}

    const progress = computeProgress(def, state.currentStep, state.stepHistory);
    const content = interpolate(step.content, state.data);
    const primitive = this.stepToPrimitive(step, content, progress, state);

    // Negotiate capability
    const negotiation = this.negotiator.negotiate(primitive, adapter.capabilities);

    const context: RenderContext = {
      workflowId: state.workflowId,
      stepId: state.currentStep,
      plugin: def.plugin,
      isContinuation: state.originSurface !== state.lastSurface,
      previousSurface: state.originSurface !== state.lastSurface
        ? state.originSurface.split(":")[0]
        : undefined,
    };

    const toRender =
      negotiation.strategy === "text-fallback" && negotiation.fallbackPrimitive
        ? negotiation.fallbackPrimitive
        : primitive;

    if (negotiation.strategy === "notify-blocked") {
      await adapter.sendMessage(surface, {
        text: negotiation.blockedReason ?? "This step is not supported on this surface.",
      });
      return { messageId: "", usedFallback: true, fallbackType: "notify-blocked" };
    }

    const result = await adapter.render(surface, toRender, context);

    // Track message ID for later update
    state.lastMessageIds[surface.surfaceId] = result.messageId;
    this.stateManager.update(state);

    return result;
  }

  private stepToPrimitive(
    step: WorkflowStepDefinition,
    content: string,
    progress: StepProgress | undefined,
    state: WorkflowState,
  ): InteractionPrimitive {
    const isFirstStep = state.stepHistory.length === 0;
    const includeBack = !isFirstStep;
    const includeCancel = true;

    switch (step.type) {
      case "choice":
        return {
          type: "choice" as const,
          content,
          options: step.options ?? [],
          includeBack,
          includeCancel,
          progress,
        };
      case "multi-choice":
        return {
          type: "multi-choice" as const,
          content,
          options: step.options ?? [],
          minSelections: step.minSelections,
          maxSelections: step.maxSelections,
          submitLabel: "Confirm",
          includeBack,
          includeCancel,
          progress,
        };
      case "confirm":
        return {
          type: "confirm" as const,
          content,
          confirmLabel: step.confirmLabel ?? "Yes",
          denyLabel: step.denyLabel ?? "No",
          includeBack,
          includeCancel,
          progress,
        };
      case "text-input":
        return {
          type: "text-input" as const,
          content,
          placeholder: step.placeholder,
          validation: step.validation,
          includeBack,
          includeCancel,
          progress,
        };
      case "info":
        return {
          type: "info" as const,
          content,
          terminal: step.terminal,
          progress: step.terminal ? undefined : progress,
        };
      case "media":
        return {
          type: "media" as const,
          content,
          mediaType: step.media?.type ?? "file",
          mediaUrl: step.media?.url,
          mediaPath: step.media?.path,
          mimeType: step.media?.mimeType,
          includeBack,
          includeCancel,
          progress,
        };
    }
  }

  // ─── Transition Resolution ────────────────────────────────────────────

  private resolveTransition(
    step: WorkflowStepDefinition,
    action: ParsedUserAction,
  ): string | null {
    if (step.terminal) {return null;}

    // Branching transitions
    if (step.transitions && action.kind === "selection") {
      const value = Array.isArray(action.value)
        ? action.value[0]
        : action.value;
      if (value && step.transitions[value]) {
        return step.transitions[value];
      }
    }

    // Linear
    if (step.next) {return step.next;}

    return null;
  }

  // ─── Validation ───────────────────────────────────────────────────────

  private validate(step: WorkflowStepDefinition, input: string): string | null {
    const v = step.validation;
    if (!v) {return null;}

    if (v.minLength !== undefined && input.length < v.minLength) {
      return (
        v.errorMessage ??
        `Input must be at least ${v.minLength} characters.`
      );
    }
    if (v.maxLength !== undefined && input.length > v.maxLength) {
      return (
        v.errorMessage ??
        `Input must be at most ${v.maxLength} characters.`
      );
    }
    if (v.pattern) {
      try {
        if (!new RegExp(v.pattern).test(input)) {
          return v.errorMessage ?? "Input does not match the required format.";
        }
      } catch {
        // Invalid regex in definition — skip
      }
    }
    return null;
  }

  // ─── Tool Call Param Resolution ───────────────────────────────────────

  private resolveToolParams(
    binding: ToolCallBinding,
    state: WorkflowState,
    action: ParsedUserAction,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    for (const [key, mapping] of Object.entries(binding.paramMap)) {
      if (mapping === "$input") {
        params[key] = action.text ?? action.value;
      } else if (mapping.startsWith("$data.")) {
        const path = mapping.slice(6); // remove "$data."
        const parts = path.split(".");
        const stepId = parts[0];
        const field = parts[1] ?? "input";
        const stepData = state.data[stepId];
        if (stepData) {
          if (field === "input") {params[key] = stepData.input;}
          else if (field === "selection") {params[key] = stepData.selection;}
          else {params[key] = stepData.input ?? stepData.selection;}
        }
      } else {
        // Literal value
        params[key] = mapping;
      }
    }

    return params;
  }
}
