/**
 * Shared Activate remaining / queue filter (1.0.206i).
 * Settled + hard Gidugu skip; pendingDeactivate aligned with catalog remaining.
 * Plain ESM so tip runtime can assert remaining === activateQueueIds(...).length.
 *
 * Hard-incapable check mirrors `isKnownGdiSessionIncapable` (Gidugu only) —
 * tip no-regress keeps TS/Rust allowlist in sync.
 */

/** @param {string} family */
function isHardGdiIncapable(family) {
  return family.trim().toLowerCase() === "gidugu";
}

/**
 * @param {string} id
 * @param {{ id: string }[]} local
 * @param {{ id: string }[]} google
 */
function findFontRecord(id, local, google) {
  return local.find((f) => f.id === id) ?? google.find((f) => f.id === id);
}

/**
 * Same filter as activateSet queue — Settled + hard Gidugu + pending-off skipped.
 * @param {string[]} ids
 * @param {{
 *   activatedSet: Set<string>,
 *   pendingSet: Set<string>,
 *   pendingDeactivateSet: Set<string>,
 *   settledFamilySet: Set<string>,
 *   localFonts: { id: string, family: string, source: string }[],
 *   googleFonts: { id: string, family: string, source: string }[],
 * }} state
 * @returns {string[]}
 */
export function activateQueueIds(ids, state) {
  const usable = [];
  for (const id of ids) {
    if (state.activatedSet.has(id) || state.pendingSet.has(id)) continue;
    if (state.pendingDeactivateSet.has(id)) continue;
    const font = findFontRecord(id, state.localFonts, state.googleFonts);
    if (!font || font.source === "system") continue;
    if (state.settledFamilySet.has(font.family.trim().toLowerCase())) continue;
    if (isHardGdiIncapable(font.family)) continue;
    usable.push(id);
  }
  return usable;
}

/**
 * Catalog / library "Activate remaining" — must call activateQueueIds.
 * @param {{ id: string, family: string, source: string }[]} fonts
 * @param {Parameters<typeof activateQueueIds>[1]} state
 * @param {((font: { id: string, family: string, source: string }) => boolean)=} filter
 * @returns {number}
 */
export function catalogMenuRemaining(fonts, state, filter) {
  const ids = [];
  for (const font of fonts) {
    if (filter && !filter(font)) continue;
    ids.push(font.id);
  }
  return activateQueueIds(ids, state).length;
}
