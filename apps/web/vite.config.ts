import { foldkit } from "@foldkit/vite-plugin";
import stylex from "@stylexjs/unplugin/vite";
import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isWorkspacePath } from "@orumai/core";
import { defineConfig } from "vite";
import { stylexOptions } from "../../scripts/stylex-options.ts";

const pdfPackage = JSON.parse(
  readFileSync(new URL(import.meta.resolve("pdfjs-dist/package.json")), "utf8"),
) as { version: string };
const pdfWorker = fileURLToPath(
  import.meta.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
);

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  appType: "mpa",
  // Development serves source files, independently of production's dist/.
  plugins: [
    foldkit({ devToolsMcpPort: false }),
    // Recovery pages allow same-origin stylesheets through their CSP.
    stylex({ ...stylexOptions, dev: true, devMode: "css-only" }),
    {
      name: "orumai-dev-assets",
      apply: "serve",
      transformIndexHtml: () => [
        {
          tag: "link",
          attrs: { rel: "stylesheet", href: "/virtual:stylex.css" },
          injectTo: "head",
        },
        {
          tag: "script",
          attrs: { type: "module", src: "/@id/virtual:stylex:css-only" },
          injectTo: "head",
        },
      ],
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = request.url?.split("?")[0];
          if (
            pathname &&
            isWorkspacePath(pathname) &&
            (request.method === "GET" || request.method === "HEAD")
          ) {
            request.url = "/index.html";
            return next();
          }
          if (pathname === "/mcp-consent.css") {
            // Let Vite resolve the shared theme import before serving CSS.
            request.url = "/src/mcp-consent.css?direct";
            return next();
          }
          if (pathname !== `/pdf.worker-${pdfPackage.version}.mjs`)
            return next();
          response.setHeader("Content-Type", "text/javascript");
          response.setHeader("Cache-Control", "no-cache");
          createReadStream(pdfWorker).on("error", next).pipe(response);
        });
      },
    },
  ],
});
