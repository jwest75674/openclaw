// Anthropic tests cover the Claude CLI per-profile auth-home prepareExecution
// bridge that lets resolveAuthProfileOrder() rotate registered claude-cli
// auth profiles across multiple logged-in Claude Code CLI seats.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareClaudeCliAuthHome } from "./cli-backend-auth.runtime.js";

describe("prepareClaudeCliAuthHome", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-cli-auth-home-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no auth profile was selected", async () => {
    const result = await prepareClaudeCliAuthHome({ authProfileId: undefined }, undefined);
    expect(result).toBeNull();
  });

  it("returns null when no auth profile was selected even if a credential was passed", async () => {
    const result = await prepareClaudeCliAuthHome(
      { authProfileId: undefined },
      { type: "token", provider: "claude-cli", metadata: { homeDir: tmpDir } },
    );
    expect(result).toBeNull();
  });

  it("throws when a profile was selected but no credential material was found", async () => {
    await expect(
      prepareClaudeCliAuthHome({ authProfileId: "claude-cli:seat2" }, undefined),
    ).rejects.toThrow(/no credential material was found/);
  });

  it("throws when the credential belongs to a different provider", async () => {
    await expect(
      prepareClaudeCliAuthHome(
        { authProfileId: "claude-cli:seat2" },
        { type: "token", provider: "google-gemini-cli", metadata: { homeDir: tmpDir } },
      ),
    ).rejects.toThrow(/requires a "claude-cli" auth profile/);
  });

  it("throws when the credential has no registered home directory", async () => {
    await expect(
      prepareClaudeCliAuthHome(
        { authProfileId: "claude-cli:seat2" },
        { type: "token", provider: "claude-cli" },
      ),
    ).rejects.toThrow(/no registered CLAUDE_CONFIG_DIR home directory/);
  });

  it("throws when the registered home directory is not absolute", async () => {
    await expect(
      prepareClaudeCliAuthHome(
        { authProfileId: "claude-cli:seat2" },
        { type: "token", provider: "claude-cli", metadata: { homeDir: "relative/path" } },
      ),
    ).rejects.toThrow(/non-absolute home directory/);
  });

  it("sets CLAUDE_CONFIG_DIR to the profile's registered home directory", async () => {
    const result = await prepareClaudeCliAuthHome(
      { authProfileId: "claude-cli:seat2" },
      { type: "token", provider: "claude-cli", metadata: { homeDir: tmpDir } },
    );
    expect(result?.env).toEqual({ CLAUDE_CONFIG_DIR: tmpDir });
  });

  it("beforeExecution succeeds when the home directory exists", async () => {
    const result = await prepareClaudeCliAuthHome(
      { authProfileId: "claude-cli:seat2" },
      { type: "token", provider: "claude-cli", metadata: { homeDir: tmpDir } },
    );
    await expect(result?.beforeExecution?.()).resolves.toBeUndefined();
  });

  it("beforeExecution throws when the home directory does not exist", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const result = await prepareClaudeCliAuthHome(
      { authProfileId: "claude-cli:seat2" },
      { type: "token", provider: "claude-cli", metadata: { homeDir: missing } },
    );
    await expect(result?.beforeExecution?.()).rejects.toThrow(/is not accessible/);
  });

  it("beforeExecution throws when the home directory is a file, not a directory", async () => {
    const filePath = path.join(tmpDir, "not-a-dir");
    await writeFile(filePath, "");
    const result = await prepareClaudeCliAuthHome(
      { authProfileId: "claude-cli:seat2" },
      { type: "token", provider: "claude-cli", metadata: { homeDir: filePath } },
    );
    await expect(result?.beforeExecution?.()).rejects.toThrow(/is not a directory/);
  });
});
