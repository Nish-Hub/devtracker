// Privacy guard (ORCH-4, ORCH-ADR-003). A HARD gate applied before any provider
// is chosen: a sensitive task may only use sensitivity-safe (local) providers.
// Policy governs what happens when that leaves nothing strong enough.

export const POLICIES = ['hard', 'prompt', 'cost'];

/**
 * @param {Array} providers  candidate providers (already tier-filtered)
 * @param {'low'|'high'} sensitivity
 * @param {'hard'|'prompt'|'cost'} policy
 * @returns {{ providers, needsConsent }}
 *   hard   → sensitive tasks keep only sensitivityOK providers.
 *   prompt → same filter, but flags needsConsent when hosted options were dropped.
 *   cost   → no filtering (sensitivity is not a hard constraint).
 */
export function applyPrivacy(providers, sensitivity, policy = 'hard') {
  if (sensitivity !== 'high' || policy === 'cost') {
    return { providers: providers.slice(), needsConsent: false };
  }
  const safe = providers.filter(p => p.sensitivityOK);
  const droppedHosted = providers.some(p => !p.sensitivityOK);
  return { providers: safe, needsConsent: policy === 'prompt' && droppedHosted };
}
