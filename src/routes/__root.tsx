import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { ThemeRoot } from "@/components/font-studio/theme-root";
import { AppShell } from "@/components/font-studio/app-shell";
import { THEME_BOOTSTRAP } from "@/lib/theme";
import appCss from "../styles.css?url";

const APP_NAME = "Font Manager";

function Frame() {
  return (
    <>
      <PreviewHostBridge />
      <ThemeRoot>
        <AuthProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </AuthProvider>
      </ThemeRoot>
    </>
  );
}

function isDesktopSpa() {
  return typeof document !== "undefined" && Boolean(document.getElementById("fm-root"));
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Preview, organize, and pair typefaces. A studio for Fontsource and your own files.",
      },
      { name: "theme-color", content: "#0c0c0d" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://cdn.jsdelivr.net", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: () => {
    if (isDesktopSpa()) return <Frame />;
    return (
      <html lang="en" className="antialiased" data-theme="dark" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
          <HeadContent />
        </head>
        <body className="bg-background text-foreground">
          <Frame />
          <Scripts />
        </body>
      </html>
    );
  },
});