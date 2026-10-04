import type { ArabicPreviewLines } from "@/lib/fonts/arabic-preview";

/**
 * FORM-S12 §4: Arabic pangram (rtl, start-aligned so it sits right), then the
 * user's Latin sample at 0.5em, ltr, in the same ink. The parent keeps the
 * font family, weight and colour; only size, direction and language change.
 */
export function ArabicPreviewText({ lines }: { lines: ArabicPreviewLines }) {
  return (
    <>
      <span className="block text-start" dir={lines.primary.dir} lang={lines.primary.lang}>
        {lines.primary.text}
      </span>
      {lines.secondary ? (
        <span
          className="block text-start"
          dir={lines.secondary.dir}
          lang={lines.secondary.lang}
          style={{ fontSize: "0.5em" }}
        >
          {lines.secondary.text}
        </span>
      ) : null}
    </>
  );
}
