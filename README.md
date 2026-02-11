# 🥚 Opencore

**Quackstro's fork of [OpenClaw](https://github.com/openclaw/openclaw)** — a personal AI assistant you run on your own devices.

Opencore tracks upstream OpenClaw and contributes patches back. The real magic lives in the **plugins** below — they extend OpenClaw with a semantic memory layer, a self-custodial crypto wallet, and encrypted backups.

---

## 🧩 Plugins

These are standalone OpenClaw plugins built by [Quackstro](https://github.com/Quackstro). Install them in any OpenClaw instance.

### 🧠 [Brain](https://github.com/Quackstro/openclaw-brain)

A behavioral support system for OpenClaw. Drop thoughts in natural language and Brain auto-classifies them into semantic buckets (people, projects, ideas, goals, health, finance, and more). Features:

- **Semantic search** across all memory buckets
- **Scheduled digests** — morning, midday, afternoon, night, weekly
- **Payment pipeline** — detect payment intent from natural language, resolve recipients, apply policy gates, and execute via the wallet plugin
- **Do Not Disturb** mode with deferred digest delivery
- **Action tracking** with audit trails

```bash
openclaw plugin install @quackstro/brain
```

### 🐕 [DOGE Wallet](https://github.com/Quackstro/openclaw-doge-wallet)

Self-custodial Dogecoin wallet for OpenClaw. Your keys, your coins — the assistant just helps manage them.

- **BIP39 mnemonic** generation with encrypted keystore
- **Send & receive** DOGE with policy-tiered spending limits
- **Auto-lock** after configurable idle timeout
- **Transaction tracking** with on-chain confirmation notifications
- **Invoice system** with OP_RETURN verification for agent-to-agent payments
- **Balance alerts** with inline snooze/dismiss buttons

```bash
openclaw plugin install @quackstro/doge-wallet
```

### 🚢 [Ark](https://github.com/Quackstro/openclaw-ark)

Encrypted backup & restore for OpenClaw. One command to snapshot your configs, plugins, brain data, wallet, and workspace.

- **AES-256 encryption** with passphrase
- **Selective restore** — pick which categories to bring back
- **Dry-run mode** to preview before restoring
- **Retention policies** for automatic cleanup

```bash
openclaw plugin install @quackstro/ark
```

---

## 🔧 Fork Details

This repo is a fork of [openclaw/openclaw](https://github.com/openclaw/openclaw) (MIT license). We stay close to upstream `main` and submit improvements as PRs:

- [#11904](https://github.com/openclaw/openclaw/pull/11904) — Pass `chatId`/`messageId` to plugin command handlers (enables passphrase scrubbing)

For installation, configuration, and usage, see the [upstream docs](https://docs.openclaw.ai).

---

## 💛 Support

If these plugins are useful to you, consider sending a few DOGE:

```
D6i8TeepmrGztENxdME84d2x5UVjLWncat
```

Built with 🦆 by [Quackstro](https://github.com/Quackstro)
