// Cost-aware cascade (ORCH-3, ORCH-ADR-002). Run the cheapest candidate, verify
// its output, and escalate one step at a time only when verification fails. This
// is what spends strong-model tokens only on tasks that provably need them.

import { estTokens } from './classifier.js';

/**
 * @param {object} args
 *   candidates:  ordered providers (cheapest first) from route()
 *   payload:     the chat-completions payload ({ messages, ... })
 *   callModel:   async (provider, payload) => { content, tokensIn?, tokensOut? }
 *   verify:      (content) => boolean
 *   maxAttempts: cap on models tried (default: all candidates)
 * @returns {Promise<{ content, routing }>}
 */
export async function runCascade({ candidates, payload, callModel, verify, maxAttempts }) {
  const attempts = [];
  const cap = Math.min(maxAttempts || candidates.length, candidates.length);
  let last = { content: '', provider: null, tokensIn: 0, tokensOut: 0 };

  for (let i = 0; i < cap; i++) {
    const provider = candidates[i];
    let res,
      error = null;
    try {
      res = await callModel(provider, { ...payload, model: provider.model || payload.model });
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      res = { content: '' };
    }
    const content = (res && res.content) || '';
    const tokensIn =
      res && Number.isFinite(res.tokensIn)
        ? res.tokensIn
        : estTokens(JSON.stringify(payload.messages || ''));
    const tokensOut = res && Number.isFinite(res.tokensOut) ? res.tokensOut : estTokens(content);
    const ok = !error && verify(content);
    attempts.push({
      provider: provider.id,
      tier: provider.tier,
      ok,
      error,
      tokensIn,
      tokensOut,
      cost: cost(provider, tokensIn, tokensOut),
    });
    last = { content, provider, tokensIn, tokensOut };
    if (ok) {
      return { content, routing: routing(provider, attempts, false) };
    }
  }

  // All candidates failed verification — return the last answer, flagged.
  return {
    content: last.content,
    routing: routing(last.provider, attempts, true),
  };
}

function cost(provider, tokensIn, tokensOut) {
  return Number((((tokensIn + tokensOut) / 1000) * (provider.costPer1k || 0)).toFixed(4));
}

function routing(provider, attempts, exhausted) {
  const totalIn = attempts.reduce((a, x) => a + x.tokensIn, 0);
  const totalOut = attempts.reduce((a, x) => a + x.tokensOut, 0);
  return {
    chosen: provider ? provider.id : null,
    chosenTier: provider ? provider.tier : null,
    chosenLocation: provider ? provider.location : null,
    escalations: Math.max(attempts.length - 1, 0),
    exhausted,
    attempts,
    tokensIn: totalIn,
    tokensOut: totalOut,
    estCost: Number(attempts.reduce((a, x) => a + x.cost, 0).toFixed(4)),
  };
}
