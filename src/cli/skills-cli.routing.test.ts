/**
 * Skills CLI Routing Commands Tests
 *
 * Tests for `openclaw skills route` and `openclaw skills domains` commands.
 *
 * @module cli/skills-cli.routing.test
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
const mockLog = vi.fn();
const mockError = vi.fn();
const mockExit = vi.fn();

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    exit: (code: number) => mockExit(code),
  },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    skills: {
      routing: {
        mode: "dynamic",
        dynamic: {
          classifier: "keywords",
          minConfidence: 0.3,
        },
      },
    },
  }),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/test/workspace",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../agents/skills/workspace.js", () => ({
  loadWorkspaceSkillEntries: () => [
    {
      skill: { name: "claude-code", description: "Coding assistant" },
      metadata: { domains: ["coding", "programming"] },
    },
    {
      skill: { name: "paralegal", description: "Legal assistant" },
      metadata: { domains: ["legal"] },
    },
    {
      skill: { name: "web-search", description: "Search the web" },
      metadata: { domains: ["research"] },
    },
    {
      skill: { name: "no-domain", description: "No domain defined" },
      metadata: {},
    },
  ],
  filterWorkspaceSkillEntries: (entries: unknown[]) => entries,
}));

vi.mock("../agents/skills/routing/index.js", () => ({
  routeSkillsSync: (_eligible: unknown[], context: { message: string }, _config: unknown) => {
    // Simple mock that returns coding skills for "code" messages
    const message = context.message.toLowerCase();
    if (message.includes("code") || message.includes("program")) {
      return {
        selectedSkills: ["claude-code"],
        classifications: [
          {
            skillName: "claude-code",
            domains: ["coding"],
            confidence: 0.9,
            reason: "matched: coding",
          },
        ],
        method: "dynamic" as const,
        cached: false,
        detectedDomains: ["coding"],
      };
    }
    if (message.includes("legal") || message.includes("contract")) {
      return {
        selectedSkills: ["paralegal"],
        classifications: [
          {
            skillName: "paralegal",
            domains: ["legal"],
            confidence: 0.85,
            reason: "matched: legal",
          },
        ],
        method: "dynamic" as const,
        cached: false,
        detectedDomains: ["legal"],
      };
    }
    return {
      selectedSkills: [],
      classifications: [],
      method: "dynamic" as const,
      cached: false,
      detectedDomains: [],
    };
  },
  detectDomainsFromMessage: (message: string) => {
    const lower = message.toLowerCase();
    const domains = new Set<string>();
    if (lower.includes("code") || lower.includes("program")) {
      domains.add("coding");
    }
    if (lower.includes("legal") || lower.includes("contract")) {
      domains.add("legal");
    }
    if (lower.includes("search") || lower.includes("find")) {
      domains.add("research");
    }
    return domains;
  },
  getCanonicalDomains: () => [
    "coding",
    "legal",
    "finance",
    "ui-design",
    "devops",
    "writing",
    "research",
    "communication",
    "media",
    "data",
    "security",
    "personal",
  ],
}));

// Import after mocks
import { Command } from "commander";
import { registerSkillsCli } from "./skills-cli.js";

describe("skills CLI routing commands", () => {
  let program: Command;

  beforeEach(() => {
    mockLog.mockReset();
    mockError.mockReset();
    mockExit.mockReset();
    program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("skills route", () => {
    it("routes a coding message to claude-code", async () => {
      await program.parseAsync(["node", "test", "skills", "route", "help me write some code"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("Skill Routing Test");
      expect(output).toContain("claude-code");
      expect(output).toContain("coding");
    });

    it("routes a legal message to paralegal", async () => {
      await program.parseAsync(["node", "test", "skills", "route", "review this contract"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("paralegal");
      expect(output).toContain("legal");
    });

    it("outputs JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "skills", "route", "write code", "--json"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.message).toBe("write code");
      expect(parsed.mode).toBe("dynamic");
      expect(parsed.selectedSkills).toContain("claude-code");
    });

    it("shows not selected skills for irrelevant messages", async () => {
      await program.parseAsync(["node", "test", "skills", "route", "random message"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("Not Selected");
    });
  });

  describe("skills domains", () => {
    it("shows domain coverage", async () => {
      await program.parseAsync(["node", "test", "skills", "domains"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("Domain Coverage");
      expect(output).toContain("coding");
      expect(output).toContain("legal");
      expect(output).toContain("research");
    });

    it("shows uncategorized skills", async () => {
      await program.parseAsync(["node", "test", "skills", "domains"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("uncategorized");
      expect(output).toContain("no-domain");
    });

    it("outputs JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "skills", "domains", "--json"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.coding).toBeDefined();
      expect(parsed.coding).toContain("claude-code");
      expect(parsed._uncategorized).toContain("no-domain");
      expect(parsed._canonical).toContain("coding");
    });

    it("lists canonical domains", async () => {
      await program.parseAsync(["node", "test", "skills", "domains"]);

      expect(mockLog).toHaveBeenCalled();
      const output = mockLog.mock.calls[0][0];
      expect(output).toContain("Canonical domains:");
    });
  });
});
