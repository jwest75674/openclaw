/**
 * Pure cooldown and unusable-window helpers for auth profile usage state.
 * Mutation and persistence live in usage.ts; this module owns reusable state
 * predicates used by rotation and failure handling.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import {
  GEMINI_QUOTA_TIER_DAILY_LIMITS,
  isGeminiQuotaTier,
  isGoogleGeminiCliProvider,
  utcDateKey,
} from "./gemini-quota-tiers.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

/** Returns true for providers whose auth-profile cooldowns are provider-managed. */
export function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "openrouter" || normalized === "kilocode";
}

// Per-attempt transient failures (#87462): block only the failing model so
// fallback models on the same auth profile can still try. Other reasons (auth,
// billing, format, server_error) remain profile-wide.
/** Returns true when a failure should only cool down the failing model. */
export function isModelScopedCooldownReason(reason: AuthProfileFailureReason | undefined): boolean {
  return reason === "rate_limit" || reason === "timeout";
}

/** Resolves the latest active blocked/cooldown/disabled timestamp for a profile. */
export function resolveProfileUnusableUntil(
  stats: Pick<ProfileUsageStats, "blockedUntil" | "cooldownUntil" | "disabledUntil">,
): number | null {
  const values = [stats.blockedUntil, stats.cooldownUntil, stats.disabledUntil]
    .map((value) => asDateTimestampMs(value))
    .filter((value): value is number => value !== undefined && value > 0);
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

/** Returns true when an unusable timestamp is active at the supplied clock time. */
export function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  const timestamp = asDateTimestampMs(until);
  return timestamp !== undefined && timestamp > 0 && now < timestamp;
}

/**
 * Returns true when `forModel` names a Gemini quota tier ("pro" | "flash")
 * and the given profile has already reached that tier's known daily request
 * ceiling for the current UTC date. This lets profile selection skip a
 * profile that our own counting knows is exhausted, without waiting for an
 * actual 429 from Google.
 */
function isProfileOverDailyGeminiQuota(params: {
  store: AuthProfileStore;
  profileId: string;
  stats: ProfileUsageStats;
  forModel: string | undefined;
  now: number;
}): boolean {
  const { store, profileId, stats, forModel, now } = params;
  if (!forModel || !isGeminiQuotaTier(forModel)) {
    return false;
  }
  if (!isGoogleGeminiCliProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const todayCount = stats.dailyRequestCounts?.[utcDateKey(now)]?.[forModel] ?? 0;
  return todayCount >= GEMINI_QUOTA_TIER_DAILY_LIMITS[forModel];
}

/**
 * Returns true when a tier-scoped cooldown (set after a classified Gemini
 * daily-quota-exhaustion failure) is currently active for `forModel`
 * (expected to be a tier name for gemini-cli profiles). Independent of the
 * profile-wide cooldown fields so a pro-tier cooldown never blocks flash.
 */
function isTierCooldownActive(
  stats: Pick<ProfileUsageStats, "tierCooldowns">,
  forModel: string | undefined,
  now: number,
): boolean {
  if (!forModel) {
    return false;
  }
  const until = stats.tierCooldowns?.[forModel];
  return typeof until === "number" && Number.isFinite(until) && until > now;
}

/** Resolves the active tier-scoped cooldown-until timestamp, or null. */
export function resolveTierCooldownUntil(
  stats: Pick<ProfileUsageStats, "tierCooldowns"> | undefined,
  tier: string | undefined,
  now: number,
): number | null {
  if (!tier) {
    return null;
  }
  const until = stats?.tierCooldowns?.[tier];
  return typeof until === "number" && Number.isFinite(until) && until > now ? until : null;
}

function shouldBypassModelScopedCooldown(
  stats: Pick<
    ProfileUsageStats,
    "blockedUntil" | "cooldownReason" | "cooldownModel" | "disabledUntil"
  >,
  now: number,
  forModel?: string,
): boolean {
  return Boolean(
    forModel &&
    isModelScopedCooldownReason(stats.cooldownReason) &&
    stats.cooldownModel &&
    stats.cooldownModel !== forModel &&
    !isActiveUnusableWindow(stats.blockedUntil, now) &&
    !isActiveUnusableWindow(stats.disabledUntil, now),
  );
}

/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  now?: number,
  forModel?: string,
): boolean {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const ts = now ?? Date.now();
  // Gemini per-tier daily quota: treat a profile that our own counting knows
  // has hit today's cap for the requested tier as unavailable for that tier,
  // independent of (and in addition to) the generic cooldown fields below.
  if (isProfileOverDailyGeminiQuota({ store, profileId, stats, forModel, now: ts })) {
    return true;
  }
  // Tier-scoped cooldown set after a classified daily-quota-exhaustion
  // failure (see markAuthProfileGeminiQuotaExhausted). Independent of the
  // profile-wide cooldown fields so a pro-tier cooldown never blocks flash.
  if (isTierCooldownActive(stats, forModel, ts)) {
    return true;
  }
  // Model-aware bypass: if the cooldown was caused by a model-scoped reason on a
  // specific model and the caller is requesting a *different* model, allow it.
  // We still honour profile-wide blocked/disabled windows; they must not be
  // short-circuited by model scoping.
  if (shouldBypassModelScopedCooldown(stats, ts, forModel)) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil ? ts < unusableUntil : false;
}

/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
  options?: { now?: number; forModel?: string },
): number | null {
  const ts = options?.now ?? Date.now();
  let soonest: number | null = null;
  let latestMatchingModelCooldown: number | null = null;
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) {
      continue;
    }
    if (shouldBypassModelScopedCooldown(stats, ts, options?.forModel)) {
      continue;
    }
    const until = resolveProfileUnusableUntil(stats);
    if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
      continue;
    }
    const matchingModelScopedCooldown =
      options?.forModel &&
      stats.cooldownReason === "rate_limit" &&
      stats.cooldownModel === options.forModel &&
      !isActiveUnusableWindow(stats.blockedUntil, ts) &&
      !isActiveUnusableWindow(stats.disabledUntil, ts);
    if (matchingModelScopedCooldown) {
      latestMatchingModelCooldown =
        latestMatchingModelCooldown === null ? until : Math.max(latestMatchingModelCooldown, until);
      continue;
    }
    if (soonest === null || until < soonest) {
      soonest = until;
    }
  }
  if (soonest === null) {
    return latestMatchingModelCooldown;
  }
  if (latestMatchingModelCooldown === null) {
    return soonest;
  }
  return Math.min(soonest, latestMatchingModelCooldown);
}

/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open -> closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown -- the root cause of profiles appearing "stuck" after rate limits.
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileSuccess` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) {
    return false;
  }

  const ts = now ?? Date.now();
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) {
      continue;
    }

    let profileMutated = false;
    const cooldownExpired =
      typeof stats.cooldownUntil === "number" &&
      Number.isFinite(stats.cooldownUntil) &&
      stats.cooldownUntil > 0 &&
      ts >= stats.cooldownUntil;
    const blockedExpired =
      typeof stats.blockedUntil === "number" &&
      Number.isFinite(stats.blockedUntil) &&
      stats.blockedUntil > 0 &&
      ts >= stats.blockedUntil;
    const disabledExpired =
      typeof stats.disabledUntil === "number" &&
      Number.isFinite(stats.disabledUntil) &&
      stats.disabledUntil > 0 &&
      ts >= stats.disabledUntil;

    if (cooldownExpired) {
      stats.cooldownUntil = undefined;
      stats.cooldownReason = undefined;
      stats.cooldownModel = undefined;
      profileMutated = true;
    }
    if (blockedExpired) {
      stats.blockedUntil = undefined;
      stats.blockedReason = undefined;
      stats.blockedSource = undefined;
      stats.blockedModel = undefined;
      profileMutated = true;
    }
    if (disabledExpired) {
      stats.disabledUntil = undefined;
      stats.disabledReason = undefined;
      profileMutated = true;
    }

    if (stats.tierCooldowns) {
      const nextTierCooldowns: Record<string, number> = {};
      let tierCooldownsMutated = false;
      for (const [tier, until] of Object.entries(stats.tierCooldowns)) {
        if (typeof until === "number" && Number.isFinite(until) && until > ts) {
          nextTierCooldowns[tier] = until;
        } else {
          tierCooldownsMutated = true;
        }
      }
      if (tierCooldownsMutated) {
        stats.tierCooldowns =
          Object.keys(nextTierCooldowns).length > 0 ? nextTierCooldowns : undefined;
        profileMutated = true;
      }
    }

    if (stats.dailyRequestCounts) {
      // Keep only today and yesterday (UTC) so counters cannot grow
      // unboundedly; anything older is stale for same-day quota checks.
      const keepKeys = new Set([utcDateKey(ts), utcDateKey(ts - 24 * 60 * 60 * 1000)]);
      const staleKeys = Object.keys(stats.dailyRequestCounts).filter((key) => !keepKeys.has(key));
      if (staleKeys.length > 0) {
        const pruned = { ...stats.dailyRequestCounts };
        for (const key of staleKeys) {
          delete pruned[key];
        }
        stats.dailyRequestCounts = Object.keys(pruned).length > 0 ? pruned : undefined;
        profileMutated = true;
      }
    }

    // Reset error counters when ALL cooldowns have expired so the profile gets
    // a fair retry window. Preserves lastFailureAt for the failureWindowMs
    // decay check in computeNextProfileUsageStats.
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      stats.errorCount = 0;
      stats.failureCounts = undefined;
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}
