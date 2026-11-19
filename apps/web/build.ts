import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("./dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await Bun.build({
  entrypoints: [fileURLToPath(new URL("./src/index.html", import.meta.url))],
  outdir: fileURLToPath(output),
  target: "browser",
  publicPath: "/",
  minify: true,
  splitting: true,
});
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
