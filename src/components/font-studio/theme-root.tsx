import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { hydrateTheme, useTheme } from "@/lib/theme";

export function ThemeRoot({ children }: { children: ReactNode }) {
  const theme = useTheme();

  useEffect(() => {
    hydrateTheme();
  }, []);

  return (
    <>
      {children}
      <Toaster
        theme={theme}
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--color-card)",
            color: "var(--color-foreground)",
            border: "1px solid var(--color-border)",
          },
        }}
      />
    </>
  );
}
