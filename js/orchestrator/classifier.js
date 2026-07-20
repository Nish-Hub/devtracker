// Task classifier (ORCH-ADR-001: hybrid). Heuristic-first — task type and size
// are usually enough — with an optional injected local-LLM to disambiguate the
// unclear cases. Never blocks on a missing LLM; falls back to the heuristic.

import { CLASSES } from './tiers.js';

/** Known task types → difficulty class. Data-driven so tiers stay tunable. */
export const TASK_CLASS = {
  // O(1): mechanical / structural
  ac_tick: 'O(1)',
  tag: 'O(1)',
  extract: 'O(1)',
  format: 'O(1)',
  conflict_check: 'O(1)',
  // O(log n): light reasoning / drafting
  ticket_draft: 'O(log n)',
  summary: 'O(log n)',
  brief: 'O(log n)',
  question: 'O(log n)',
  chat: 'O(log n)',
  // O(n): moderate reasoning
  decision_review: 'O(n)',
  architecture_review: 'O(n)',
  component_review: 'O(n)',
  enhance: 'O(n)',
  // O(n^2): hard / cross-cutting
  decision_debate: 'O(n^2)',
  architecture_debate: 'O(n^2)',
  tradeoff: 'O(n^2)',
};

/** Task types whose payloads are, by default, sensitive project content. */
const SENSITIVE_TASKS = new Set([
  'decision_review',
  'decision_debate',
  'architecture_review',
  'architecture_debate',
  'component_review',
  'tradeoff',
  'conflict_check',
]);

export const estTokens = text => Math.ceil(String(text || '').length / 4);

function heuristicClass({ taskType, text }) {
  if (taskType && TASK_CLASS[taskType]) return TASK_CLASS[taskType];
  // Fall back to size: tiny → trivial, large → moderate.
  const t = estTokens(text);
  if (t < 120) return 'O(1)';
  if (t < 800) return 'O(log n)';
  return 'O(n)';
}

function isAmbiguous({ taskType }) {
  // Unknown/absent task type is the case worth escalating to an LLM classifier.
  return !taskType || !TASK_CLASS[taskType];
}

/**
 * @param {object} task { taskType?, text?, hint? }  hint may carry { class, sensitivity }
 * @param {object} [deps] { llmClassify?: async ({text}) => 'O(1)'|... , allowLlm?: bool }
 * @returns {Promise<{class, estTokens, sensitivity, via}>}
 */
export async function classify(task, deps = {}) {
  const hint = task.hint || {};
  const tokens = estTokens(task.text);

  // An explicit, valid caller hint wins — the client often already knows.
  if (hint.class && CLASSES.includes(hint.class)) {
    return {
      class: hint.class,
      estTokens: tokens,
      sensitivity: resolveSensitivity(task),
      via: 'hint',
    };
  }

  let cls = heuristicClass(task);
  let via = 'heuristic';

  if (isAmbiguous(task) && deps.allowLlm && typeof deps.llmClassify === 'function') {
    try {
      const guess = await deps.llmClassify({ text: task.text });
      if (CLASSES.includes(guess)) {
        cls = guess;
        via = 'llm';
      }
    } catch {
      /* keep heuristic result */
    }
  }

  return { class: cls, estTokens: tokens, sensitivity: resolveSensitivity(task), via };
}

/** Privacy-first: unknown sensitivity resolves to 'high'. */
export function resolveSensitivity(task) {
  const hint = task.hint || {};
  if (hint.sensitivity === 'low' || hint.sensitivity === 'high') return hint.sensitivity;
  if (task.taskType && SENSITIVE_TASKS.has(task.taskType)) return 'high';
  if (task.taskType && TASK_CLASS[task.taskType]) return 'low'; // known + not flagged sensitive
  return 'high'; // unknown → treat as sensitive
}
