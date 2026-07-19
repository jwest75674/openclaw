/**
 * Per-profile home-directory helpers for the Claude CLI backend.
 *
 * Mirrors extensions/google/gemini-cli-auth-home.ts's deterministic hashing
 * pattern. Unlike Gemini, OpenClaw does not own Anthropic subscription OAuth
 * refresh: the real `claude` CLI binary manages its own `.credentials.json`
 * in place inside whatever directory `CLAUDE_CONFIG_DIR` points at. So this
 * resolver exists for API symmetry and any future ephemeral-home use (for
 * example a fully OpenClaw-owned API-key profile), but the primary rotation
 * path (see cli-backend-auth.runtime.ts) instead redirects CLAUDE_CONFIG_DIR
 * straight at an already-authenticated external login directory recorded on
 * the selected auth profile.
 */
import crypto from "node:crypto";
import path from "node:path";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

export { CLAUDE_CLI_BACKEND_ID };

/** Resolves a deterministic, collision-free per-profile home directory. */
export function resolveClaudeCliProfileHome(agentDir: string, profileId: string): string {
  const profileHash = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 24);
  return path.join(agentDir, `${CLAUDE_CLI_BACKEND_ID}-home`, "profiles", profileHash);
}
