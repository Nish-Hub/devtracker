// The "Big O" difficulty classes and how they map to the minimum model tier
// that can handle them. Ordering is what makes the cascade cheap-first.

/** Difficulty classes, easiest → hardest. */
export const CLASSES = ['O(1)', 'O(log n)', 'O(n)', 'O(n^2)'];

/** Model tiers, cheapest/weakest → strongest. */
export const TIERS = ['cheap', 'mid', 'strong'];

/** Minimum tier a task class requires. A provider qualifies if its tier >= this. */
export const CLASS_MIN_TIER = {
  'O(1)': 'cheap',
  'O(log n)': 'cheap',
  'O(n)': 'mid',
  'O(n^2)': 'strong',
};

export const tierRank = tier => {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
};

export const classRank = cls => {
  const i = CLASSES.indexOf(cls);
  return i < 0 ? 0 : i;
};

/** Does a provider's tier meet the minimum required by this task class? */
export function tierMeetsClass(tier, cls) {
  return tierRank(tier) >= tierRank(CLASS_MIN_TIER[cls] || 'cheap');
}
