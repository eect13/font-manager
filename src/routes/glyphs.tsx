import { createFileRoute } from "@tanstack/react-router";
import { GlyphMap } from "@/components/font-studio/glyph-map";
import { UploadDropzone } from "@/components/font-studio/upload-dropzone";

export const Route = createFileRoute("/glyphs")({ component: () => null });

export function GlyphsPage() {
  return (
    <UploadDropzone>
      <GlyphMap />
    </UploadDropzone>
  );
}