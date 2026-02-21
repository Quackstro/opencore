# Host Security Healthcheck (`/healthcheck`)

Run OpenClaw's security audit directly from chat. Scans configuration, file permissions, network exposure, and channel security.

## Commands

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `/healthcheck`      | Run security audit                                   |
| `/healthcheck deep` | Include live gateway probe                           |
| `/healthcheck fix`  | Apply safe remediations (file permissions, defaults) |

## What It Checks

The audit inspects:

- **Gateway exposure** — Bind address, auth mode, token/password presence
- **File permissions** — Config files, credentials, state directory
- **Channel security** — Per-channel allowFrom, webhook secrets, DM policies
- **Hooks hardening** — Token auth, session key override restrictions
- **Sandbox config** — Docker/sandbox settings, dangerous overrides
- **Model hygiene** — Small model risks, profile overrides
- **Plugin trust** — Installed plugins, code safety, manifest signatures
- **Secrets in config** — API keys or tokens in plaintext config fields
- **Attack surface** — Exposure matrix across all configured surfaces

## Report Format

Findings are grouped by severity:

- 🔴 **Critical** — Immediate security risk (shown with remediation steps)
- 🟡 **Warning** — Potential vulnerability or misconfiguration
- ℹ️ **Info** — Recommendations and best practices

## Deep Scan

`/healthcheck deep` additionally probes the live gateway:

- WebSocket connectivity
- Auth negotiation
- TLS status
- Response timing

## Auto-Fix

`/healthcheck fix` applies safe, non-destructive remediations:

- Tightens file permissions on config and state directories
- Sets secure defaults for OpenClaw configuration
- Does **not** modify host firewall, SSH, or OS settings

## CLI Equivalent

The same audit is available via CLI:

```bash
openclaw security audit          # Standard scan
openclaw security audit --deep   # With gateway probe
openclaw security audit --fix    # Apply safe fixes
openclaw security audit --json   # Machine-readable output
```

## Related

- [Self-Healing Pipeline](self-healing.md) — Security audit findings can trigger the heal pipeline
- [OpenClaw Security Guide](https://docs.openclaw.ai/gateway/security) — Upstream security documentation
