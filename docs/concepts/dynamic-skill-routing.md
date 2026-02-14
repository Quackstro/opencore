---
summary: "Dynamic skill routing: context-aware skill selection for optimized prompts"
read_when:
  - Implementing or extending the skill routing system
  - Understanding how skills are dynamically selected per-turn
  - Configuring routing modes or classification behavior
title: "Dynamic Skill Routing"
status: implemented
---

# Dynamic Skill Routing

> **Status**: ✅ Implemented  
> **Author**: OpenCore Team  
> **Created**: 2026-02-13  
> **Implemented**: 2026-02-13

## Implementation Status

| Component                  | Status    | Location                                           |
| -------------------------- | --------- | -------------------------------------------------- |
| Core Types                 | ✅ Done   | `src/agents/skills/routing/types.ts`               |
| Model Capability Registry  | ✅ Done   | `src/agents/skills/routing/model-capabilities.ts`  |
| Keywords Classifier        | ✅ Done   | `src/agents/skills/routing/keywords-classifier.ts` |
| Capability Filter          | ✅ Done   | `src/agents/skills/routing/capability-filter.ts`   |
| Skill Router               | ✅ Done   | `src/agents/skills/routing/router.ts`              |
| Thinking Resolver          | ✅ Done   | `src/agents/skills/routing/thinking-resolver.ts`   |
| Model Selector             | ✅ Done   | `src/agents/skills/routing/model-selector.ts`      |
| Task Skill Detector        | ✅ Done   | `src/agents/skills/routing/task-skill-detector.ts` |
| Workspace Integration      | ✅ Done   | `src/agents/skills/workspace.ts`                   |
| Agent Runner Integration   | ✅ Done   | `src/auto-reply/reply/get-reply-run.ts`            |
| sessions_spawn Integration | ✅ Done   | `src/agents/tools/sessions-spawn-tool.ts`          |
| skill:filter Hook          | ✅ Done   | `src/hooks/internal-hooks.ts`                      |
| CLI Commands               | ✅ Done   | `src/cli/skills-cli.ts`                            |
| Embeddings Classifier      | 🔮 Future | Stubs to keywords classifier                       |
| LLM Classifier             | 🔮 Future | Stubs to keywords classifier                       |

**Test Coverage:** 160+ tests across all modules

## Quick Start

### Enable Dynamic Routing

Add to `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    routing: {
      mode: "dynamic", // or "hybrid" for threshold-based
      dynamic: {
        classifier: "keywords",
        minConfidence: 0.3,
        maxSkills: 10,
      },
    },
  },
}
```

### Add Domains to Your Skills

```yaml
---
name: my-skill
description: Does something useful
metadata:
  {
    "openclaw":
      {
        "domains": ["coding", "devops"],
        "capabilities": ["tool-use"],
        "thinkingOverride": "medium",
        "thinkingOverrideMode": "minimum",
      },
  }
---
```

### Test Routing

```bash
# Test how a message would be routed
openclaw skills route "help me design a microservices architecture"

# See domain coverage across your skills
openclaw skills domains
```

---

Dynamic skill routing is a context-aware system that analyzes conversation content and selectively activates relevant skills, rather than injecting all eligible skills into every prompt.

## Problem Statement

Current behavior:

- All eligible skills are loaded at session start and injected into the system prompt
- The model sees every skill description regardless of conversation topic
- Token overhead grows linearly with skill count
- Model may be confused by irrelevant skill options

With 20+ skills enabled, the skills section alone can consume 2000+ tokens, and the model must parse through unrelated capabilities (e.g., seeing "wine cellar inventory" skills during a coding conversation).

## Goals

1. **Reduce token overhead** — Only inject skills relevant to the current context
2. **Improve signal clarity** — Less noise means better skill selection by the model
3. **Enable specialist skill packs** — Allow installing large domain-specific skill collections without overwhelming context
4. **Maintain backwards compatibility** — Static mode remains the default; dynamic routing is opt-in

## Non-Goals

- Replacing the existing skill gating system (bins/env/config requirements)
- Automatic skill installation or discovery
- Cross-session skill learning (each session starts fresh)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent Turn Start                            │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    1. Load Eligible Skills                          │
│         (existing: bins/env/config/os gating via shouldIncludeSkill)│
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    2. Skill Router (NEW)                            │
│                                                                     │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐            │
│   │   Static    │    │   Dynamic   │    │   Hybrid    │            │
│   │   (bypass)  │    │ (classify)  │    │ (threshold) │            │
│   └─────────────┘    └─────────────┘    └─────────────┘            │
│                             │                                       │
│                             ▼                                       │
│              ┌──────────────────────────┐                          │
│              │   Intent Classifier      │                          │
│              │   - Embeddings match     │                          │
│              │   - Keyword heuristics   │                          │
│              │   - LLM classification   │                          │
│              └──────────────────────────┘                          │
│                             │                                       │
│                             ▼                                       │
│              ┌──────────────────────────┐                          │
│              │   Domain → Skills Map    │                          │
│              │   coding: [claude-code]  │                          │
│              │   legal: [paralegal]     │                          │
│              │   finance: [accountant]  │                          │
│              └──────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    3. skill:filter Hook                             │
│         (plugins can override or extend routing decisions)          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    4. Format Skills for Prompt                      │
│              (existing: formatSkillsForPrompt with filtered list)   │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         System Prompt Assembly                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Foundation (Core Changes)

#### 1.1 Skill Domain Metadata

Extend `metadata.openclaw` in SKILL.md frontmatter:

```yaml
---
name: claude-code
description: Run Claude Code for coding assistance
metadata:
  {
    "openclaw":
      {
        "domains": ["coding", "development", "programming"],
        "domainWeight": 1.0,
        "alwaysInclude": false,
      },
  }
---
```

New fields:

- `domains`: Array of domain tags this skill belongs to
- `domainWeight`: Optional weight (0.0-1.0) for ranking within a domain (default: 1.0)
- `alwaysInclude`: If true, skill is always injected regardless of routing (default: false)
- `capabilities`: Array of required LLM capabilities (see Capability Tags below)

#### 1.2 Capability Tags

Skills can declare required LLM capabilities via `metadata.openclaw.capabilities`:

```yaml
---
name: image-analyzer
description: Analyze and describe images using vision models
metadata:
  {
    "openclaw":
      {
        "domains": ["media", "research"],
        "capabilities": ["vision"],
        "preferredModel": "anthropic/claude-sonnet-4",
      },
  }
---
```

```yaml
---
name: deep-code-review
description: In-depth code analysis with extended thinking
metadata:
  {
    "openclaw":
      {
        "domains": ["coding"],
        "capabilities": ["thinking", "long-context"],
        "preferredModel": "anthropic/claude-opus-4",
        "minThinkingBudget": "medium",
      },
  }
---
```

**Canonical Capability Tags:**

| Tag                 | Description                         | Example Models                       |
| ------------------- | ----------------------------------- | ------------------------------------ |
| `vision`            | Can process images/screenshots      | Claude 3+, GPT-4V, Gemini Pro Vision |
| `thinking`          | Extended reasoning/chain-of-thought | Claude with thinking, o1, o3         |
| `moe`               | Mixture of experts architecture     | Mixtral, GPT-4, DeepSeek MoE         |
| `long-context`      | >100k token context window          | Claude 3+, Gemini 1.5                |
| `tool-use`          | Native function/tool calling        | Most modern models                   |
| `streaming`         | Supports streaming responses        | Most models                          |
| `json-mode`         | Structured JSON output mode         | GPT-4+, Claude 3+, Gemini            |
| `code-execution`    | Can run code (sandbox)              | Code Interpreter, Gemini             |
| `web-search`        | Native web search integration       | Perplexity, Gemini, ChatGPT          |
| `multimodal-output` | Can generate images/audio           | GPT-4o, Gemini                       |

**Capability metadata fields:**

- `capabilities`: Required capabilities (skill hidden if model lacks them)
- `preferredModel`: Suggested model for sub-agent execution
- `minThinkingBudget`: Minimum thinking level (`low`, `medium`, `high`) for thinking-capable models
- `fallbackCapabilities`: Alternative capability sets (OR logic)
- `thinkingOverride`: Auto-apply this thinking level when skill is invoked (see below)

#### Automatic Thinking Level Override

Skills can declare a thinking level that OpenClaw automatically applies when the skill is invoked:

```yaml
---
name: architecture-designer
description: Design system architectures with deep analysis
metadata:
  {
    "openclaw":
      {
        "domains": ["coding", "devops"],
        "capabilities": ["thinking"],
        "thinkingOverride": "high",
        "thinkingOverrideMode": "minimum",
      },
  }
---
```

```yaml
---
name: quick-lookup
description: Fast web searches - no deep reasoning needed
metadata:
  {
    "openclaw":
      { "domains": ["research"], "thinkingOverride": "off", "thinkingOverrideMode": "exact" },
  }
---
```

**Override modes:**

| Mode      | Behavior                                               |
| --------- | ------------------------------------------------------ |
| `minimum` | Use skill's level if current is lower (upgrade only)   |
| `maximum` | Use skill's level if current is higher (cap/downgrade) |
| `exact`   | Always use skill's level (override user preference)    |
| `suggest` | Inject a hint but don't override (default)             |

**Resolution order with skill overrides:**

1. Skill `thinkingOverride` with `exact` mode (highest priority)
2. User inline directive (`/think:high do this`)
3. Skill `thinkingOverride` with `minimum`/`maximum` mode
4. Session override (from `/think:medium`)
5. Global default (`agents.defaults.thinkingDefault`)
6. Fallback: `low` for reasoning models, `off` otherwise

**Example scenarios:**

| User Level | Skill Override | Mode      | Result               |
| ---------- | -------------- | --------- | -------------------- |
| `low`      | `high`         | `minimum` | `high` (upgraded)    |
| `high`     | `medium`       | `minimum` | `high` (kept higher) |
| `high`     | `low`          | `maximum` | `low` (capped)       |
| `medium`   | `high`         | `exact`   | `high` (forced)      |
| `off`      | `medium`       | `suggest` | `off` (hint only)    |

**Implementation:**

```typescript
// src/agents/skills/routing/thinking-resolver.ts

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingOverrideMode = "minimum" | "maximum" | "exact" | "suggest";

const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function compareLevels(a: ThinkingLevel, b: ThinkingLevel): number {
  return THINKING_ORDER.indexOf(a) - THINKING_ORDER.indexOf(b);
}

export function resolveThinkingWithSkill(
  currentLevel: ThinkingLevel,
  skill: SkillEntry | undefined,
): { level: ThinkingLevel; reason: string; hint?: string } {
  if (!skill?.metadata?.thinkingOverride) {
    return { level: currentLevel, reason: "no skill override" };
  }

  const override = skill.metadata.thinkingOverride as ThinkingLevel;
  const mode = (skill.metadata.thinkingOverrideMode ?? "suggest") as ThinkingOverrideMode;

  switch (mode) {
    case "exact":
      return {
        level: override,
        reason: `skill ${skill.skill.name} requires ${override} thinking`,
      };

    case "minimum":
      if (compareLevels(currentLevel, override) < 0) {
        return {
          level: override,
          reason: `upgraded to ${override} for ${skill.skill.name}`,
        };
      }
      return { level: currentLevel, reason: "current level meets minimum" };

    case "maximum":
      if (compareLevels(currentLevel, override) > 0) {
        return {
          level: override,
          reason: `capped to ${override} for ${skill.skill.name}`,
        };
      }
      return { level: currentLevel, reason: "current level within maximum" };

    case "suggest":
    default:
      return {
        level: currentLevel,
        reason: "skill suggests level but doesn't override",
        hint: `${skill.skill.name} works best with thinking:${override}`,
      };
  }
}
```

**Integration point:**

The thinking resolver runs after skill routing, before the agent turn starts:

```typescript
// In agent-runner or equivalent

const routedSkills = await routeSkills(eligibleSkills, context, config);
const primarySkill = detectPrimarySkill(message, routedSkills);

if (primarySkill) {
  const { level, reason, hint } = resolveThinkingWithSkill(currentThinkingLevel, primarySkill);

  if (level !== currentThinkingLevel) {
    logger.info("thinking-auto-override", {
      from: currentThinkingLevel,
      to: level,
      skill: primarySkill.skill.name,
      reason,
    });
    effectiveThinkingLevel = level;
  }

  if (hint) {
    // Inject hint into context for the model
    injectThinkingHint(hint);
  }
}
```

#### 1.3 Model Capability Registry

OpenCore maintains a capability registry for known models:

```typescript
// src/agents/skills/routing/model-capabilities.ts

export const MODEL_CAPABILITIES: Record<string, string[]> = {
  "anthropic/claude-opus-4": [
    "vision",
    "thinking",
    "long-context",
    "tool-use",
    "streaming",
    "json-mode",
  ],
  "anthropic/claude-sonnet-4": [
    "vision",
    "thinking",
    "long-context",
    "tool-use",
    "streaming",
    "json-mode",
  ],
  "anthropic/claude-haiku": ["vision", "tool-use", "streaming", "json-mode"],
  "openai/gpt-4o": ["vision", "tool-use", "streaming", "json-mode", "multimodal-output"],
  "openai/o1": ["thinking", "long-context"],
  "openai/o3": ["thinking", "long-context", "tool-use"],
  "google/gemini-2.0-flash": [
    "vision",
    "long-context",
    "tool-use",
    "streaming",
    "code-execution",
    "web-search",
  ],
  "deepseek/deepseek-r1": ["thinking", "moe", "long-context"],
  "mistral/mixtral-8x22b": ["moe", "tool-use", "streaming"],
  // ... extensible via config
};

export function modelHasCapabilities(modelId: string, required: string[]): boolean {
  const caps = MODEL_CAPABILITIES[modelId] ?? [];
  return required.every((req) => caps.includes(req));
}
```

Users can extend via config:

```json5
{
  models: {
    capabilities: {
      "local/my-fine-tune": ["vision", "tool-use"],
      "anthropic/claude-opus-4": {
        // Override or extend
        add: ["custom-cap"],
        remove: ["web-search"],
      },
    },
  },
}
```

#### 1.4 Configuration Schema

Add to `openclaw.json`:

```json5
{
  skills: {
    routing: {
      // Routing mode: static (all eligible), dynamic (classified), hybrid (threshold)
      mode: "static", // "static" | "dynamic" | "hybrid"

      // Dynamic mode settings
      dynamic: {
        // Classification method
        classifier: "embeddings", // "embeddings" | "keywords" | "llm"

        // Max skills to inject per turn (0 = unlimited)
        maxSkills: 10,

        // Minimum confidence score to include a skill (0.0-1.0)
        minConfidence: 0.3,

        // Include skills with alwaysInclude: true regardless of classification
        respectAlwaysInclude: true,

        // Cache classification results per-session
        cachePerSession: true,

        // LLM classifier settings (when classifier: "llm")
        llm: {
          model: "anthropic/claude-haiku",
          maxTokens: 100,
        },
      },

      // Hybrid mode settings
      hybrid: {
        // Use static routing when eligible skills <= threshold
        staticThreshold: 5,
        // Fall back to dynamic when above threshold
        dynamicAboveThreshold: true,
      },

      // Domain aliases (map custom terms to canonical domains)
      domainAliases: {
        frontend: ["coding", "ui-design"],
        backend: ["coding", "devops"],
        contracts: ["legal"],
      },
    },
  },
}
```

#### 1.3 Core Types

Add to `src/agents/skills/types.ts`:

```typescript
export interface SkillRoutingConfig {
  mode: "static" | "dynamic" | "hybrid";
  dynamic?: {
    classifier: "embeddings" | "keywords" | "llm";
    maxSkills?: number;
    minConfidence?: number;
    respectAlwaysInclude?: boolean;
    cachePerSession?: boolean;
    llm?: {
      model?: string;
      maxTokens?: number;
    };
  };
  hybrid?: {
    staticThreshold?: number;
    dynamicAboveThreshold?: boolean;
  };
  domainAliases?: Record<string, string[]>;
}

export interface SkillClassification {
  skillName: string;
  domains: string[];
  confidence: number;
  reason?: string;
}

export interface RoutingContext {
  message: string;
  conversationHistory?: string[];
  sessionKey?: string;
  detectedDomains?: string[];
}

export interface RoutingResult {
  selectedSkills: string[];
  classifications: SkillClassification[];
  method: "static" | "dynamic" | "hybrid";
  cached: boolean;
}
```

### Phase 2: Classifiers

#### 2.1 Embeddings Classifier

Uses vector similarity between message content and skill domain descriptions.

```typescript
// src/agents/skills/routing/embeddings-classifier.ts

export async function classifyWithEmbeddings(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
): Promise<SkillClassification[]> {
  // 1. Generate embedding for the input message
  const messageEmbedding = await generateEmbedding(context.message);

  // 2. For each skill, compute similarity against domain descriptions
  const classifications: SkillClassification[] = [];

  for (const skill of skills) {
    const domains = skill.metadata?.domains ?? [];
    const description = skill.skill.description ?? "";

    // Combine domains and description for matching
    const skillText = [...domains, description].join(" ");
    const skillEmbedding = await generateEmbedding(skillText);

    const similarity = cosineSimilarity(messageEmbedding, skillEmbedding);

    classifications.push({
      skillName: skill.skill.name,
      domains,
      confidence: similarity,
    });
  }

  return classifications.sort((a, b) => b.confidence - a.confidence);
}
```

#### 2.2 Keywords Classifier

Fast, zero-latency classification using keyword matching and domain aliases.

```typescript
// src/agents/skills/routing/keywords-classifier.ts

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  coding: ["code", "program", "function", "debug", "error", "api", "implement"],
  legal: ["contract", "agreement", "liability", "clause", "attorney", "lawsuit"],
  finance: ["invoice", "payment", "budget", "expense", "tax", "accounting"],
  "ui-design": ["ui", "ux", "design", "layout", "component", "interface", "frontend"],
  devops: ["deploy", "server", "docker", "kubernetes", "ci/cd", "infrastructure"],
  writing: ["write", "draft", "edit", "proofread", "article", "blog", "content"],
  research: ["search", "find", "lookup", "investigate", "analyze", "report"],
};

export function classifyWithKeywords(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
): SkillClassification[] {
  const messageLower = context.message.toLowerCase();
  const detectedDomains = new Set<string>();

  // Detect domains from message keywords
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (messageLower.includes(keyword)) {
        detectedDomains.add(domain);
        // Also add aliased domains
        const aliases = config.domainAliases?.[domain] ?? [];
        aliases.forEach((d) => detectedDomains.add(d));
      }
    }
  }

  // Score skills based on domain overlap
  return skills
    .map((skill) => {
      const skillDomains = skill.metadata?.domains ?? [];
      const overlap = skillDomains.filter((d) => detectedDomains.has(d)).length;
      const confidence = skillDomains.length > 0 ? overlap / skillDomains.length : 0;

      return {
        skillName: skill.skill.name,
        domains: skillDomains,
        confidence,
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
}
```

#### 2.3 LLM Classifier

Uses a fast, small model to classify intent and select domains.

```typescript
// src/agents/skills/routing/llm-classifier.ts

const CLASSIFICATION_PROMPT = `You are a skill router. Given a user message and available skill domains, output which domains are relevant.

Available domains: {domains}

User message: {message}

Output a JSON array of relevant domain names, ordered by relevance. Only include domains that are clearly relevant.
Example: ["coding", "devops"]

Relevant domains:`;

export async function classifyWithLLM(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
): Promise<SkillClassification[]> {
  // Collect all unique domains from skills
  const allDomains = new Set<string>();
  for (const skill of skills) {
    (skill.metadata?.domains ?? []).forEach((d) => allDomains.add(d));
  }

  const prompt = CLASSIFICATION_PROMPT.replace(
    "{domains}",
    Array.from(allDomains).join(", "),
  ).replace("{message}", context.message);

  const model = config.dynamic?.llm?.model ?? "anthropic/claude-haiku";
  const response = await llmCall(model, prompt, {
    maxTokens: config.dynamic?.llm?.maxTokens ?? 100,
  });

  // Parse JSON response
  const detectedDomains = JSON.parse(response) as string[];

  // Score skills
  return skills
    .map((skill) => {
      const skillDomains = skill.metadata?.domains ?? [];
      const domainIndex = skillDomains.findIndex((d) => detectedDomains.includes(d));
      const confidence =
        domainIndex >= 0 ? 1.0 - detectedDomains.indexOf(skillDomains[domainIndex]) * 0.1 : 0;

      return {
        skillName: skill.skill.name,
        domains: skillDomains,
        confidence,
        reason: domainIndex >= 0 ? `Matched domain: ${skillDomains[domainIndex]}` : undefined,
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
}
```

### Phase 3: Router Integration

#### 3.1 Skill Router Module

```typescript
// src/agents/skills/routing/router.ts

export async function routeSkills(
  eligibleSkills: SkillEntry[],
  context: RoutingContext,
  config: OpenClawConfig,
): Promise<RoutingResult> {
  const routingConfig = config.skills?.routing;
  const mode = routingConfig?.mode ?? "static";

  // Static mode: return all eligible skills
  if (mode === "static") {
    return {
      selectedSkills: eligibleSkills.map((s) => s.skill.name),
      classifications: [],
      method: "static",
      cached: false,
    };
  }

  // Hybrid mode: check threshold
  if (mode === "hybrid") {
    const threshold = routingConfig?.hybrid?.staticThreshold ?? 5;
    if (eligibleSkills.length <= threshold) {
      return {
        selectedSkills: eligibleSkills.map((s) => s.skill.name),
        classifications: [],
        method: "hybrid",
        cached: false,
      };
    }
  }

  // Dynamic classification
  const classifier = routingConfig?.dynamic?.classifier ?? "keywords";
  let classifications: SkillClassification[];

  switch (classifier) {
    case "embeddings":
      classifications = await classifyWithEmbeddings(context, eligibleSkills, routingConfig);
      break;
    case "llm":
      classifications = await classifyWithLLM(context, eligibleSkills, routingConfig);
      break;
    case "keywords":
    default:
      classifications = classifyWithKeywords(context, eligibleSkills, routingConfig);
  }

  // Apply filters
  const minConfidence = routingConfig?.dynamic?.minConfidence ?? 0.3;
  const maxSkills = routingConfig?.dynamic?.maxSkills ?? 0;
  const respectAlways = routingConfig?.dynamic?.respectAlwaysInclude ?? true;

  let selected = classifications.filter((c) => c.confidence >= minConfidence);

  if (maxSkills > 0 && selected.length > maxSkills) {
    selected = selected.slice(0, maxSkills);
  }

  // Add alwaysInclude skills
  if (respectAlways) {
    for (const skill of eligibleSkills) {
      if (
        skill.metadata?.alwaysInclude &&
        !selected.find((s) => s.skillName === skill.skill.name)
      ) {
        selected.push({
          skillName: skill.skill.name,
          domains: skill.metadata?.domains ?? [],
          confidence: 1.0,
          reason: "alwaysInclude flag",
        });
      }
    }
  }

  return {
    selectedSkills: selected.map((s) => s.skillName),
    classifications: selected,
    method: mode === "hybrid" ? "hybrid" : "dynamic",
    cached: false,
  };
}
```

#### 3.2 Integration Point

Modify `src/agents/skills/workspace.ts` to call the router:

```typescript
// In loadSkillsSnapshot or equivalent

export async function loadSkillsSnapshot(
  workspaceDir: string,
  opts: {
    config?: OpenClawConfig;
    routingContext?: RoutingContext; // NEW
  },
): Promise<SkillSnapshot> {
  // 1. Load all skill entries (existing)
  const allEntries = loadSkillEntries(workspaceDir, opts);

  // 2. Filter by eligibility (existing)
  const eligibleEntries = filterSkillEntries(allEntries, opts.config);

  // 3. Route skills (NEW)
  let finalEntries = eligibleEntries;
  if (opts.routingContext) {
    const routingResult = await routeSkills(eligibleEntries, opts.routingContext, opts.config);

    // Filter to only routed skills
    const selectedSet = new Set(routingResult.selectedSkills);
    finalEntries = eligibleEntries.filter((e) => selectedSet.has(e.skill.name));

    // Emit routing event for observability
    emitRoutingEvent(routingResult);
  }

  // 4. Build snapshot (existing)
  return buildSnapshot(finalEntries);
}
```

### Phase 4: Model-Aware Routing

#### 4.1 Capability Filtering

Before routing, filter skills by current model capabilities:

```typescript
// src/agents/skills/routing/capability-filter.ts

export function filterByCapabilities(
  skills: SkillEntry[],
  currentModel: string,
  config: OpenClawConfig,
): { eligible: SkillEntry[]; excluded: SkillExclusion[] } {
  const eligible: SkillEntry[] = [];
  const excluded: SkillExclusion[] = [];

  for (const skill of skills) {
    const required = skill.metadata?.capabilities ?? [];

    if (required.length === 0) {
      // No capability requirements
      eligible.push(skill);
      continue;
    }

    if (modelHasCapabilities(currentModel, required)) {
      eligible.push(skill);
    } else {
      excluded.push({
        skill: skill.skill.name,
        reason: "missing-capabilities",
        missing: required.filter((r) => !modelHasCapability(currentModel, r)),
        hint: skill.metadata?.preferredModel,
      });
    }
  }

  return { eligible, excluded };
}
```

#### 4.2 Sub-Agent Model Selection

When spawning a sub-agent for a skill, auto-select the appropriate model:

```typescript
// src/agents/skills/routing/model-selector.ts

export interface ModelSelection {
  model: string;
  thinking?: "low" | "medium" | "high";
  reason: string;
}

export function selectModelForSkill(
  skill: SkillEntry,
  availableModels: string[],
  currentModel: string,
  config: OpenClawConfig,
): ModelSelection {
  const required = skill.metadata?.capabilities ?? [];
  const preferred = skill.metadata?.preferredModel;
  const minThinking = skill.metadata?.minThinkingBudget;

  // 1. Try preferred model if available and capable
  if (preferred && availableModels.includes(preferred)) {
    if (required.length === 0 || modelHasCapabilities(preferred, required)) {
      return {
        model: preferred,
        thinking: minThinking,
        reason: `Skill preferred model: ${preferred}`,
      };
    }
  }

  // 2. Check if current model satisfies requirements
  if (required.length === 0 || modelHasCapabilities(currentModel, required)) {
    return {
      model: currentModel,
      thinking: minThinking,
      reason: "Current model satisfies requirements",
    };
  }

  // 3. Find best alternative from available models
  const candidates = availableModels
    .filter((m) => modelHasCapabilities(m, required))
    .sort((a, b) => {
      // Prefer models with more matching capabilities
      const aCaps = MODEL_CAPABILITIES[a]?.length ?? 0;
      const bCaps = MODEL_CAPABILITIES[b]?.length ?? 0;
      return bCaps - aCaps;
    });

  if (candidates.length > 0) {
    return {
      model: candidates[0],
      thinking: minThinking,
      reason: `Auto-selected for capabilities: ${required.join(", ")}`,
    };
  }

  // 4. Fallback to current model with warning
  return {
    model: currentModel,
    thinking: minThinking,
    reason: `WARNING: No model found with capabilities: ${required.join(", ")}`,
  };
}
```

#### 4.3 Integration with sessions_spawn

Modify sub-agent spawning to use model selection:

```typescript
// In sessions_spawn handler

const skillEntry = findSkillByName(task, eligibleSkills);

if (skillEntry && config.skills?.routing?.autoSelectModel !== false) {
  const selection = selectModelForSkill(
    skillEntry,
    getAvailableModels(config),
    currentModel,
    config,
  );

  // Override spawn params
  params.model = params.model ?? selection.model;
  params.thinking = params.thinking ?? selection.thinking;

  logger.info("sub-agent-model-selection", {
    skill: skillEntry.skill.name,
    selectedModel: selection.model,
    reason: selection.reason,
  });
}
```

#### 4.4 Capability Warnings in Prompt

When a skill is included but the model lacks soft requirements, inject a warning:

```typescript
// In formatSkillsForPrompt

function formatSkillWithWarnings(skill: SkillEntry, currentModel: string): string {
  const required = skill.metadata?.capabilities ?? [];
  const missing = required.filter((r) => !modelHasCapability(currentModel, r));

  let output = `<skill>
    <name>${skill.skill.name}</name>
    <description>${skill.skill.description}</description>
    <location>${skill.path}</location>`;

  if (missing.length > 0) {
    output += `
    <warning>This skill works best with: ${missing.join(", ")}. Consider spawning a sub-agent with ${skill.metadata?.preferredModel ?? "a capable model"}.</warning>`;
  }

  output += `
  </skill>`;

  return output;
}
```

### Phase 5: Hook System

#### 4.1 New Hook Type: `skill:filter`

Add to the hooks system:

```typescript
// src/hooks/types.ts

export interface SkillFilterEvent extends BaseHookEvent {
  type: "skill";
  action: "filter";
  eligibleSkills: SkillEntry[];
  routingContext: RoutingContext;
  routingResult: RoutingResult;
  // Hooks can mutate this to override routing
  selectedSkills: string[];
}
```

#### 4.2 Hook Integration

```typescript
// src/agents/skills/routing/router.ts

export async function routeSkills(
  eligibleSkills: SkillEntry[],
  context: RoutingContext,
  config: OpenClawConfig,
  hooks?: HookManager,
): Promise<RoutingResult> {
  // ... classification logic ...

  // Emit hook for plugin override
  if (hooks) {
    const event: SkillFilterEvent = {
      type: "skill",
      action: "filter",
      eligibleSkills,
      routingContext: context,
      routingResult: result,
      selectedSkills: result.selectedSkills,
      timestamp: new Date(),
      messages: [],
      context: {},
    };

    await hooks.trigger(event);

    // Apply hook mutations
    result.selectedSkills = event.selectedSkills;
  }

  return result;
}
```

### Phase 5: Observability & Debugging

#### 5.1 CLI Commands

```bash
# Show routing decision for a test message
openclaw skills route "help me write a contract for my app"

# Output:
# Routing mode: dynamic (embeddings)
# Detected domains: legal, coding
# Selected skills (3):
#   ✓ paralegal (0.89) - legal
#   ✓ claude-code (0.76) - coding
#   ✓ github (0.71) - coding
# Excluded skills (12):
#   ✗ wine-cellar (0.12)
#   ✗ weather (0.08)
#   ...

# Debug skill domain configuration
openclaw skills domains

# Output:
# Domain coverage:
#   coding (8 skills): claude-code, github, codex, ...
#   legal (2 skills): paralegal, contract-review
#   finance (1 skill): accountant
#   uncategorized (4 skills): weather, reminder, ...
```

#### 5.2 Logging

```typescript
// Structured logging for routing decisions
skillsLogger.info("skill-routing-complete", {
  mode: result.method,
  classifier: config.dynamic?.classifier,
  eligible: eligibleSkills.length,
  selected: result.selectedSkills.length,
  topDomains: result.classifications.slice(0, 3).map((c) => c.domains[0]),
  latencyMs: Date.now() - startTime,
});
```

#### 5.3 Session Metadata

Store routing decisions in session for debugging:

```typescript
session.metadata.lastRouting = {
  timestamp: new Date().toISOString(),
  selectedSkills: result.selectedSkills,
  method: result.method,
  classifications: result.classifications.slice(0, 5),
};
```

---

## Migration Path

### For Existing Users

1. Default remains `mode: "static"` — no behavior change
2. Users opt-in with `skills.routing.mode: "dynamic"`
3. Existing skill gating (bins/env/config) continues to work as a pre-filter

### For Skill Authors

1. Add `domains` to `metadata.openclaw` for routing eligibility
2. Skills without domains default to lowest priority in dynamic mode
3. Set `alwaysInclude: true` for critical utility skills

Example migration:

```yaml
# Before
---
name: my-skill
description: Does something useful
metadata: { "openclaw": { "requires": { "bins": ["mytool"] } } }
---
# After
---
name: my-skill
description: Does something useful
metadata:
  {
    "openclaw":
      { "requires": { "bins": ["mytool"] }, "domains": ["coding", "devops"], "domainWeight": 0.8 },
  }
---
```

---

## Performance Considerations

| Classifier | Latency   | Accuracy | Dependencies     |
| ---------- | --------- | -------- | ---------------- |
| Keywords   | <1ms      | Medium   | None             |
| Embeddings | 50-200ms  | High     | Embedding model  |
| LLM        | 200-500ms | Highest  | Fast LLM (Haiku) |

Recommendations:

- Use `keywords` for low-latency, many-skill scenarios
- Use `embeddings` for best balance of speed and accuracy
- Use `llm` only when classification quality is critical
- Enable `cachePerSession` to avoid re-classification on follow-up turns

---

## Future Enhancements

### Implemented ✅

**Batch 1:**

- ~~Dynamic model switching~~ → `selectModelForSkill()` auto-selects models for sub-agents
- ~~Thinking level auto-adjustment~~ → `resolveThinkingWithSkills()` handles override modes
- ~~Embeddings classifier~~ → `classifyWithEmbeddings()` for vector similarity matching
- ~~LLM classifier~~ → `classifyWithLLM()` uses fast models for intent classification
- ~~Domain tracking~~ → `getDomainTracker()` maintains domain state across turns
- ~~Conversation-aware routing~~ → `historyDepth` config uses full conversation history

**Batch 2:**

- ~~Skill groups~~ → `expandSkillGroups()` bundles related skills that activate together
- ~~User preferences~~ → `createUserPreferencesStore()` for per-user domain preferences
- ~~Capability cost awareness~~ → `selectModelCostAware()` factors in model costs
- ~~Capability detection~~ → `probeModelCapabilities()` auto-detects capabilities from model responses
- ~~Skill chaining~~ → `resolveDependencyChain()` for skills with dependencies

### Planned 🔮

1. **Cross-session learning** — Persist skill affinity scores across sessions
2. **Skill recommendation** — Suggest new skills based on usage patterns
3. **Cost budget enforcement** — Automatically downgrade models when approaching budget limits
4. **Capability negotiation** — Fallback strategies when preferred model unavailable

---

## Batch 2 Features Reference

### Skill Groups

Define skill bundles that activate together:

```json5
{
  skills: {
    routing: {
      skillGroups: {
        enabled: true,
        autoExpand: true,
        activateByDomain: true,
        groups: [
          {
            id: "full-stack",
            name: "Full-Stack Development",
            skills: ["claude-code", "github", "docker"],
            domains: ["coding", "devops"],
            activationThreshold: 0.5,
          },
          {
            id: "legal-suite",
            name: "Legal Suite",
            skills: ["paralegal", "contract-review", "compliance"],
            domains: ["legal"],
          },
        ],
      },
    },
  },
}
```

**Usage:**

```typescript
import { expandSkillGroups, detectGroupsFromDomains } from "./routing/skill-groups.js";

// Expand when one member is selected
const result = expandSkillGroups(["claude-code"], groups, config);
// result.skills: ["claude-code", "github", "docker"]

// Detect groups from domains
const matchedGroups = detectGroupsFromDomains(["coding"], groups);
```

### User Preferences

Per-user domain preferences with learning:

```json5
{
  skills: {
    routing: {
      userPreferences: {
        enabled: true,
        persistPath: "~/.openclaw/user-prefs.json",
        learning: {
          enabled: true,
          incrementPerUse: 0.1,
          maxWeight: 2.0,
          decayPerDay: 0.05,
          decayGracePeriodDays: 7,
        },
      },
    },
  },
}
```

**Learning Algorithm:**

1. When a user invokes a skill, `learnFromUsage()` increments the domain weight
2. Weight increases by `incrementPerUse` (default: 0.1) per use
3. Weights are capped at `maxWeight` (default: 2.0)
4. After `decayGracePeriodDays` of inactivity, weights decay by `decayPerDay`
5. Weights never go below `minWeight` (default: 0.5)

**Usage:**

```typescript
import { createUserPreferencesStore, applyUserPreferences } from "./routing/user-preferences.js";

const store = createUserPreferencesStore("~/.openclaw/user-prefs.json");

// Learn from usage
store.learnFromUsage("user123", ["claude-code"], ["coding"]);

// Apply to classifications
const adjusted = applyUserPreferences(classifications, "user123", store);
```

### Cost-Aware Selection

Factor in model costs when selecting:

```json5
{
  skills: {
    routing: {
      costAware: {
        enabled: true,
        preferCheaper: true,
        maxTier: "standard", // "free" | "cheap" | "standard" | "expensive"
        budgetPer24h: 10.0, // USD
      },
    },
  },
}
```

**Model Cost Data Sources:**

- Anthropic: https://www.anthropic.com/pricing
- OpenAI: https://openai.com/pricing
- Google: https://ai.google.dev/pricing
- DeepSeek: https://platform.deepseek.com

**Usage:**

```typescript
import { selectModelCostAware, createBudgetTracker } from "./routing/cost-aware-selector.js";

// Select cheapest model with required capabilities
const selection = selectModelCostAware(["vision", "tool-use"], availableModels, {
  preferCheaper: true,
  maxTier: "standard",
});

// Track budget
const tracker = createBudgetTracker(10.0); // $10/day
tracker.recordUsage("anthropic/claude-haiku", inputTokens, outputTokens);
console.log(`Remaining: $${tracker.getRemainingBudget()}`);
```

### Capability Detection

Auto-detect model capabilities via probing:

```typescript
import { probeModelCapabilities, verifyCapability } from "./routing/capability-detector.js";

// Probe all capabilities
const capabilities = await probeModelCapabilities("local/my-model", llmProvider);
// capabilities: ["tool-use", "streaming", "json-mode"]

// Verify specific capability
const hasVision = await verifyCapability("local/my-model", "vision", llmProvider);
```

**Available Probes:**

- `vision` — Can analyze images
- `tool-use` — Supports function calling
- `thinking` — Extended reasoning mode
- `json-mode` — Structured JSON output
- `streaming` — Streaming responses
- `long-context` — >100k token context
- `code-execution` — Sandbox code execution
- `web-search` — Integrated web search
- `multimodal-output` — Generate images/audio
- `moe` — Mixture of experts architecture

### Skill Chaining

Skills can declare dependencies:

```yaml
---
name: deploy-service
description: Deploy a service to production
metadata:
  openclaw:
    domains: ["devops"]
    dependencies:
      requires: ["github", "docker"]
      optional: ["kubernetes"]
      sequence: "before" # "before" | "after" | "parallel"
---
```

**Dependency Resolution Algorithm:**

1. Extract dependencies from skill metadata
2. Build dependency graph using `buildDependencyMap()`
3. Detect circular dependencies with DFS cycle detection
4. Resolve chain using topological sort with depth-first traversal
5. Return skills in execution order respecting `sequence` setting

**Usage:**

```typescript
import { resolveDependencyChain, detectCircularDependencies } from "./routing/skill-chaining.js";

// Resolve full chain
const chain = resolveDependencyChain("deploy-service", allSkills);
// chain.chain: ["github", "docker", "deploy-service"]
// chain.order: Map { "github" => 0, "docker" => 1, "deploy-service" => 2 }

// Check for cycles
const cycles = detectCircularDependencies(allSkills);
if (cycles.hasCircular) {
  console.error("Circular dependencies:", cycles.cycles);
}
```

---

## Actual Integration Points

### Agent Runner (Thinking Resolution)

Location: `src/auto-reply/reply/get-reply-run.ts` (~line 273)

The thinking resolver runs **after** the skill snapshot is loaded but **before** the agent turn starts:

```typescript
// After skill snapshot is loaded
const skillEntries = (skillsSnapshot as { entries?: unknown })?.entries;
if (
  resolvedThinkLevel &&
  Array.isArray(skillEntries) &&
  skillEntries.length > 0 &&
  !directives.hasThinkDirective // Don't override explicit user directives
) {
  const thinkingResolution = resolveThinkingWithSkills(resolvedThinkLevel, skillEntries);
  if (thinkingResolution.changed) {
    replyLogger.info("thinking-auto-override", {
      from: resolvedThinkLevel,
      to: thinkingResolution.level,
      skill: thinkingResolution.skillName,
      reason: thinkingResolution.reason,
    });
    resolvedThinkLevel = thinkingResolution.level;
  }
}
```

**Key behaviors:**

- User `/think:` directives are **never** overridden
- Only triggers when routing mode is not "static"
- Logs all auto-overrides for observability

### sessions_spawn (Model Auto-Selection)

Location: `src/agents/tools/sessions-spawn-tool.ts` (~line 175)

When spawning a sub-agent, skill detection triggers model selection:

```typescript
if (!modelOverride && cfg.skills?.routing?.mode !== "static") {
  const skillDetection = detectSkillFromTask(task);
  if (skillDetection.syntheticSkill && skillDetection.confidence > 0) {
    const modelSelection = selectModelForSkill(
      skillDetection.syntheticSkill,
      availableModels,
      currentModel,
      cfg,
    );
    if (modelSelection.model !== currentModel) {
      resolvedModel = modelSelection.model;
    }
    if (modelSelection.thinking && !thinkingOverrideRaw) {
      skillBasedThinking = modelSelection.thinking;
    }
  }
}
```

**Detection flow:**

1. `detectDomainsFromMessage()` extracts domains from task text using keywords
2. Domains map to capabilities (e.g., "media" → "vision")
3. A synthetic SkillEntry is created with inferred metadata
4. `selectModelForSkill()` chooses the best model based on capabilities
5. Only triggers when no explicit model is provided

### Task Skill Detector

Location: `src/agents/skills/routing/task-skill-detector.ts`

Lightweight skill detection without loading the full skill registry:

```typescript
export interface TaskSkillDetection {
  detectedDomains: string[];
  inferredCapabilities: ModelCapability[];
  syntheticSkill: SkillEntry | null;
  confidence: number;
}

export function detectSkillFromTask(task: string): TaskSkillDetection {
  // Uses keywords classifier for domain detection
  // Maps domains → capabilities
  // Creates synthetic SkillEntry for model selection
}
```

---

## Example: End-to-End Flow

User message: _"Review this screenshot of my React component and suggest improvements"_

```
1. CAPABILITY FILTERING
   Current model: anthropic/claude-haiku

   Skills checked:
   ├─ image-analyzer [vision] → ❌ Haiku has vision, but...
   ├─ deep-code-review [thinking] → ❌ EXCLUDED (Haiku lacks thinking)
   ├─ claude-code [tool-use] → ✓ ELIGIBLE
   └─ react-specialist [] → ✓ ELIGIBLE (no requirements)

2. DOMAIN CLASSIFICATION (keywords)
   Detected domains: ["coding", "ui-design", "media"]

   Skill scores:
   ├─ claude-code: 0.85 (coding)
   ├─ react-specialist: 0.78 (coding, ui-design)
   └─ image-analyzer: 0.71 (media)

3. ROUTING DECISION
   Selected: [claude-code, react-specialist, image-analyzer]

4. MODEL SELECTION HINT
   image-analyzer declares: preferredModel: "anthropic/claude-sonnet-4"

   Injected warning in prompt:
   "<warning>image-analyzer works best with vision+thinking.
    Consider: sessions_spawn with model=anthropic/claude-sonnet-4</warning>"

5. SUB-AGENT SPAWN (if agent decides to use image-analyzer)
   Auto-selected model: anthropic/claude-sonnet-4
   Thinking: medium (from minThinkingBudget)
```

---

## CLI Commands

### `openclaw skills route`

Test how a message would be routed:

```bash
openclaw skills route "help me write a contract for my app"
```

Output:

```
Routing mode: dynamic (keywords)
Detected domains: legal, coding
Selected skills (3):
  ✓ paralegal (89%) - legal
  ✓ claude-code (76%) - coding
  ✓ github (71%) - coding
Excluded skills (12):
  ✗ wine-cellar (12%)
  ✗ weather (8%)
  ...
```

Options:

- `--json` — Output as JSON for scripting
- `--verbose` — Show all classification scores

### `openclaw skills domains`

Show domain coverage across your skills:

```bash
openclaw skills domains
```

Output:

```
Domain Coverage

coding (8 skills)
  claude-code, github, codex, react-specialist, ...

legal (2 skills)
  paralegal, contract-review

finance (1 skill)
  accountant

uncategorized (4 skills)
  weather, reminder, voice-call, peekaboo
```

Options:

- `--json` — Output as JSON

---

## References

- [Skills](/tools/skills) — Skill loading and gating
- [Skills Config](/tools/skills-config) — Configuration schema
- [System Prompt](/concepts/system-prompt) — How skills are injected
- [Hooks](/hooks) — Event-driven extensibility
- [Plugins](/plugin) — Plugin architecture for custom classifiers

---

## Appendix: Canonical Domain List

Suggested canonical domains for skill authors:

| Domain          | Description                             | Example Skills                |
| --------------- | --------------------------------------- | ----------------------------- |
| `coding`        | Programming, debugging, code generation | claude-code, github, codex    |
| `devops`        | Infrastructure, deployment, CI/CD       | docker, kubernetes, terraform |
| `ui-design`     | Frontend, UX, visual design             | figma, tailwind, storybook    |
| `legal`         | Contracts, compliance, law              | paralegal, contract-review    |
| `finance`       | Accounting, invoicing, budgets          | accountant, quickbooks        |
| `writing`       | Content, copywriting, documentation     | grammarly, blog-writer        |
| `research`      | Search, analysis, data gathering        | web-search, arxiv             |
| `communication` | Email, messaging, scheduling            | calendar, email-composer      |
| `media`         | Images, video, audio                    | dall-e, midjourney, tts       |
| `data`          | Databases, analytics, visualization     | sql, pandas, charts           |
| `security`      | Auditing, scanning, compliance          | semgrep, trivy                |
| `personal`      | Reminders, notes, life management       | todoist, notion               |
