# Deploy Command (`/deploy`)

Standardized deploy workflow with user approval via inline buttons. Prevents surprise restarts that kill active sessions.

## Usage

The deploy flow is designed for agent-driven development:

1. Agent makes source changes and runs `pnpm run build`
2. Agent sends a summary with deploy buttons:
   - 🚀 **Deploy & Restart** — Restarts the gateway with the new build
   - ⏭️ **Skip** — Defers the restart
3. User taps to approve or skip

## Why

- `SIGUSR1` only restarts from existing `dist/` — it does **not** rebuild
- Direct `gateway restart` during active sessions kills all conversations
- The deploy button pattern gives the user control over when disruption happens

## Commands

| Command           | Description                               |
| ----------------- | ----------------------------------------- |
| `/deploy_restart` | Execute the restart (triggered by button) |
| `/skip_deploy`    | Dismiss the deploy prompt                 |

## Architecture

```
src/auto-reply/reply/commands-deploy.ts — Command handler
```
