import { createFileRoute } from "@tanstack/react-router";
import { Playground } from "@/components/font-studio/playground";
import { UploadDropzone } from "@/components/font-studio/upload-dropzone";

export const Route = createFileRoute("/playground")({ component: () => null });

export function PlaygroundPage() {
  return (
    <UploadDropzone>
      <Playground />
    </UploadDropzone>
  );
}