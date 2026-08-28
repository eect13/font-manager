import { createFileRoute } from "@tanstack/react-router";
import { LibraryGrid } from "@/components/font-studio/library-grid";
import { PreviewToolbar } from "@/components/font-studio/preview-toolbar";
import { UploadDropzone } from "@/components/font-studio/upload-dropzone";

export const Route = createFileRoute("/")({ component: () => null });

export function LibraryPage() {
  return (
    <UploadDropzone>
      <PreviewToolbar />
      <div data-library-scroll className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <LibraryGrid />
      </div>
    </UploadDropzone>
  );
}