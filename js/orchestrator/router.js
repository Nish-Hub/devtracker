// Router (ORCH-3, part 1). Given a classification, produce the ordered list of
// candidate providers the cascade will try: cheapest-qualifying first, then
// progressively stronger for escalation.

import { tierMeetsClass, tierRank } from './tiers.js';
import { applyPrivacy } from './privacy.js';

/**
 * @param {object} classification { class, sensitivity }
 * @param {object} registry  from createRegistry()
 * @param {object} [opts] { policy?: 'hard'|'prompt'|'cost' }
 * @returns {{ candidates, needsConsent }}
 */
export function route(classification, registry, opts = {}) {
  const cls = classification.class;
  const qualified = registry.enabled().filter(p => tierMeetsClass(p.tier, cls));
  const { providers, needsConsent } = applyPrivacy(
    qualified,
    classification.sensitivity,
    opts.policy || 'hard'
  );

  // Cheapest first (the cascade escalates up this list); tie-break by weaker
  // tier first so we exhaust cheap options before spending on a stronger model.
  const candidates = providers
    .slice()
    .sort((a, b) => a.costPer1k - b.costPer1k || tierRank(a.tier) - tierRank(b.tier));

  return { candidates, needsConsent };
}
