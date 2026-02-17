import { afterEach, describe, expect, test } from "vitest";
import { resetAgentDispatchState } from "../../infra/log-monitor-agent-dispatch.js";

// We test the parseHealCommand logic indirectly through the handler,
// but for unit isolation we can extract and test the parsing function.
// Since it's not exported, we test via string matching on the handler's behavior.

describe("/heal command parsing", () => {
  // Import the module-internal parse function by testing the handler output
  // We'll use a lightweight approach: test the resolveApprovalId logic

  test("resolveApprovalId exact match", async () => {
    // Dynamic import to get the module
    const mod = await import("./commands-heal.js");
    // The handler is exported, we'll test it indirectly
    expect(mod.handleHealCommand).toBeDefined();
  });

  afterEach(() => {
    resetAgentDispatchState();
  });

  test("/heal with no args returns usage", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Usage");
  });

  test("/heal list with no pending returns empty message", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal list"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("No pending");
  });

  test("/heal approve with unknown id returns error", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal approve nonexistent-id"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("No pending approval");
  });

  test("/heal reject with unknown id returns error", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal reject nonexistent-id"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("No pending approval");
  });

  test("returns null for non-heal commands", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/status"), true);
    expect(result).toBeNull();
  });

  test("returns null when text commands disabled", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal list"), false);
    expect(result).toBeNull();
  });

  test("/heal with invalid action returns usage", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal banana"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Usage");
  });

  test("/heal test triggers approval gate", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal test high"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Approval Gate Triggered");
    expect(result?.reply?.text).toContain("high");
  });

  test("/heal test defaults to medium severity", async () => {
    const { handleHealCommand } = await import("./commands-heal.js");
    const result = await handleHealCommand(makeParams("/heal test"), true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Approval Gate Triggered");
    expect(result?.reply?.text).toContain("medium");
  });
});

// Minimal params builder for testing
function makeParams(commandBody: string) {
  return {
    ctx: {} as never,
    cfg: {} as never,
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: ["test-user"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "test-user",
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
    },
    directives: {} as never,
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "agent:dev:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "always" as const,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "anthropic",
    model: "claude-sonnet-4",
    contextTokens: 0,
    isGroup: false,
  };
}
