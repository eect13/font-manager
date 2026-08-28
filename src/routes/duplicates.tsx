import { createFileRoute } from "@tanstack/react-router";
import { DuplicateFinder } from "@/components/font-studio/duplicate-finder";
import { UploadDropzone } from "@/components/font-studio/upload-dropzone";

export const Route = createFileRoute("/duplicates")({ component: () => null });

export function DuplicatesPage() {
  return (
    <UploadDropzone>
      <DuplicateFinder />
    </UploadDropzone>
  );
}