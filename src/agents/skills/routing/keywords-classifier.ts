/**
 * Keywords Classifier
 *
 * Fast, zero-latency skill classification using keyword matching.
 * Maps message keywords to domains, then scores skills by domain overlap.
 *
 * This is the default classifier for Phase 1, providing sub-millisecond
 * classification without external dependencies.
 *
 * @module agents/skills/routing/keywords-classifier
 */

import type { SkillEntry } from "../types.js";
import type {
  RoutingContext,
  RoutingSkillMetadata,
  SkillClassification,
  SkillRoutingConfig,
} from "./types.js";

/**
 * Canonical domain keywords for classification.
 *
 * Each domain maps to an array of trigger keywords. When a keyword is found
 * in the message, the corresponding domain is activated.
 */
export const DOMAIN_KEYWORDS: Record<string, string[]> = {
  coding: [
    "code",
    "program",
    "function",
    "debug",
    "error",
    "api",
    "implement",
    "refactor",
    "compile",
    "syntax",
    "variable",
    "class",
    "method",
    "interface",
    "typescript",
    "javascript",
    "python",
    "rust",
    "golang",
    "java",
    "csharp",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "scala",
    "clojure",
    "haskell",
    "elixir",
    "cpp",
    "c++",
    "programming",
    "developer",
    "software",
    "algorithm",
    "data structure",
    "git",
    "github",
    "gitlab",
    "repository",
    "commit",
    "branch",
    "merge",
    "pull request",
    "pr",
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "cargo",
    "maven",
    "gradle",
  ],
  legal: [
    "contract",
    "agreement",
    "liability",
    "clause",
    "attorney",
    "lawsuit",
    "legal",
    "lawyer",
    "court",
    "judge",
    "litigation",
    "plaintiff",
    "defendant",
    "settlement",
    "arbitration",
    "mediation",
    "compliance",
    "regulation",
    "statute",
    "ordinance",
    "tort",
    "negligence",
    "damages",
    "injunction",
    "subpoena",
    "deposition",
    "testimony",
    "evidence",
    "verdict",
    "appeal",
    "patent",
    "trademark",
    "copyright",
    "intellectual property",
    "ip",
    "nda",
    "terms of service",
    "privacy policy",
    "gdpr",
    "hipaa",
  ],
  finance: [
    "invoice",
    "payment",
    "budget",
    "expense",
    "tax",
    "accounting",
    "financial",
    "money",
    "revenue",
    "profit",
    "loss",
    "balance sheet",
    "income statement",
    "cash flow",
    "accounts payable",
    "accounts receivable",
    "ledger",
    "audit",
    "fiscal",
    "quarterly",
    "annual report",
    "stock",
    "bond",
    "investment",
    "portfolio",
    "dividend",
    "interest",
    "loan",
    "mortgage",
    "credit",
    "debit",
    "bank",
    "wire transfer",
    "ach",
    "payroll",
    "salary",
    "compensation",
    "benefits",
    "401k",
    "ira",
    "crypto",
    "bitcoin",
    "ethereum",
    "doge",
    "wallet",
  ],
  "ui-design": [
    "ui",
    "ux",
    "design",
    "layout",
    "component",
    "interface",
    "frontend",
    "front-end",
    "mockup",
    "wireframe",
    "prototype",
    "figma",
    "sketch",
    "adobe xd",
    "invision",
    "color palette",
    "typography",
    "font",
    "icon",
    "button",
    "form",
    "navigation",
    "menu",
    "modal",
    "tooltip",
    "dropdown",
    "carousel",
    "grid",
    "flexbox",
    "responsive",
    "mobile-first",
    "accessibility",
    "a11y",
    "wcag",
    "aria",
    "tailwind",
    "css",
    "sass",
    "styled-components",
    "emotion",
    "material-ui",
    "chakra",
    "ant design",
  ],
  devops: [
    "deploy",
    "server",
    "docker",
    "kubernetes",
    "k8s",
    "ci/cd",
    "infrastructure",
    "devops",
    "aws",
    "azure",
    "gcp",
    "cloud",
    "terraform",
    "ansible",
    "puppet",
    "chef",
    "jenkins",
    "github actions",
    "gitlab ci",
    "circleci",
    "travisci",
    "argocd",
    "helm",
    "container",
    "pod",
    "service mesh",
    "istio",
    "envoy",
    "nginx",
    "apache",
    "load balancer",
    "cdn",
    "cloudflare",
    "monitoring",
    "prometheus",
    "grafana",
    "datadog",
    "newrelic",
    "logging",
    "elk",
    "splunk",
    "alerting",
    "pagerduty",
    "opsgenie",
    "sre",
    "incident",
    "postmortem",
    "runbook",
    "ssh",
    "linux",
    "unix",
    "bash",
    "shell",
  ],
  writing: [
    "write",
    "draft",
    "edit",
    "proofread",
    "article",
    "blog",
    "content",
    "copy",
    "copywriting",
    "essay",
    "paper",
    "document",
    "documentation",
    "readme",
    "manual",
    "guide",
    "tutorial",
    "instructions",
    "narrative",
    "story",
    "fiction",
    "non-fiction",
    "book",
    "chapter",
    "paragraph",
    "sentence",
    "grammar",
    "spelling",
    "punctuation",
    "style guide",
    "tone",
    "voice",
    "audience",
    "headline",
    "summary",
    "abstract",
    "introduction",
    "conclusion",
    "outline",
    "brainstorm",
  ],
  research: [
    "search",
    "find",
    "lookup",
    "investigate",
    "analyze",
    "report",
    "research",
    "study",
    "survey",
    "data",
    "statistics",
    "methodology",
    "hypothesis",
    "experiment",
    "results",
    "findings",
    "conclusion",
    "literature review",
    "citation",
    "reference",
    "source",
    "primary source",
    "secondary source",
    "peer review",
    "journal",
    "publication",
    "arxiv",
    "pubmed",
    "google scholar",
    "database",
    "query",
    "information",
    "fact-check",
    "verify",
    "compare",
    "benchmark",
  ],
  communication: [
    "email",
    "message",
    "send",
    "reply",
    "forward",
    "schedule",
    "meeting",
    "calendar",
    "appointment",
    "reminder",
    "notification",
    "slack",
    "teams",
    "zoom",
    "call",
    "video call",
    "conference",
    "chat",
    "dm",
    "thread",
    "announcement",
    "newsletter",
    "broadcast",
    "invite",
    "rsvp",
    "agenda",
    "minutes",
    "follow-up",
    "sync",
    "standup",
    "1:1",
    "one-on-one",
    "feedback",
    "review",
  ],
  media: [
    "image",
    "photo",
    "picture",
    "screenshot",
    "video",
    "audio",
    "sound",
    "music",
    "podcast",
    "recording",
    "stream",
    "broadcast",
    "live",
    "camera",
    "microphone",
    "speaker",
    "headphones",
    "render",
    "animation",
    "gif",
    "mp3",
    "mp4",
    "jpeg",
    "png",
    "svg",
    "pdf",
    "photoshop",
    "illustrator",
    "premiere",
    "after effects",
    "blender",
    "midjourney",
    "dall-e",
    "stable diffusion",
    "tts",
    "text-to-speech",
    "speech-to-text",
    "transcribe",
    "caption",
    "subtitle",
  ],
  data: [
    "database",
    "sql",
    "nosql",
    "mongodb",
    "postgresql",
    "mysql",
    "redis",
    "elasticsearch",
    "query",
    "table",
    "schema",
    "migration",
    "backup",
    "restore",
    "analytics",
    "dashboard",
    "visualization",
    "chart",
    "graph",
    "plot",
    "pandas",
    "numpy",
    "jupyter",
    "notebook",
    "dataframe",
    "csv",
    "json",
    "parquet",
    "etl",
    "pipeline",
    "warehouse",
    "bigquery",
    "redshift",
    "snowflake",
    "dbt",
    "airflow",
    "spark",
    "hadoop",
    "kafka",
    "streaming",
  ],
  security: [
    "security",
    "vulnerability",
    "exploit",
    "patch",
    "firewall",
    "encryption",
    "decrypt",
    "hash",
    "ssl",
    "tls",
    "certificate",
    "authentication",
    "authorization",
    "oauth",
    "jwt",
    "token",
    "password",
    "mfa",
    "2fa",
    "audit",
    "compliance",
    "penetration test",
    "pentest",
    "security scan",
    "semgrep",
    "snyk",
    "trivy",
    "cve",
    "zero-day",
    "malware",
    "ransomware",
    "phishing",
    "social engineering",
    "incident response",
    "forensics",
    "soc",
    "siem",
  ],
  personal: [
    "reminder",
    "todo",
    "task",
    "note",
    "journal",
    "diary",
    "habit",
    "goal",
    "resolution",
    "personal",
    "life",
    "health",
    "fitness",
    "exercise",
    "workout",
    "diet",
    "nutrition",
    "sleep",
    "meditation",
    "mindfulness",
    "productivity",
    "time management",
    "pomodoro",
    "focus",
    "break",
    "vacation",
    "travel",
    "trip",
    "flight",
    "hotel",
    "restaurant",
    "recommendation",
    "recipe",
    "cooking",
    "shopping",
    "grocery",
    "wishlist",
    "gift",
    "birthday",
    "anniversary",
  ],
};

/**
 * Word boundary pattern for matching whole words.
 */
const WORD_BOUNDARY = /[\s,.;:!?()[\]{}'"<>\/\\|@#$%^&*+=~`-]/;

/**
 * Check if a keyword exists in the message as a whole word.
 *
 * @param message - Lowercased message to search in
 * @param keyword - Lowercased keyword to find
 * @returns true if the keyword is found as a whole word
 */
function containsWholeWord(message: string, keyword: string): boolean {
  let startIndex = 0;
  while (true) {
    const index = message.indexOf(keyword, startIndex);
    if (index === -1) {
      return false;
    }

    // Check word boundaries
    const charBefore = index > 0 ? message[index - 1] : " ";
    const charAfter =
      index + keyword.length < message.length ? message[index + keyword.length] : " ";

    const boundaryBefore = WORD_BOUNDARY.test(charBefore);
    const boundaryAfter = WORD_BOUNDARY.test(charAfter);

    if (boundaryBefore && boundaryAfter) {
      return true;
    }

    startIndex = index + 1;
  }
}

/**
 * Extract domains from a message using keyword matching.
 *
 * @param message - The user message to classify
 * @param config - Optional routing config with domain aliases
 * @returns Set of detected domain names
 */
export function detectDomainsFromMessage(
  message: string,
  config?: SkillRoutingConfig,
): Set<string> {
  const messageLower = message.toLowerCase();
  const detectedDomains = new Set<string>();

  // Check each domain's keywords
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const keyword of keywords) {
      if (containsWholeWord(messageLower, keyword.toLowerCase())) {
        detectedDomains.add(domain);
        // Also add aliased domains
        if (config?.domainAliases) {
          for (const [alias, targetDomains] of Object.entries(config.domainAliases)) {
            if (targetDomains.includes(domain)) {
              detectedDomains.add(alias);
            }
          }
        }
        break; // Found a match for this domain, move to next
      }
    }
  }

  // Check domain aliases as source domains too
  if (config?.domainAliases) {
    for (const [alias, targetDomains] of Object.entries(config.domainAliases)) {
      // Check if any of the target domain keywords match
      for (const targetDomain of targetDomains) {
        if (detectedDomains.has(targetDomain)) {
          detectedDomains.add(alias);
          break;
        }
      }
    }
  }

  return detectedDomains;
}

/**
 * Extract routing metadata from a skill entry.
 *
 * @param entry - The skill entry
 * @returns Routing metadata or empty object
 */
function getRoutingMetadata(entry: SkillEntry): RoutingSkillMetadata {
  // Look for routing fields in metadata
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return {};
  }

  return {
    domains: Array.isArray(metadata.domains) ? (metadata.domains as string[]) : undefined,
    domainWeight: typeof metadata.domainWeight === "number" ? metadata.domainWeight : undefined,
    alwaysInclude: typeof metadata.alwaysInclude === "boolean" ? metadata.alwaysInclude : undefined,
    capabilities: Array.isArray(metadata.capabilities)
      ? (metadata.capabilities as RoutingSkillMetadata["capabilities"])
      : undefined,
    preferredModel:
      typeof metadata.preferredModel === "string" ? metadata.preferredModel : undefined,
    minThinkingBudget:
      typeof metadata.minThinkingBudget === "string" &&
      ["low", "medium", "high"].includes(metadata.minThinkingBudget)
        ? (metadata.minThinkingBudget as RoutingSkillMetadata["minThinkingBudget"])
        : undefined,
  };
}

/**
 * Classify skills based on keyword matching.
 *
 * Scoring algorithm:
 * - Skills with domains matching detected domains get higher scores
 * - Score = (matched domains / total skill domains) * domainWeight
 * - Skills without domains get a baseline score of 0.1
 * - Skills with alwaysInclude get a score of 1.0
 *
 * @param context - Routing context with user message
 * @param skills - Array of eligible skill entries
 * @param config - Routing configuration
 * @returns Array of skill classifications sorted by confidence (descending)
 */
export function classifyWithKeywords(
  context: RoutingContext,
  skills: SkillEntry[],
  config?: SkillRoutingConfig,
): SkillClassification[] {
  const detectedDomains = context.detectedDomains
    ? new Set(context.detectedDomains)
    : detectDomainsFromMessage(context.message, config);

  const classifications: SkillClassification[] = [];

  for (const skill of skills) {
    const routing = getRoutingMetadata(skill);
    const skillDomains = routing.domains ?? [];
    const domainWeight = routing.domainWeight ?? 1.0;

    let confidence: number;
    let reason: string | undefined;

    if (routing.alwaysInclude) {
      // Always-include skills get maximum confidence
      confidence = 1.0;
      reason = "alwaysInclude flag";
    } else if (skillDomains.length === 0) {
      // Skills without domains get a low baseline score
      // They're still included but deprioritized
      confidence = 0.1;
      reason = "no domains defined";
    } else {
      // Calculate domain overlap
      const matchedDomains = skillDomains.filter((d) => detectedDomains.has(d));
      const overlapRatio = matchedDomains.length / skillDomains.length;
      confidence = overlapRatio * domainWeight;

      if (matchedDomains.length > 0) {
        reason = `matched: ${matchedDomains.join(", ")}`;
      }
    }

    classifications.push({
      skillName: skill.skill.name,
      domains: skillDomains,
      confidence,
      reason,
    });
  }

  // Sort by confidence descending
  return classifications.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Get all canonical domain names.
 *
 * @returns Array of canonical domain names
 */
export function getCanonicalDomains(): string[] {
  return Object.keys(DOMAIN_KEYWORDS);
}

/**
 * Get keywords for a specific domain.
 *
 * @param domain - The domain name
 * @returns Array of keywords, or empty array if domain not found
 */
export function getDomainKeywords(domain: string): string[] {
  return DOMAIN_KEYWORDS[domain] ?? [];
}
