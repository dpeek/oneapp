import { fileURLToPath } from "node:url";

const source = new URL("./src/", import.meta.url);
const output = new URL("./dist/", import.meta.url);

await Bun.build({
  entrypoints: [fileURLToPath(new URL("popup.html", source))],
  outdir: fileURLToPath(output),
  target: "browser",
  minify: true,
  throw: true,
});

await Bun.write(
  new URL("manifest.json", output),
  Bun.file(new URL("manifest.json", source)),
);
