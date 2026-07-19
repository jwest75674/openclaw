/**
 * Claude CLI per-profile auth bridge.
 *
 * Redirects CLAUDE_CONFIG_DIR to the already-authenticated external `claude`
 * CLI login directory a selected OpenClaw auth profile points at, so the
 * generic `resolveAuthProfileOrder()` round-robin (see
 * src/agents/auth-profiles/order.ts) can rotate Claude CLI runs across
 * multiple logged-in seats the same way it already rotates Gemini CLI
 * profiles (extensions/google/cli-backend-auth.runtime.ts).
 *
 * This intentionally does NOT mirror Gemini's OAuth-material bridge: Gemini's
 * hook materializes a fresh oauth_creds.json every run because OpenClaw owns
 * Google OAuth refresh end-to-end. OpenClaw does not implement Anthropic
 * subscription OAuth refresh — the real `claude` binary refreshes its own
 * `.credentials.json` in place whenever it runs. Reconstructing that file
 * from a stored snapshot on every invocation would fight that refresh and
 * could desync from (or clobber) live login state. So this hook only ever
 * points CLAUDE_CONFIG_DIR at a real, persistent, self-refreshing directory
 * that a human already authenticated via `claude login` (or equivalent) —
 * it never writes credential material itself.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CliBackendPreparedExecution } from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

/** Metadata key recording the external Claude CLI login directory. */
export const CLAUDE_CLI_HOME_METADATA_KEY = "homeDir";

type ClaudeCliAuthProfileCredential = {
  type?: string;
  provider?: string;
  metadata?: Record<string, string>;
};

type ClaudeCliAuthHomeContext = {
  authProfileId?: string;
};

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readClaudeCliAuthProfileCredential(
  credential: unknown,
): ClaudeCliAuthProfileCredential | undefined {
  if (!isRecord(credential)) {
    return undefined;
  }
  return credential as ClaudeCliAuthProfileCredential;
}

function throwUnsupportedClaudeCliCredential(
  authProfileId: string,
  credential: ClaudeCliAuthProfileCredential,
): never {
  throw new Error(
    `Claude CLI auth profile "${authProfileId}" has provider "${credential.provider ?? "unknown"}", ` +
      `but Claude CLI execution requires a "${CLAUDE_CLI_BACKEND_ID}" auth profile.`,
  );
}

function resolveClaudeCliHomeDir(credential: ClaudeCliAuthProfileCredential): string | undefined {
  return normalizeString(credential.metadata?.[CLAUDE_CLI_HOME_METADATA_KEY]);
}

/**
 * Builds the prepareExecution result for one Claude CLI run.
 *
 * Returns null when no auth profile was selected (legacy static single-seat
 * config, or no profiles registered yet for this provider): the caller keeps
 * whatever CLAUDE_CONFIG_DIR the backend's own config/env already resolved,
 * so this hook is a no-op until profiles actually exist in the store.
 */
export async function prepareClaudeCliAuthHome(
  ctx: ClaudeCliAuthHomeContext,
  credential: unknown,
): Promise<CliBackendPreparedExecution | null> {
  const authProfileId = normalizeString(ctx.authProfileId);
  if (!authProfileId) {
    return null;
  }

  const parsed = readClaudeCliAuthProfileCredential(credential);
  if (!parsed) {
    throw new Error(
      `Claude CLI auth profile "${authProfileId}" was selected but no credential material was found. ` +
        "Re-register this profile with its Claude Code CLI login directory.",
    );
  }
  if (parsed.provider !== CLAUDE_CLI_BACKEND_ID) {
    throwUnsupportedClaudeCliCredential(authProfileId, parsed);
  }

  const homeDir = resolveClaudeCliHomeDir(parsed);
  if (!homeDir) {
    throw new Error(
      `Claude CLI auth profile "${authProfileId}" has no registered CLAUDE_CONFIG_DIR home directory ` +
        `(credential.metadata.${CLAUDE_CLI_HOME_METADATA_KEY}). Re-register this profile with its Claude ` +
        "Code CLI login directory.",
    );
  }
  if (!path.isAbsolute(homeDir)) {
    throw new Error(
      `Claude CLI auth profile "${authProfileId}" has a non-absolute home directory: ${homeDir}`,
    );
  }

  return {
    env: {
      CLAUDE_CONFIG_DIR: homeDir,
    },
    beforeExecution: async () => {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(homeDir);
      } catch (error) {
        throw new Error(
          `Claude CLI auth profile "${authProfileId}" home directory is not accessible: ${homeDir} (${String(error)})`,
          { cause: error },
        );
      }
      if (!stat.isDirectory()) {
        throw new Error(
          `Claude CLI auth profile "${authProfileId}" home directory is not a directory: ${homeDir}`,
        );
      }
    },
  };
}
