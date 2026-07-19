/**
 * Gemini CLI daily request-quota tiers.
 *
 * Google's Gemini API enforces two independent per-account daily request
 * quotas: Pro-tier models (50 requests/day) and Flash-tier models
 * (1500 requests/day), both resetting at UTC midnight. Exhausting one tier's
 * quota does not exhaust the other tier's quota on the same account.
 *
 * These sets/limits mirror GEMINI_LIMITS / PRO_MODELS / FLASH_MODELS in the
 * companion openclaw-workspace repo's scripts/ops/session_usage_report.py,
 * which derives them from Gemini's published free-tier rate limits.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

/** Gemini daily-quota tier classification. */
export type GeminiQuotaTier = "pro" | "flash";

const GEMINI_PRO_MODELS = new Set<string>([
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
]);

const GEMINI_FLASH_MODELS = new Set<string>(["gemini-2.5-flash", "gemini-3-flash-preview"]);

/** Known daily request-count ceilings per Gemini quota tier. */
export const GEMINI_QUOTA_TIER_DAILY_LIMITS: Record<GeminiQuotaTier, number> = {
  pro: 50,
  flash: 1500,
};

/** CLI-backend provider id used for Gemini CLI auth profiles. */
export const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";

/** Returns true when `provider` is the gemini-cli CLI backend provider id. */
export function isGoogleGeminiCliProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}

/**
 * Classifies a resolved Gemini model id into its daily-quota tier.
 * Returns null for models with no known daily-quota tier (e.g. flash-lite,
 * or an unrecognized/future model id) so callers can fall back to
 * model-scoped (rather than tier-scoped) handling.
 */
export function classifyGeminiQuotaTier(modelId: string | undefined): GeminiQuotaTier | null {
  const normalized = modelId?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (GEMINI_PRO_MODELS.has(normalized)) {
    return "pro";
  }
  if (GEMINI_FLASH_MODELS.has(normalized)) {
    return "flash";
  }
  return null;
}

/** Returns true for a recognized Gemini quota tier string. */
export function isGeminiQuotaTier(value: string | undefined): value is GeminiQuotaTier {
  return value === "pro" || value === "flash";
}

/** Returns the UTC calendar-date key ("YYYY-MM-DD") for a clock time. */
export function utcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Returns the epoch-ms timestamp of the next UTC midnight strictly after `nowMs`. */
export function resolveNextUtcMidnightMs(nowMs: number): number {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return nextMidnight;
}

/**
 * Heuristic detection of a Gemini daily-quota-exhaustion error from raw CLI
 * stderr/stdout text. Gemini's API reports quota exhaustion as HTTP 429 with
 * `status: "RESOURCE_EXHAUSTED"`; the per-day request quota specifically is
 * reported via a quota id such as
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier" -- gemini-cli typically
 * dumps the raw API error JSON to stderr verbatim, so that id (camelCase,
 * with no word-boundary separators) appears as literal substring text rather
 * than a standalone "day"/"daily" word. We therefore match loosely
 * (RESOURCE_EXHAUSTED/429 + quota + a "day" substring) rather than parsing a
 * fixed JSON shape, since gemini-cli does not expose a structured error
 * channel to OpenClaw.
 */
export function isGeminiDailyQuotaExhaustedErrorText(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const hasExhaustionSignal = /resource_exhausted|\b429\b/i.test(raw);
  if (!hasExhaustionSignal) {
    return false;
  }
  const mentionsQuota = /\bquota\b/i.test(raw);
  if (!mentionsQuota) {
    return false;
  }
  return /perday|per[\s_-]day|daily/i.test(raw);
}
