// Provider registry (ORCH-1). Holds OpenAI-compatible providers plus the routing
// metadata that lets the router reason about them.

import { TIERS } from './tiers.js';

const REQUIRED = ['id', 'tier', 'location'];

/** Normalize + validate one provider record. Throws on an unusable provider. */
export function normalizeProvider(p) {
  p = p || {};
  for (const k of REQUIRED) {
    if (!p[k]) throw new Error(`Provider missing "${k}": ${JSON.stringify(p)}`);
  }
  if (!TIERS.includes(p.tier)) throw new Error(`Provider ${p.id}: invalid tier "${p.tier}"`);
  if (p.location !== 'local' && p.location !== 'hosted') {
    throw new Error(`Provider ${p.id}: location must be "local" or "hosted"`);
  }
  return {
    id: p.id,
    endpoint: p.endpoint || '',
    apiKey: p.apiKey || '',
    model: p.model || '',
    tier: p.tier,
    location: p.location,
    // Local providers keep data on-device → sensitivity-safe by default.
    sensitivityOK: p.sensitivityOK != null ? !!p.sensitivityOK : p.location === 'local',
    followsFormat: p.followsFormat != null ? !!p.followsFormat : true,
    costPer1k: Number.isFinite(p.costPer1k) ? p.costPer1k : p.location === 'local' ? 0 : 1,
    enabled: p.enabled !== false,
  };
}

export function createRegistry(providers = []) {
  const list = providers.map(normalizeProvider);
  return {
    all: () => list.slice(),
    enabled: () => list.filter(p => p.enabled),
    byId: id => list.find(p => p.id === id) || null,
  };
}
