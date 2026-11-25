import { createStylexBunPlugin } from "@stylexjs/unplugin/bun";
import { cp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stylexOptions } from "../../scripts/stylex-options.ts";

const output = new URL("./dist/", import.meta.url);
const stylexCss = new URL("stylex.css", output);
await rm(output, { recursive: true, force: true });
await cp(new URL("./public/", import.meta.url), output, { recursive: true });
await Bun.build({
  entrypoints: [fileURLToPath(new URL("./index.html", import.meta.url))],
  outdir: fileURLToPath(output),
  target: "browser",
  publicPath: "/",
  // Bun resolves root-relative HTML links against the working directory.
  // Keep these links pointed at the files copied from public/ above.
  external: [resolve("manifest.webmanifest"), resolve("app-icon-192.png")],
  minify: true,
  splitting: true,
  plugins: [
    createStylexBunPlugin({
      ...stylexOptions,
      dev: false,
      bunDevCssOutput: fileURLToPath(stylexCss),
    }),
  ],
});
// The compiler writes a separate stylesheet. Give it a content-addressed URL.
const css = await Bun.file(stylexCss).text();
const stylexFileName = `stylex-${Bun.hash(css).toString(36)}.css`;
await rename(stylexCss, new URL(stylexFileName, output));
const html = new URL("index.html", output);
const document = await Bun.file(html).text();
await Bun.write(
  html,
  document.replace(
    "</head>",
    `<link rel="stylesheet" href="/${stylexFileName}"></head>`,
  ),
);
await Bun.write(
  new URL("mcp-consent.css", output),
  Bun.file(new URL("./src/mcp-consent.css", import.meta.url)),
);

const pdfPackage = await Bun.file(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
).json();
await Bun.write(
  new URL(`pdf.worker-${pdfPackage.version}.mjs`, output),
  Bun.file(
    fileURLToPath(import.meta.resolve("pdfjs-dist/build/pdf.worker.min.mjs")),
  ),
);
await Bun.write(
  new URL("pdfjs-LICENSE.txt", output),
  Bun.file(fileURLToPath(import.meta.resolve("pdfjs-dist/LICENSE"))),
);
