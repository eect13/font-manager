/** Viewport-visible family names for Activate All / restore prefer-first (1.0.205). */
const visible = new Set<string>();

function key(name: string): string {
  return name.trim().toLowerCase();
}

export function noteFamilyVisible(family: string, isVisible: boolean): void {
  const k = key(family);
  if (!k) return;
  if (isVisible) visible.add(k);
  else visible.delete(k);
}

export function visibleFamilyNames(): string[] {
  return Array.from(visible);
}

export function visibleFamilySet(): Set<string> {
  return new Set(visible);
}
