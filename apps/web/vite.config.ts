import { foldkit } from "@foldkit/vite-plugin";
import stylex from "@stylexjs/unplugin/vite";
import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  // Development serves source files, independently of production's dist/.
  plugins: [
    foldkit({ devToolsMcpPort: false }),
    // Recovery pages allow same-origin stylesheets through their CSP.
    stylex({ ...stylexOptions, dev: true, devMode: "css-only" }),
    {
      name: "oneapp-dev-assets",
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
          const asset =
            pathname === `/pdf.worker-${pdfPackage.version}.mjs`
              ? { path: pdfWorker, type: "text/javascript" }
              : pathname === "/mcp-consent.css"
                ? {
                    path: fileURLToPath(
                      new URL("./src/mcp-consent.css", import.meta.url),
                    ),
                    type: "text/css",
                  }
                : undefined;
          if (!asset) return next();
          response.setHeader("Content-Type", asset.type);
          response.setHeader("Cache-Control", "no-cache");
          createReadStream(asset.path).on("error", next).pipe(response);
        });
      },
    },
  ],
});
