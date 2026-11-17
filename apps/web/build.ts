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
});
await Bun.write(
  new URL("mcp-consent.css", output),
  Bun.file(new URL("./src/mcp-consent.css", import.meta.url)),
);
