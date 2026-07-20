// OrchestratorLLM entry point. Ties classify → route → cascade together into a
// single call. Everything external (model calls, local-LLM classification) is
// injected, so the whole pipeline is testable offline with fakes.

import { classify } from './classifier.js';
import { createRegistry } from './registry.js';
import { route } from './router.js';
import { makeVerifier } from './verify.js';

/**
 * @param {object} request
 *   task:      { taskType?, text?, hint? }  (text usually = the user prompt)
 *   payload:   OpenAI-style { messages, temperature?, ... }
 *   providers: array of provider records (registry input)
 *   verifySpec?: { minLen?, expectJson?, marker? }  OR verify?: (content)=>bool
 * @param {object} deps
 *   callModel:    async (provider, payload) => { content, tokensIn?, tokensOut? }
 *   llmClassify?: async ({text}) => 'O(1)'|...   (optional local-LLM disambiguation)
 *   allowLlm?:    bool
 *   policy?:      'hard'|'prompt'|'cost'  (privacy policy; default 'hard')
 *   maxAttempts?: number
 * @returns {Promise<{ content, routing, classification }>}
 */
export async function orchestrate(request, deps) {
  const { runCascade } = await import('./cascade.js');
  const classification = await classify(request.task || {}, {
    llmClassify: deps.llmClassify,
    allowLlm: deps.allowLlm,
  });

  const registry = createRegistry(request.providers || []);
  const { candidates, needsConsent } = route(classification, registry, {
    policy: deps.policy || 'hard',
  });

  if (!candidates.length) {
    return {
      content: '',
      classification,
      routing: {
        chosen: null,
        needsConsent,
        exhausted: true,
        attempts: [],
        escalations: 0,
        tokensIn: 0,
        tokensOut: 0,
        estCost: 0,
        reason: needsConsent
          ? 'privacy: sensitive task needs consent for a hosted model'
          : 'no enabled provider qualifies for this task class',
      },
    };
  }

  const verify =
    typeof request.verify === 'function' ? request.verify : makeVerifier(request.verifySpec || {});

  const out = await runCascade({
    candidates,
    payload: request.payload || {},
    callModel: deps.callModel,
    verify,
    maxAttempts: deps.maxAttempts,
  });
  out.routing.needsConsent = needsConsent;
  out.classification = classification;
  return out;
}

export { classify } from './classifier.js';
export { createRegistry } from './registry.js';
export { route } from './router.js';
export { makeVerifier } from './verify.js';
