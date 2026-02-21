# OpenCore Roadmap

Planned features and priorities for OpenCore — Quackstro's customized fork of OpenClaw.

---

## 🚧 Planned

### Prompt Clarification Gate (Ambiguity Analyzer)

**Status:** Proposed  
**Priority:** Medium  
**Effort:** ~2-3 days  
**Added:** 2026-02-21

#### Problem

LLMs often execute on ambiguous or incomplete prompts, wasting tokens and time solving the wrong problem. Users don't get a chance to steer before the agent "runs off" on a misinterpretation.

#### Solution

Add a pre-flight **Prompt Clarification Gate** that analyzes user input for ambiguity before main LLM processing. When ambiguity is detected, prompt the user to clarify before execution proceeds.

#### Detection Triggers

- **Vague references**: "do that thing", "fix it", "update this"
- **Missing critical parameters**: "send money" (no recipient/amount)
- **Scope ambiguity**: "clean up the code", "refactor auth"
- **Multiple valid interpretations**: Could reasonably mean 2+ different actions
- **Dangerous operations without specifics**: Destructive commands lacking details

#### Architecture

```
User prompt
     ↓
┌─────────────────────┐
│  Prompt Guard       │ ← Pattern matching + optional fast model
│  (pre-processor)    │
└─────────────────────┘
     ↓
[Ambiguous?]──Yes──→ Clarification prompt to user
     │                        ↓
     No               User response appended
     ↓                        ↓
Main LLM processing ←─────────┘
```

#### Implementation Phases

| Phase | Description                                        | Depends On       |
| ----- | -------------------------------------------------- | ---------------- |
| 1     | Pattern-based detection (`prompt-guard` extension) | —                |
| 2     | Brain context auto-resolution                      | Brain search API |
| 3     | Skill-level `required_context` declarations        | Skill schema     |
| 4     | Plan-first mode with inline confirmation buttons   | Phase 1          |

#### Configuration (proposed)

```yaml
plugins:
  prompt-guard:
    enabled: true
    mode: balanced # strict | balanced | permissive
    auto_resolve_from_brain: true
    plan_first_patterns:
      - "refactor"
      - "delete"
      - "send.*DOGE"
    skip_for_channels:
      - cron
```

#### Success Criteria

- [ ] Ambiguous prompts trigger clarification 90%+ of the time
- [ ] Clear prompts pass through with <50ms latency overhead
- [ ] Brain auto-resolution reduces unnecessary clarifications by 30%+
- [ ] No false positives blocking obvious/clear commands

#### Open Questions

1. Should clarification be skippable via prefix? (e.g., `! just do it`)
2. How to handle multi-turn clarification?
3. Cache clarification patterns per-user to learn their style?

---

## ✅ Completed

<!-- Move completed features here with completion date -->

---

## 💡 Ideas (Unscoped)

<!-- Capture raw ideas that need scoping before becoming planned features -->
