/** Merge a download progress name list into the names already seen.
 * Events send only the new tail (so a 2,000-family job does not freeze the WebView).
 * Polls send the full list. A full list replaces; a tail appends. Order is kept. */
export function absorbReadyNames(prev: string[], incoming: string[]): string[] {
  if (!incoming.length) return prev;
  if (!prev.length) return incoming.slice();
  const prevFirst = prev[0]!.toLowerCase();
  const nextFirst = incoming[0]!.toLowerCase();
  if (incoming.length >= prev.length && nextFirst === prevFirst) return incoming.slice();
  const have = new Set(prev.map((name) => name.toLowerCase()));
  const out = prev.slice();
  for (const name of incoming) {
    const key = name.trim().toLowerCase();
    if (!key || have.has(key)) continue;
    have.add(key);
    out.push(name);
  }
  return out;
}
