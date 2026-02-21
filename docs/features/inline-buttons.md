# Inline Button Directives

Agents can attach interactive inline buttons to their replies using a simple directive syntax.

## Syntax

Add one or more `[[buttons:]]` directives anywhere in the reply text:

```
Here's your report.

[[buttons: ✅ Approve:/approve 123, ❌ Reject:/reject 123]]
[[buttons: 📊 Details:/details 123]]
```

Each directive becomes one row of buttons. The directive text is stripped from the displayed message.

## Format

```
[[buttons: Label1:/callback1, Label2:/callback2]]
```

- **Label** — Button text shown to the user
- **Callback** — Command triggered when tapped (sent as a message)

## Auto-Stacking

When button labels in a row exceed 30 characters total, they automatically stack vertically (one button per row) for better mobile readability.

## Channel Support

| Channel  | Support                                            |
| -------- | -------------------------------------------------- |
| Telegram | ✅ Inline keyboard buttons                         |
| Discord  | ✅ Action row buttons                              |
| Other    | Graceful degradation (buttons stripped, text-only) |

## Usage by Features

- **Self-Healing Pipeline** — Approve/Reject buttons on approval requests
- **Deploy workflow** — Deploy & Restart / Skip buttons
- **Healing reports** — Dismiss buttons on completion notifications
- **/heal list** — Per-approval approve/reject buttons

## Architecture

```
src/auto-reply/reply/route-reply.ts  — Parses [[buttons:]] directives
src/telegram/send.ts                 — Renders as Telegram inline keyboard
```
