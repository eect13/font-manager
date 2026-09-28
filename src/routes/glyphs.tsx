import { createFileRoute } from "@tanstack/react-router";
import { GlyphMap } from "@/components/font-studio/glyph-map";
import { UploadDropzone } from "@/components/font-studio/upload-dropzone";

export const Route = createFileRoute("/glyphs")({ component: () => null });

export function GlyphsPage() {
  return (
    <UploadDropzone>
      <h1 className="sr-only">Glyphs</h1>
      <GlyphMap />
    </UploadDropzone>
  );
}