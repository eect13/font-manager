export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const bytes = new Uint8Array(digest);
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      /* rust */
    }
  }
  const { nativeHashBytes } = await import("./native-parse");
  const hex = await nativeHashBytes(buffer);
  if (hex) return hex;
  throw new Error("SHA-256 unavailable");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
