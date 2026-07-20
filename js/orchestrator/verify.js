// Verifier gate (ORCH-3, part 2). Cheap quality checks that decide whether a
// model's answer is good enough or the cascade should escalate. Callers can pass
// a task-specific verifier; these are the sensible defaults.

const ERROR_SHAPES = [/^\s*$/, /^(i'm sorry|i cannot|as an ai|i am unable)/i];

export function nonEmpty(content) {
  return typeof content === 'string' && !ERROR_SHAPES.some(re => re.test(content));
}

/** Content must contain a fenced block that parses as JSON. */
export function hasJsonBlock(content) {
  const m = String(content || '').match(/```[a-z-]*\s*([\s\S]*?)```/i);
  if (!m) return false;
  try {
    JSON.parse(m[1].trim());
    return true;
  } catch {
    return false;
  }
}

/** Content must contain a required marker (e.g. "REVISED DESCRIPTION:"). */
export const hasMarker = marker => content =>
  String(content || '')
    .toUpperCase()
    .includes(String(marker).toUpperCase());

/**
 * Build a verifier from a spec: { minLen?, expectJson?, marker? }.
 * Returns (content) => boolean.
 */
export function makeVerifier(spec = {}) {
  return content => {
    if (!nonEmpty(content)) return false;
    if (spec.minLen && String(content).trim().length < spec.minLen) return false;
    if (spec.expectJson && !hasJsonBlock(content)) return false;
    if (spec.marker && !hasMarker(spec.marker)(content)) return false;
    return true;
  };
}
