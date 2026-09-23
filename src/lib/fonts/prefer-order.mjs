/**
 * Prefer-first waves for session restore + Activate All (1.0.206l).
 *
 * Wave order (earliest wins; within-wave preserves input order):
 *   selected → favorites → viewport-visible → first-page (scope) → recent → remainder
 *
 * Honesty unchanged elsewhere: Live only after Add>0; Settled/hard never queued;
 * no parallel AddFontResourceEx — this module only reorders enqueue.
 */

/** ≈ one library grid page / Cancel first-page fallback. */
export const PREFER_FIRST_PAGE = 24;

/** Recent prefer window (matches hydrate / Activate recent24). */
export const PREFER_RECENT = 24;

/**
 * @param {string} key
 * @returns {string}
 */
function normKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Stable multi-wave order. Keys already in an earlier wave are skipped later.
 *
 * @param {string[]} keys candidate keys (ids or family names) in original order
 * @param {object} [waves]
 * @param {string|null} [waves.selected]
 * @param {readonly string[]} [waves.favorites]
 * @param {readonly string[]} [waves.visible]
 * @param {readonly string[]} [waves.firstPage]
 * @param {readonly string[]} [waves.recent]
 * @param {boolean} [waves.caseFold] when true, compare via trim+lower (family names)
 * @returns {string[]}
 */
export function orderPreferKeys(keys, waves = {}) {
  if (!keys.length) return [];
  const fold = Boolean(waves.caseFold);
  const norm = fold ? normKey : (k) => String(k ?? "");
  const toSet = (list) => {
    const s = new Set();
    for (const item of list ?? []) {
      const n = norm(item);
      if (n) s.add(n);
    }
    return s;
  };
  const selected =
    waves.selected != null && String(waves.selected) !== ""
      ? toSet([waves.selected])
      : new Set();
  const tiers = [
    selected,
    toSet(waves.favorites),
    toSet(waves.visible),
    toSet(waves.firstPage),
    toSet((waves.recent ?? []).slice(0, PREFER_RECENT)),
  ];
  const seen = new Set();
  const out = [];
  for (const tier of tiers) {
    if (!tier.size) continue;
    for (const key of keys) {
      const n = norm(key);
      if (!n || seen.has(n) || !tier.has(n)) continue;
      out.push(key);
      seen.add(n);
    }
  }
  for (const key of keys) {
    const n = norm(key);
    if (!n || seen.has(n)) continue;
    out.push(key);
    seen.add(n);
  }
  return out;
}

/**
 * Activate wave0 prefer membership: selected + favorites + viewport + first-page + recent.
 * Matches restore early waves so Cancel "keep first N" covers the same set.
 *
 * @param {string[]} ids
 * @param {object} [ctx]
 * @param {string|null} [ctx.selectedId]
 * @param {readonly string[]} [ctx.favoriteIds]
 * @param {readonly string[]} [ctx.visibleIds]
 * @param {readonly string[]} [ctx.firstPageIds]
 * @param {readonly string[]} [ctx.recentIds]
 * @returns {Set<string>}
 */
export function activatePreferIdSet(ids, ctx = {}) {
  const idSet = new Set(ids);
  const prefer = new Set();
  const add = (id) => {
    if (id && idSet.has(id)) prefer.add(id);
  };
  add(ctx.selectedId ?? null);
  for (const id of ctx.favoriteIds ?? []) add(id);
  for (const id of ctx.visibleIds ?? []) add(id);
  for (const id of ctx.firstPageIds ?? []) add(id);
  for (const id of (ctx.recentIds ?? []).slice(0, PREFER_RECENT)) add(id);
  return prefer;
}

/**
 * Split ordered ids into wave0 prefer vs remainder (bulk after confirm).
 *
 * @param {string[]} orderedIds
 * @param {object} [ctx]
 * @returns {{ prefer: string[], remainder: string[] }}
 */
export function splitPreferRemainderIds(orderedIds, ctx = {}) {
  const preferSet = activatePreferIdSet(orderedIds, ctx);
  const prefer = [];
  const remainder = [];
  for (const id of orderedIds) {
    (preferSet.has(id) ? prefer : remainder).push(id);
  }
  return { prefer, remainder };
}
