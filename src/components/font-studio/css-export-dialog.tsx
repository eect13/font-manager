import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/copy-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  exportBundle,
  exportFontFamilies,
  exportGoogleImport,
  exportLinkTag,
  exportLocalFaces,
  exportTailwind,
} from "@/lib/fonts/css-export";
import { findFont, useFontStore } from "@/lib/fonts/store";

export function CssExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const activated = useFontStore((s) => s.activated);
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const selectedId = useFontStore((s) => s.selectedId);
  const [copied, setCopied] = useState<string | null>(null);

  const fonts = useMemo(() => {
    const ids = selectedId ? [selectedId, ...activated.filter((id) => id !== selectedId)] : activated;
    return ids
      .map((id) => findFont(id, localFonts, googleFonts))
      .filter((f): f is NonNullable<typeof f> => Boolean(f));
  }, [activated, localFonts, googleFonts, selectedId]);

  const snippets = {
    bundle: exportBundle(fonts),
    import: exportGoogleImport(fonts) || "/* No Fontsource families in the current set */",
    link: exportLinkTag(fonts) || "<!-- No Fontsource families in the current set -->",
    families: exportFontFamilies(fonts),
    faces: exportLocalFaces(fonts) || "/* No uploaded files — Fontsource CSS does not need local @font-face */",
    tailwind: exportTailwind(fonts),
  };

  async function copy(key: string, value: string) {
    try {
      await copyText(value);
      setCopied(key);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      toast.error("Clipboard blocked — select the CSS and press Ctrl+C");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>CSS export</DialogTitle>
          <DialogDescription>
            {fonts.length
              ? `Activated typefaces${selectedId ? ", with the open specimen first" : ""}.`
              : "Activate a typeface to export CSS."}
          </DialogDescription>
        </DialogHeader>
        {fonts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Toggle On on any card to include it here.
          </p>
        ) : (
          <Tabs defaultValue="bundle">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="bundle">All</TabsTrigger>
              <TabsTrigger value="import">@import</TabsTrigger>
              <TabsTrigger value="link">Link</TabsTrigger>
              <TabsTrigger value="families">Stacks</TabsTrigger>
              <TabsTrigger value="faces">@font-face</TabsTrigger>
              <TabsTrigger value="tailwind">Theme</TabsTrigger>
            </TabsList>
            {Object.entries(snippets).map(([key, value]) => (
              <TabsContent key={key} value={key} className="relative">
                <pre className="max-h-64 overflow-auto rounded-lg bg-secondary p-3 font-mono text-xs leading-relaxed text-foreground">
                  {value}
                </pre>
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute right-2 top-2"
                  onClick={() => copy(key, value)}
                >
                  {copied === key ? <Check /> : <Copy />}
                  {copied === key ? "Copied" : "Copy"}
                </Button>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
