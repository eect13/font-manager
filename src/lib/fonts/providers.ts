import type { FontRecord } from "./types";

/**
 * A source of typefaces. Activation is not a provider — Live still means
 * AddFontResourceExW returned more than 0.
 *
 * Google Fonts is the only remote catalog. Local files and watched folders
 * are the MainType-style vault (files you already have). System is view-only.
 */
export type ProviderId = "google" | "local" | "system";

export interface CatalogProvider {
  id: ProviderId;
  label: string;
  /** Can list families before any file is on disk. */
  remote: boolean;
  /** Default remote catalog. Only Google is remote today. */
  defaultRemote: boolean;
  /** How a preview or download is fetched. Rust owns the actual body. */
  recipe: "google-css2" | "disk" | "system";
}

export const PROVIDERS: readonly CatalogProvider[] = [
  {
    id: "google",
    label: "Google Fonts",
    remote: true,
    defaultRemote: true,
    recipe: "google-css2",
  },
  {
    id: "local",
    label: "Local Files",
    remote: false,
    defaultRemote: false,
    recipe: "disk",
  },
  {
    id: "system",
    label: "System",
    remote: false,
    defaultRemote: false,
    recipe: "system",
  },
];

export function defaultRemoteProvider(): CatalogProvider {
  const hit = PROVIDERS.find((provider) => provider.defaultRemote);
  if (!hit) throw new Error("No default remote font provider");
  return hit;
}

export function providerFor(font: FontRecord): CatalogProvider {
  if (font.source === "local") return PROVIDERS[1]!;
  if (font.source === "system") return PROVIDERS[2]!;
  return PROVIDERS[0]!;
}
