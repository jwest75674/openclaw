/**
 * Regression coverage for the auth-profile round-robin bookkeeping gap: a
 * successful CLI-backend run (gemini-cli, claude-cli-seatN, codex, ...) must
 * record lastUsed via markAuthProfileSuccess, the same way
 * embedded-agent-runner/run.ts does for the native API-model path. Without
 * this, auth-profiles/order.ts's "round robin by lastUsed" sort is a no-op
 * tie that always resolves to the same profile -- see
 * auth-profiles.resolve-auth-profile-order.does-not-prioritize-lastgood-round-robin-ordering.test.ts
 * for the ordering half of this contract.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  runPreparedCliAgent,
  restoreCliRunnerTestDeps,
  setCliRunnerTestDeps,
} from "./cli-runner.js";
import { supervisorSpawnMock } from "./cli-runner.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

const { markAuthProfileSuccessMock, ensureAuthProfileStoreMock } = vi.hoisted(() => ({
  markAuthProfileSuccessMock: vi.fn(async () => {}),
  ensureAuthProfileStoreMock: vi.fn(() => ({ version: 1 as const, profiles: {} })),
}));

vi.mock("./auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-profiles.js")>();
  return {
    ...actual,
    markAuthProfileSuccess: (...args: unknown[]) => markAuthProfileSuccessMock(...args),
  };
});

vi.mock("./model-auth.js", () => ({
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
}));

function createSessionFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-auth-profile-success-"));
  const sessionFile = path.join(dir, "agents", "main", "sessions", "s1.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "session-test",
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    })}\n`,
    "utf-8",
  );
  return { dir, sessionFile };
}

function buildContext(params: {
  sessionFile: string;
  workspaceDir: string;
  effectiveAuthProfileId?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "gemini",
    args: ["--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "s1",
      sessionKey: "agent:main:auth-profile-success-test",
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      prompt: "hi",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      runId: "run-auth-profile-success",
      config: {} as OpenClawConfig,
    },
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    backendResolved: {
      id: "google-gemini-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "google",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "gemini-3.1-pro-preview",
    normalizedModel: "gemini-3.1-pro-preview",
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
    ...(params?.effectiveAuthProfileId
      ? { effectiveAuthProfileId: params.effectiveAuthProfileId }
      : {}),
  };
}

function mockOneSuccessfulSpawn() {
  supervisorSpawnMock.mockResolvedValueOnce({
    runId: "run-supervisor",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
    cancel: vi.fn(),
  });
}

describe("runPreparedCliAgent auth-profile success bookkeeping", () => {
  beforeEach(() => {
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: async () => false,
      delay: async () => {},
    });
    markAuthProfileSuccessMock.mockClear();
    ensureAuthProfileStoreMock.mockClear();
    supervisorSpawnMock.mockClear();
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
  });

  it("records auth-profile success after a successful CLI-backend run", async () => {
    mockOneSuccessfulSpawn();
    const { dir, sessionFile } = createSessionFile();
    const context = buildContext({
      sessionFile,
      workspaceDir: dir,
      effectiveAuthProfileId: "google-gemini-cli:someone@example.com",
    });

    const result = await runPreparedCliAgent(context);
    expect(result.payloads).toEqual([{ text: "ok" }]);

    expect(markAuthProfileSuccessMock).toHaveBeenCalledTimes(1);
    const call = markAuthProfileSuccessMock.mock.calls[0]?.[0] as {
      provider: string;
      profileId: string;
    };
    expect(call.provider).toBe("google-gemini-cli");
    expect(call.profileId).toBe("google-gemini-cli:someone@example.com");
  });

  it("does not record bookkeeping when no auth profile was forwarded", async () => {
    mockOneSuccessfulSpawn();
    const { dir, sessionFile } = createSessionFile();
    const context = buildContext({ sessionFile, workspaceDir: dir });

    const result = await runPreparedCliAgent(context);
    expect(result.payloads).toEqual([{ text: "ok" }]);

    expect(markAuthProfileSuccessMock).not.toHaveBeenCalled();
  });
});
