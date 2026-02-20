# Plugin Migration Guide: Channel Abstraction Layer

> Step-by-step guide for migrating a plugin from direct surface API calls to the channel abstraction layer.
> Based on the wallet plugin migration (Phase 3).

## Overview

The channel abstraction layer lets you define interactive workflows once and run them on any surface (Telegram, Slack, text-only, etc.) without surface-specific code. This guide walks through migrating an existing plugin.

## Prerequisites

- Familiarity with the abstraction layer types (`src/abstraction/`)
- Understanding of your plugin's interactive flows

## Step 1: Audit Your Plugin

Document every interactive flow in your plugin:

1. **List all user-facing interactions** — button prompts, text inputs, confirmations, multi-step wizards
2. **For each flow, document**:
   - Steps (in order)
   - Branching points (where user choice determines next step)
   - Tool calls (what gets executed)
   - Error paths (what happens on failure)
   - Validation rules (input constraints)
3. **Identify Telegram-specific logic**:
   - Inline keyboard callbacks
   - Message deletion/editing
   - Parse mode (Markdown/HTML)
   - Direct API calls

Write the audit to `specs/channel-abstraction/audit-<plugin>.md`.

### Example: Wallet Audit Summary

| Flow | Steps | Branching | Tool Calls | Complexity |
|------|-------|-----------|------------|------------|
| Onboarding | 5 | confirm yes/no | wallet_init | Medium |
| Send DOGE | 5 | confirm send/cancel | wallet_send | Medium |
| Balance | 1 | None | wallet_balance | Trivial |
| Invoice | 4 | confirm create/cancel | wallet_invoice | Low |

## Step 2: Design JSON Workflow Definitions

Each interactive flow becomes a JSON workflow definition. The schema is at `src/abstraction/schema/workflow.schema.json`.

### Workflow Structure

```json
{
  "id": "plugin-workflow-name",
  "plugin": "your-plugin",
  "version": "1.0.0",
  "ttl": 3600000,
  "entryPoint": "first-step",
  "steps": {
    "first-step": { ... },
    "second-step": { ... }
  }
}
```

### Step Types

| Type | Use For | User Action |
|------|---------|-------------|
| `info` | Display-only messages | None (auto-advances) |
| `confirm` | Yes/No decisions | Button press or "yes"/"no" text |
| `choice` | Single selection from options | Button press or numbered reply |
| `multi-choice` | Multiple selections | Toggle buttons or comma-separated numbers |
| `text-input` | Free text entry | User types a reply |
| `media` | Image/file/voice display | None (informational) |

### Pattern: Linear Flow

Steps execute in sequence. Use `"next"` for transitions.

```json
{
  "step1": {
    "type": "text-input",
    "content": "Enter your name:",
    "validation": { "minLength": 1 },
    "next": "step2"
  },
  "step2": {
    "type": "info",
    "content": "Welcome, {{data.step1.input}}!",
    "terminal": true
  }
}
```

### Pattern: Branching Flow

User choices determine the next step. Use `"transitions"`.

```json
{
  "confirm-action": {
    "type": "confirm",
    "content": "Proceed with the action?",
    "confirmLabel": "Yes, do it",
    "denyLabel": "No, cancel",
    "transitions": {
      "yes": "execute",
      "no": "cancelled"
    }
  },
  "execute": {
    "type": "info",
    "content": "Done!",
    "terminal": true
  },
  "cancelled": {
    "type": "info",
    "content": "Cancelled.",
    "terminal": true
  }
}
```

### Pattern: Tool Call After Confirmation

When you need to execute a tool call only after user confirms, use an intermediate `info` step with a `toolCall`. The engine executes tool calls on info steps during auto-advance.

```json
{
  "confirm": {
    "type": "confirm",
    "content": "Send 10 DOGE?",
    "confirmLabel": "Send",
    "denyLabel": "Cancel",
    "transitions": {
      "yes": "execute",
      "no": "cancelled"
    }
  },
  "execute": {
    "type": "info",
    "content": "Sending...",
    "toolCall": {
      "name": "wallet_send",
      "paramMap": {
        "amount": "$data.enter-amount.input",
        "to": "$data.enter-address.input"
      },
      "onError": "error"
    },
    "next": "complete"
  },
  "complete": {
    "type": "info",
    "content": "Transaction sent!",
    "terminal": true
  },
  "error": {
    "type": "info",
    "content": "Failed. Try again.",
    "terminal": true
  },
  "cancelled": {
    "type": "info",
    "content": "Cancelled.",
    "terminal": true
  }
}
```

**Key point**: Don't put `toolCall` on a `confirm` step — it executes regardless of which option the user picks. Put it on an `info` step that's only reachable via the desired transition.

### Pattern: Tool Call on Text Input

For steps where the user input IS the tool parameter (e.g., passphrase), put the `toolCall` directly on the `text-input` step:

```json
{
  "set-passphrase": {
    "type": "text-input",
    "content": "Enter your passphrase:",
    "validation": { "minLength": 8 },
    "toolCall": {
      "name": "wallet_init",
      "paramMap": { "passphrase": "$input" }
    },
    "next": "complete"
  }
}
```

### Data Interpolation

Reference data from previous steps using `{{data.<stepId>.input}}` or `{{data.<stepId>.selection}}`:

```json
{
  "content": "Send {{data.enter-amount.input}} DOGE to {{data.enter-address.input}}?"
}
```

### Tool Call Parameter Mapping

| Syntax | Resolves To |
|--------|-------------|
| `"$input"` | Current step's user input (text or selection) |
| `"$data.<stepId>"` | Previous step's input (defaults to `.input`) |
| `"$data.<stepId>.input"` | Text input from a previous step |
| `"$data.<stepId>.selection"` | Selection from a previous choice/confirm step |
| `"literal"` | Passed as-is |

## Step 3: Write the Wiring Module

Create an `index.ts` that registers workflows and provides an entry point:

```typescript
import type { WorkflowEngine } from "../../engine.js";
import type { SurfaceTarget } from "../../adapter.js";

// Import JSON workflow definitions
import onboarding from "./onboarding.json" with { type: "json" };
import send from "./send.json" with { type: "json" };

export const WORKFLOW_IDS = {
  ONBOARDING: "my-plugin-onboarding",
  SEND: "my-plugin-send",
} as const;

export function registerWorkflows(engine: WorkflowEngine) {
  engine.registerWorkflow(onboarding as any);
  engine.registerWorkflow(send as any);
}

export async function startWorkflow(
  engine: WorkflowEngine,
  workflowId: string,
  userId: string,
  surface: SurfaceTarget,
) {
  return engine.startWorkflow(workflowId, userId, surface);
}
```

**Rule**: Import only from `src/abstraction/`. Never import surface-specific code (Telegram API, Slack SDK, etc.).

## Step 4: Write Tests

Write tests for each adapter you support:

### Telegram Tests

```typescript
import { TelegramAdapter, encodeCallbackData } from "../adapters/telegram/telegram-adapter.js";

// Mock the Telegram provider
// Start workflow → verify buttons have correct labels
// Parse callback_query → verify action is correctly decoded
// Complete flow → verify tool calls fired with correct params
```

### Text-Only Tests

```typescript
import { TextOnlyAdapter } from "../adapters/text/text-adapter.js";

// Start workflow → verify text output includes numbered options
// Parse text input → verify "yes"/"no", numbers, "cancel", "back" all work
// Complete flow → verify all paths completable via text
```

## Step 5: Remove Surface-Specific Code

Once tests pass on all adapters, remove:

- Direct Telegram API calls
- Inline keyboard builders
- Callback data encoding/parsing
- Surface-specific message formatting
- Custom state management (the engine handles this)

## Common Gotchas

### 1. Tool calls on confirm steps fire for ALL selections
**Wrong**: `toolCall` on a `confirm` step → executes even when user says "no".
**Right**: Put `toolCall` on an `info` step only reachable via "yes" transition.

### 2. Info steps auto-advance
Info steps without `terminal: true` automatically advance to `next`. Don't expect user interaction on info steps. If you need the user to acknowledge something, use a `confirm` step.

### 3. Validation only works on text-input steps
The engine only validates `text-input` steps. For `choice`/`confirm`, the options are inherently constrained.

### 4. Each step needs exactly one exit
Every step must have exactly one of: `transitions`, `next`, or `terminal: true`. The schema validator rejects steps with zero or multiple exits.

### 5. Max 7 options per choice (Miller's Law)
The validator enforces a maximum of 7 options per choice/multi-choice step. If you need more, chunk into sub-choices.

### 6. Back/cancel are automatic
The engine adds back and cancel to every non-terminal, non-first step. Don't add them as explicit options.

### 7. Progress is automatic
The engine calculates and displays "Step X of Y" unless you set `"showProgress": false`.

## Before & After: Wallet Onboarding

### Before (Telegram-specific)

```typescript
// 300+ lines across flow.ts, state.ts, message-utils.ts, types.ts
class OnboardingFlow {
  async handleCallback(ctx) {
    switch (ctx.callbackData) {
      case 'doge:onboard:start':
        return this.handleStart(chatId);
      case 'doge:onboard:phrase_saved':
        return this.handlePhraseSaved(chatId);
      // ... 15 more cases
    }
  }
  
  async handleStart(chatId) {
    await this.stateManager.transitionTo(chatId, OnboardingState.PASSPHRASE_PENDING);
    return { text: passphrasePromptMessage() };
  }
  // ... hundreds more lines of state management, message formatting, etc.
}
```

### After (Abstraction layer)

```json
{
  "id": "wallet-onboarding",
  "plugin": "wallet",
  "version": "1.0.0",
  "entryPoint": "welcome",
  "steps": {
    "welcome": { "type": "info", "content": "Welcome!", "next": "confirm" },
    "confirm": {
      "type": "confirm",
      "content": "Create wallet?",
      "transitions": { "yes": "passphrase", "no": "cancelled" }
    },
    "passphrase": {
      "type": "text-input",
      "content": "Enter passphrase:",
      "validation": { "minLength": 8 },
      "toolCall": { "name": "wallet_init", "paramMap": { "passphrase": "$input" } },
      "next": "complete"
    },
    "complete": { "type": "info", "content": "Done!", "terminal": true },
    "cancelled": { "type": "info", "content": "Cancelled.", "terminal": true }
  }
}
```

**Result**: ~30 lines of JSON + ~20 lines of TypeScript wiring, instead of 300+ lines of Telegram-coupled code. Works on Telegram, Slack, text-only, and any future surface.

## Checklist

- [ ] Audit document written (`specs/channel-abstraction/audit-<plugin>.md`)
- [ ] JSON workflow definitions created and validate against schema
- [ ] Wiring module (`index.ts`) imports only from abstraction layer
- [ ] Tests pass on Telegram adapter
- [ ] Tests pass on Text-Only adapter
- [ ] No direct surface API calls remain in plugin code
- [ ] All tool calls map correctly
- [ ] Back/cancel work at every step
- [ ] Validation errors show clear messages
