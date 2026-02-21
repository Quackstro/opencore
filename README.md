# OpenCore

**OpenCore** is [Quackstro's](https://github.com/Quackstro) customized fork of [OpenClaw](https://github.com/openclaw/openclaw) — an open-source personal AI assistant. This fork adds self-healing infrastructure, host security auditing, enhanced plugin APIs, and deployment tooling on top of the upstream project.

> **Upstream:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw) · [docs.openclaw.ai](https://docs.openclaw.ai) · [Discord](https://discord.gg/clawd)

> 💛 **Like OpenCore?** Tips help keep development going: `D6i8TeepmrGztENxdME84d2x5UVjLWncat` (DOGE) — _Much fork. Very heal. Such secure. Wow._ 🐕

## What's Different

OpenCore tracks upstream `openclaw/main` and layers the following on top:

### 🩺 [Self-Healing Pipeline](docs/features/self-healing.md)

Autonomous error detection and resolution. Monitors logs and diagnostic events, auto-resolves known patterns, and dispatches AI healing agents for unresolved issues — with a human-in-the-loop approval gate.

- `/heal list` · `/heal approve` · `/heal reject` · `/heal clear`
- `/heal history` · `/heal search` · `/heal report`
- Persistent approvals (never expire), structured reports, Telegram inline buttons
- Configurable approval gate: `always` · `high-only` · `medium-and-above` · `off`

### 🛡️ [Host Security Healthcheck](docs/features/healthcheck.md)

Run OpenClaw's security audit directly from chat. Scans config, file permissions, network exposure, and channel security.

- `/healthcheck` · `/healthcheck deep` · `/healthcheck fix`
- Severity-grouped report (🔴 critical → 🟡 warn → ℹ️ info)
- Auto-fix for file permissions and secure defaults
- Deep scan with live gateway probe

### 🎛️ [UI Abstraction Layer](docs/features/ui-abstraction.md)

Channel-agnostic workflow engine. Define multi-step interactive UIs once in JSON, render them on any surface. 6 interaction primitives (choice, confirm, text-input, info, media, multi-choice), JSON-driven state machine, pluggable surface adapters.

- 30+ workflows across Wallet, Brain, Ark, Ledger, Heal, Identity, OpenCore
- Surface adapters: Telegram, Slack, text fallback
- Capability negotiation with automatic degradation
- Tool call execution with `{{data.stepId.field}}` templating

### 🔘 [Inline Button Directives](docs/features/inline-buttons.md)

Agents can attach interactive buttons to replies with `[[buttons: Label:/callback]]` syntax. Auto-stacks on mobile. Works on Telegram and Discord.

### 🚀 [Deploy Command](docs/features/deploy-command.md)

Agent-driven deploy workflow with user approval. Prevents surprise restarts — agents propose, humans approve.

### 🔌 [Plugin API Extensions](docs/features/plugin-apis.md)

Enhanced plugin system with callback handlers, message interceptors, URL buttons, and richer command context (`chatId`, `messageId`, `accountId`).

### Other Enhancements

- **Auto-coerce numeric strings in tool params** — Prevents type mismatch errors in agent tool calls
- **Workflow error handling** — Retry/cancel buttons on workflow failures, tool result display in success steps
- **Per-account Telegram routing** — Multi-account adapter routing for abstraction layer
- **Circular dependency patches** — Post-build `fix-circular-deps.py` for clean chunk splitting

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features and priorities.

## Extensions

OpenCore is deployed with these Quackstro plugins:

| Plugin                                                              | Description                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| [🚢 Ark](https://github.com/Quackstro/openclaw-ark)                 | Encrypted backup & restore (AES-256-GCM)              |
| [🧠 Brain](https://github.com/Quackstro/openclaw-brain)             | Knowledge management — drops, people, actions, memory |
| [🐕 DOGE Wallet](https://github.com/Quackstro/openclaw-doge-wallet) | Self-custodial Dogecoin wallet with P2P broadcasting  |
| [💰 Ledger](https://github.com/Quackstro/openclaw-ledger)           | Double-entry accounting with natural language         |

## Building

```bash
git clone https://github.com/Quackstro/opencore.git
cd opencore
pnpm install
pnpm run build
```

## Syncing with Upstream

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
git merge upstream/main
# Resolve conflicts, build, test
pnpm run build
```

## Configuration

See upstream docs for base configuration: [docs.openclaw.ai](https://docs.openclaw.ai)

OpenCore-specific config additions are documented in each feature's doc:

- [Self-Healing config](docs/features/self-healing.md#configuration)
- [Healthcheck usage](docs/features/healthcheck.md)

## License

MIT — [Quackstro LLC](https://quackstro.com)
