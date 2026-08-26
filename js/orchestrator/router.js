// Router (ORCH-3, part 1). Given a classification, produce the ordered list of
// candidate providers the cascade will try: cheapest-qualifying first, then
// progressively stronger for escalation.

import { tierMeetsClass, tierRank } from './tiers.js';
import { applyPrivacy } from './privacy.js';

/**
 * @param {object} classification { class, sensitivity }
 * @param {object} registry  from createRegistry()
 * @param {object} [opts] { policy?: 'hard'|'prompt'|'cost', bestEffort?: bool }
 * @returns {{ candidates, needsConsent, underProvisioned }}
 *
 * Privacy is applied first (a hard gate over ALL enabled providers), then the
 * tier filter. When nothing meets the required tier and `bestEffort` is set, we
 * fall back to the strongest privacy-permissible provider available rather than
 * giving up — the right default for a local-first setup where the only models
 * on hand may be weaker than a task ideally wants.
 */
export function route(classification, registry, opts = {}) {
  const cls = classification.class;
  const { providers: permissible, needsConsent } = applyPrivacy(
    registry.enabled(),
    classification.sensitivity,
    opts.policy || 'hard'
  );

  const qualified = permissible.filter(p => tierMeetsClass(p.tier, cls));

  if (qualified.length) {
    // Cheapest first — the cascade escalates up this list, spending on a
    // stronger model only when a cheaper one fails verification.
    const candidates = qualified
      .slice()
      .sort((a, b) => a.costPer1k - b.costPer1k || tierRank(a.tier) - tierRank(b.tier));
    return { candidates, needsConsent, underProvisioned: false };
  }

  if (opts.bestEffort && permissible.length) {
    // Nothing is strong enough — use the best available, strongest first.
    const candidates = permissible
      .slice()
      .sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || a.costPer1k - b.costPer1k);
    return { candidates, needsConsent, underProvisioned: true };
  }

  return { candidates: [], needsConsent, underProvisioned: false };
}
