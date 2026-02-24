import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
// Skills status functionality is available but not used in this file
import {
  routeSkillsSync,
  getCanonicalDomains,
  type RoutingContext,
} from "../agents/skills/routing/index.js";
import {
  loadWorkspaceSkillEntries,
  filterWorkspaceSkillEntries,
} from "../agents/skills/workspace.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

async function loadSkillsStatusReport(): Promise<SkillStatusReport> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
}

async function runSkillsAction(render: (report: SkillStatusReport) => string): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts));
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts));
    });

  skills
    .command("route")
    .description("Test skill routing for a message")
    .argument("<message>", "Message to test routing for")
    .option("--json", "Output as JSON", false)
    .option("--mode <mode>", "Routing mode: static, dynamic, hybrid", "dynamic")
    .option("--model <model>", "Model to use for capability filtering")
    .action(async (message, opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));

        // Load and filter skill entries
        const allEntries = loadWorkspaceSkillEntries(workspaceDir, { config });
        const eligible = filterWorkspaceSkillEntries(allEntries, config);

        // Build routing context
        const routingContext: RoutingContext = {
          message,
          currentModel: opts.model,
        };

        // Build routing config
        const routingConfig = {
          mode: opts.mode as "static" | "dynamic" | "hybrid",
          dynamic: {
            classifier: "keywords" as const,
            minConfidence: 0.3,
            respectAlwaysInclude: true,
          },
          domainAliases: config?.skills?.routing?.domainAliases,
        };

        // Run routing
        const result = routeSkillsSync(
          eligible,
          routingContext,
          routingConfig,
          config?.models ? { capabilities: config.models.capabilities } : undefined,
        );

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                message,
                mode: result.method,
                detectedDomains: result.detectedDomains ?? [],
                selectedSkills: result.selectedSkills,
                classifications: result.classifications,
                capabilityExclusions: result.capabilityExclusions,
                eligibleCount: eligible.length,
                selectedCount: result.selectedSkills.length,
              },
              null,
              2,
            ),
          );
          return;
        }

        const lines: string[] = [];
        lines.push(theme.heading("Skill Routing Test"));
        lines.push("");
        lines.push(`${theme.muted("Message:")} ${message}`);
        lines.push(`${theme.muted("Mode:")} ${result.method}`);

        // Detected domains
        const detectedDomains = result.detectedDomains ?? [];
        if (detectedDomains.length > 0) {
          lines.push(`${theme.muted("Detected domains:")} ${detectedDomains.join(", ")}`);
        }

        lines.push("");
        lines.push(
          `${theme.heading("Selected Skills")} ${theme.muted(`(${result.selectedSkills.length}/${eligible.length})`)}`,
        );

        // Show selected skills with confidence
        for (const classification of result.classifications) {
          const confidence = (classification.confidence * 100).toFixed(0);
          const domains =
            classification.domains.length > 0 ? classification.domains.join(", ") : "—";
          const reason = classification.reason ? theme.muted(` (${classification.reason})`) : "";
          lines.push(
            `  ${theme.success("✓")} ${classification.skillName} ${theme.muted(`[${confidence}%]`)} - ${domains}${reason}`,
          );
        }

        // Show excluded skills due to capabilities
        if (result.capabilityExclusions && result.capabilityExclusions.length > 0) {
          lines.push("");
          lines.push(theme.heading("Excluded (capability mismatch):"));
          for (const exclusion of result.capabilityExclusions) {
            const missing = exclusion.missing.join(", ");
            const hint = exclusion.hint ? theme.muted(` → ${exclusion.hint}`) : "";
            lines.push(
              `  ${theme.error("✗")} ${exclusion.skill} ${theme.warn(`(needs: ${missing})`)}${hint}`,
            );
          }
        }

        // Show not-selected skills (low confidence)
        const notSelected = eligible
          .filter((e) => !result.selectedSkills.includes(e.skill.name))
          .filter((e) => !result.capabilityExclusions?.some((ex) => ex.skill === e.skill.name));
        if (notSelected.length > 0) {
          lines.push("");
          lines.push(theme.heading("Not Selected (low relevance):"));
          for (const entry of notSelected.slice(0, 5)) {
            const metadata = entry.metadata as Record<string, unknown> | undefined;
            const domains = Array.isArray(metadata?.domains)
              ? (metadata.domains as string[]).join(", ")
              : "—";
            lines.push(`  ${theme.muted("○")} ${entry.skill.name} - ${theme.muted(domains)}`);
          }
          if (notSelected.length > 5) {
            lines.push(theme.muted(`  ... and ${notSelected.length - 5} more`));
          }
        }

        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("domains")
    .description("Show domain coverage across skills")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));

        // Load and filter skill entries
        const allEntries = loadWorkspaceSkillEntries(workspaceDir, { config });
        const eligible = filterWorkspaceSkillEntries(allEntries, config);

        // Build domain -> skills map
        const domainSkills = new Map<string, string[]>();
        const uncategorized: string[] = [];

        for (const entry of eligible) {
          const metadata = entry.metadata as Record<string, unknown> | undefined;
          const domains = Array.isArray(metadata?.domains) ? (metadata.domains as string[]) : [];

          if (domains.length === 0) {
            uncategorized.push(entry.skill.name);
          } else {
            for (const domain of domains) {
              if (!domainSkills.has(domain)) {
                domainSkills.set(domain, []);
              }
              domainSkills.get(domain)!.push(entry.skill.name);
            }
          }
        }

        // Get canonical domains for reference
        const canonicalDomains = getCanonicalDomains();

        if (opts.json) {
          const result: Record<string, string[]> = {};
          for (const [domain, skills] of domainSkills.entries()) {
            result[domain] = skills;
          }
          result._uncategorized = uncategorized;
          result._canonical = canonicalDomains;
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        const lines: string[] = [];
        lines.push(theme.heading("Domain Coverage"));
        lines.push("");

        // Sort domains by skill count
        const sortedDomains = Array.from(domainSkills.entries()).toSorted(
          (a, b) => b[1].length - a[1].length,
        );

        for (const [domain, skills] of sortedDomains) {
          const isCanonical = canonicalDomains.includes(domain);
          const domainLabel = isCanonical ? theme.success(domain) : theme.warn(domain);
          const skillList = skills.slice(0, 5).join(", ");
          const more = skills.length > 5 ? `, +${skills.length - 5} more` : "";
          lines.push(`${domainLabel} ${theme.muted(`(${skills.length})`)} ${skillList}${more}`);
        }

        if (uncategorized.length > 0) {
          lines.push("");
          lines.push(`${theme.warn("uncategorized")} ${theme.muted(`(${uncategorized.length})`)}`);
          const uncatList = uncategorized.slice(0, 5).join(", ");
          const uncatMore = uncategorized.length > 5 ? `, +${uncategorized.length - 5} more` : "";
          lines.push(`  ${uncatList}${uncatMore}`);
        }

        lines.push("");
        lines.push(theme.muted(`Canonical domains: ${canonicalDomains.join(", ")}`));
        lines.push("");
        lines.push(
          theme.muted(
            `Total: ${eligible.length} skills, ${domainSkills.size} domains, ${uncategorized.length} uncategorized`,
          ),
        );

        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
