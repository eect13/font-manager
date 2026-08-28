import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/** `tauri build` sets these. Skip Nitro SSR — the installer only needs static files + index.html. */
const isTauriBuild = Boolean(
  process.env.TAURI_ENV_PLATFORM || process.env.TAURI_ENV_FAMILY || process.env.TAURI_PLATFORM,
);

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

/** Windows: cargo / Defender lock files under src-tauri/target. Don't die on EBUSY. */
function windowsWatchGuardPlugin(): Plugin {
  return {
    name: "app-builder:watch-guard",
    apply: "serve",
    configureServer(server) {
      server.watcher.on("error", (err: NodeJS.ErrnoException) => {
        const code = err?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
          return;
        }
        console.error("[vite] watch error:", err);
      });
    },
  };
}

function inlineExportAllPlugin(): Plugin {
  return {
    name: "app-builder:inline-exportall",
    generateBundle(_, bundle) {
      const helper =
        "var __exportAll = (all) => { const target = {}; for (const name in all) Object.defineProperty(target, name, { get: all[name], enumerable: true }); return target; };\n";
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        if (!/import\s*\{[^}]*\bas __exportAll\b/.test(chunk.code)) continue;
        if (chunk.code.includes("_runtime.mjs") && /from ["'][^"']*_runtime/.test(chunk.code.slice(0, 400))) {
          continue;
        }
        chunk.code = chunk.code.replace(/(\s*),(\s*)\w+ as __exportAll(\s*),/g, "$1,$2");
        chunk.code = chunk.code.replace(/(\s*),(\s*)\w+ as __exportAll(\s*)/g, "$1");
        chunk.code = chunk.code.replace(/(\s*)\w+ as __exportAll(\s*),/g, "$1");
        chunk.code = helper + chunk.code;
      }
    },
  };
}

/**
 * Copy the *emitted* desktop.html (hashed assets) to index.html.
 * Never copy the source desktop.html — that still points at /src/main.tsx.
 */
function tauriIndexPlugin(): Plugin {
  let outDir = "";
  return {
    name: "tauri-desktop-index",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const desktop = join(outDir, "desktop.html");
      const index = join(outDir, "index.html");
      if (!existsSync(desktop)) return;
      const html = readFileSync(desktop, "utf8");
      if (!html.includes("fm-root") || html.includes("/src/main.tsx")) return;
      copyFileSync(desktop, index);
      console.log("[tauri-index] Vite closeBundle: index.html ← desktop.html");
    },
  };
}

// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => {
  if (isTauriBuild) {
    return {
      root: projectRoot,
      clearScreen: false,
      base: "./",
      // Vite 8: HTML entry is top-level `input`. `build.rollupOptions.input`
      // is dropped (types omit it on the dep-optimizer alias; Rolldown then
      // looks for index.html and the installer window is blank).
      input: join(projectRoot, "desktop.html"),
      plugins: [tailwindcss(), viteReact(), tauriIndexPlugin()],
      resolve: { tsconfigPaths: true },
      build: {
        outDir: join(projectRoot, ".vercel", "output", "static"),
        emptyOutDir: true,
        chunkSizeWarningLimit: 900,
        rolldownOptions: {
          input: join(projectRoot, "desktop.html"),
          checks: {
            pluginTimings: false,
            ineffectiveDynamicImport: false,
          },
        },
      },
    };
  }

  return {
  clearScreen: false,
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    watch: {
      // Windows locks .pdb files in src-tauri/target while cargo compiles.
      // Watching them throws EBUSY and kills `tauri dev` (beforeDevCommand).
      ignored: [
        "**/src-tauri/**",
        "**/*.pdb",
        "**/target/**",
      ],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    pgliteBootstrapPlugin(),
    windowsWatchGuardPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    inlineExportAllPlugin(),
    tanstackStart({
      prerender: {
        enabled: false,
      },
    }),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: "vercel",
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
  build: {
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      checks: {
        pluginTimings: false,
        ineffectiveDynamicImport: false,
      },
    },
  },
  };
});
