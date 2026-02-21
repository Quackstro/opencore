# UI Abstraction Layer

A channel-agnostic workflow engine that lets plugins define multi-step interactive UIs once and render them on any surface (Telegram, Slack, Discord, text-only).

## Problem

Every plugin was writing channel-specific UI code — Telegram inline keyboards, Slack blocks, Discord components. Adding a new channel meant updating every plugin. Adding a new plugin meant implementing every channel.

## Solution

A three-layer abstraction:

```
Workflow Definition (JSON)  →  Engine (state machine)  →  Surface Adapter (renderer)
```

1. **Interaction Primitives** — 6 universal UI building blocks
2. **Workflow Engine** — JSON-driven state machine with tool call execution
3. **Surface Adapters** — Channel-specific renderers (pluggable, community-extensible)

## Interaction Primitives

| Primitive      | Description                                | Example                |
| -------------- | ------------------------------------------ | ---------------------- |
| `choice`       | Single-select from options (max 7)         | Payment method picker  |
| `multi-choice` | Multi-select with min/max constraints      | Category filter        |
| `confirm`      | Yes/No with customizable labels            | "Send 5 DOGE?"         |
| `text-input`   | Free text with validation (regex, length)  | Enter address          |
| `info`         | Read-only display, auto-advance or dismiss | Success/error messages |
| `media`        | Image, file, or voice attachment           | Receipt, QR code       |

All primitives support:

- Progress indicators (`step 2 of 4`)
- Back/cancel navigation
- Dynamic content via `{{data.stepId.field}}` templates

## Workflow Definitions (JSON)

Workflows are declarative JSON files — no code required:

```json
{
  "id": "wallet-send",
  "plugin": "wallet",
  "version": "1.1.0",
  "ttl": 600000,
  "entryPoint": "enter-address",
  "steps": {
    "enter-address": {
      "type": "text-input",
      "content": "Enter the recipient's DOGE address:",
      "validation": {
        "pattern": "^D[1-9A-HJ-NP-Za-km-z]{25,34}$",
        "errorMessage": "Invalid DOGE address."
      },
      "next": "enter-amount"
    },
    "confirm-send": {
      "type": "confirm",
      "content": "Send {{data.enter-amount.input}} DOGE to {{data.enter-address.input}}?",
      "transitions": { "yes": "execute-send", "no": "cancelled" }
    },
    "execute-send": {
      "type": "info",
      "content": "Sending...",
      "toolCall": {
        "name": "wallet_send",
        "params": {
          "address": "{{data.enter-address.input}}",
          "amount": "{{data.enter-amount.input}}"
        }
      }
    }
  }
}
```

Validated at load time against a JSON schema (`schema/workflow.schema.json`).

## Surface Adapters

Each adapter translates primitives into channel-native UI:

| Adapter      | Renders as                                    |
| ------------ | --------------------------------------------- |
| **Telegram** | Inline keyboards, reply markup, edit-in-place |
| **Slack**    | Block Kit with buttons and modals             |
| **Text**     | Numbered lists with text input fallback       |

Adapters are installable packages — community-maintained, no review gate.

### Capability Negotiation

The `CapabilityNegotiator` detects what each surface supports:

```typescript
interface SurfaceCapabilities {
  supportsButtons: boolean;
  supportsMultiSelect: boolean;
  supportsEditInPlace: boolean;
  supportsMedia: boolean;
  maxButtonsPerRow: number;
  maxOptionsBeforeCollapse: number;
}
```

The engine auto-degrades: buttons → numbered text lists, media → file links, etc.

## Workflow Engine

The engine is a state machine that:

- **Registers** workflow definitions (validates JSON schema)
- **Starts** workflows (creates state, renders first step)
- **Handles transitions** (user input → next step)
- **Executes tool calls** (with param mapping from collected data)
- **Manages state** (TTL expiry, back navigation, cancel)
- **Guards concurrency** (first action wins on race conditions)

### State Management

Each active workflow has a `WorkflowState`:

```typescript
interface WorkflowState {
  id: string;
  workflowId: string;
  currentStepId: string;
  data: Record<string, StepData>;
  createdAt: string;
  expiresAt: string;
  status: "active" | "completed" | "cancelled" | "expired";
}
```

### Tool Bridge

The `tool-bridge.ts` maps workflow tool calls to OpenClaw's agent tool system. When a workflow step has a `toolCall`, the engine:

1. Resolves `{{data.*}}` templates against collected step data
2. Invokes the tool via the plugin's registered handler
3. Routes success/error to the appropriate next step

## Available Workflows

### Wallet (`wallet`)

| Workflow                | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `wallet-send`           | Send DOGE (address → amount → reason → confirm → execute) |
| `wallet-balance`        | Check balance                                             |
| `wallet-history`        | Transaction history with pagination                       |
| `wallet-onboarding`     | First-time setup                                          |
| `wallet-invoice`        | Generate payment request                                  |
| `wallet-verify-payment` | Verify incoming payment                                   |

### Brain (`brain`)

| Workflow       | Description               |
| -------------- | ------------------------- |
| `brain-drop`   | Save a knowledge drop     |
| `brain-search` | Search brain with filters |
| `brain-dnd`    | Toggle do-not-disturb     |
| `brain-fix`    | Repair brain data         |

### Ark (`ark`)

| Workflow      | Description             |
| ------------- | ----------------------- |
| `ark-backup`  | Create encrypted backup |
| `ark-restore` | Restore from backup     |
| `ark-status`  | Backup status overview  |

### Ledger (`ledger`)

| Workflow                    | Description               |
| --------------------------- | ------------------------- |
| `ledger-report`             | Generate financial report |
| `ledger-transaction-search` | Search transactions       |
| `ledger-statement-import`   | Import bank statements    |
| `ledger-budget-setup`       | Set up budgets            |
| `ledger-bill-management`    | Manage recurring bills    |

### Heal (`heal`)

| Workflow            | Description            |
| ------------------- | ---------------------- |
| `heal-health-check` | Run health diagnostics |
| `heal-repair`       | Repair workflow        |

### Identity (`identity`)

| Workflow            | Description              |
| ------------------- | ------------------------ |
| `identity-generate` | Generate agent identity  |
| `identity-link`     | Link identity to channel |

### OpenCore (`opencore`)

| Workflow          | Description            |
| ----------------- | ---------------------- |
| `opencore-status` | Gateway status         |
| `opencore-config` | Configuration wizard   |
| `opencore-update` | Update check and apply |

## Architecture

```
src/abstraction/
├── adapter.ts                    — Surface adapter interface
├── primitives.ts                 — 6 interaction primitives
├── engine.ts                     — Workflow state machine
├── state.ts                      — State persistence
├── router.ts                     — Route user actions to workflows
├── negotiator.ts                 — Capability detection
├── tool-bridge.ts                — Tool call execution bridge
├── bootstrap.ts                  — Registration and startup
├── hooks.ts                      — Plugin integration hooks
├── telegram-provider-bridge.ts   — Telegram-specific provider bridge
├── index.ts                      — Public API
├── adapters/
│   ├── telegram/                 — Telegram surface adapter
│   ├── slack/                    — Slack surface adapter
│   └── text/                     — Plain text fallback adapter
├── identity/                     — Cross-channel identity service
├── schema/                       — JSON schema validation
├── types/                        — TypeScript type definitions
└── workflows/                    — JSON workflow definitions
    ├── ark/                      — Ark backup/restore workflows
    ├── brain/                    — Brain knowledge workflows
    ├── heal/                     — Self-healing workflows
    ├── identity/                 — Identity management
    ├── ledger/                   — Accounting workflows
    ├── opencore/                 — System management
    └── wallet/                   — DOGE wallet workflows
```

## Adding a New Workflow

1. Create a JSON file in `src/abstraction/workflows/<plugin>/`
2. Define steps using the 6 primitives
3. Add tool call bindings for execution steps
4. Register in the plugin's `index.ts`
5. The engine handles rendering, state, and transitions automatically

## Adding a New Surface Adapter

1. Implement the `SurfaceAdapter` interface
2. Map each primitive type to your channel's native UI
3. Register in `src/abstraction/adapters/`
4. The negotiator auto-detects capabilities
