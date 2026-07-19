// Anthropic tests cover the deterministic per-profile Claude CLI home resolver.
import { describe, expect, it } from "vitest";
import { resolveClaudeCliProfileHome } from "./claude-cli-auth-home.js";

describe("resolveClaudeCliProfileHome", () => {
  it("is deterministic for the same agentDir and profileId", () => {
    const first = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat2");
    const second = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat2");
    expect(first).toBe(second);
  });

  it("produces a unique home per profile id", () => {
    const seat2 = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat2");
    const seat3 = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat3");
    expect(seat2).not.toBe(seat3);
  });

  it("produces a unique home per agent directory for the same profile id", () => {
    const agentA = resolveClaudeCliProfileHome("/agents/a", "claude-cli:seat2");
    const agentB = resolveClaudeCliProfileHome("/agents/b", "claude-cli:seat2");
    expect(agentA).not.toBe(agentB);
  });

  it("nests under a claude-cli-home/profiles namespace inside the agent directory", () => {
    const home = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat2");
    expect(home.startsWith("/agents/main/claude-cli-home/profiles/")).toBe(true);
  });

  it("does not leak the raw profile id into the resolved path", () => {
    const home = resolveClaudeCliProfileHome("/agents/main", "claude-cli:seat2");
    expect(home).not.toContain("seat2");
  });
});
